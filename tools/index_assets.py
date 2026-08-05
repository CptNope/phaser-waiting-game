#!/usr/bin/env python3
"""Generate a machine-readable index of the Modern Interiors spritesheets.

Why this exists: the sprite sheets ship with no metadata, so frame numbers like
`kitchen:44` are opaque magic numbers. Anything (or anyone) that cannot look at
the PNG has no way to know what a frame contains, whether it is empty, or that a
fridge actually spans six tiles. This script derives that information and writes
it to `game-assets/asset-index.json` plus human-readable Markdown in `docs/`.

Outputs:
  game-assets/asset-index.json        small summary: one row per sheet
  game-assets/asset-index/<key>.json  per-sheet detail, fetched on demand
  docs/ASSETS.md                      overview table
  docs/assets/<key>.md                per-sheet object listings

The index is split because the full detail is several megabytes; the app only
pulls a sheet's detail when that sheet is selected.

Semantic names live in `game-assets/asset-labels.json`, which is merged in and
never overwritten, so labels survive re-runs. Run from the repo root:

    python tools/index_assets.py
"""

from __future__ import annotations

import json
import shutil
from collections import Counter
from pathlib import Path

from PIL import Image

TILE = 48
ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "assets" / "moderninteriors-win"
THEMES_SRC = PACK / "1_Interiors" / "48x48" / "Theme_Sorter_48x48"
RB_SRC = PACK / "1_Interiors" / "48x48" / "Room_Builder_subfiles_48x48"
SERVED_TILES = ROOT / "game-assets" / "tiles"
SERVED_THEMES = SERVED_TILES / "themes"

INDEX_OUT = ROOT / "game-assets" / "asset-index.json"
DETAIL_DIR = ROOT / "game-assets" / "asset-index"
LABELS_FILE = ROOT / "game-assets" / "asset-labels.json"
DOCS_OUT = ROOT / "docs" / "ASSETS.md"
DOCS_DIR = ROOT / "docs" / "assets"

# Sheets already wired into the app. These keys appear in saved floor plans, so
# their key and served path must not change.
LEGACY = {
    "generic": ("1_Generic_48x48.png", "objects"),
    "kitchen": ("12_Kitchen_48x48.png", "objects"),
    "room": ("Room_Builder_48x48.png", "tileset"),
    "room_floors": ("Room_Builder_Floors_48x48.png", "tileset"),
    "room_walls": ("Room_Builder_Walls_48x48.png", "tileset"),
    "room_3d": ("Room_Builder_3d_walls_48x48.png", "tileset"),
    "room_borders": ("Room_Builder_borders_48x48.png", "tileset"),
    "ui": ("UI_48x48.png", "objects"),
}

ALPHA_MIN = 200  # treat anything below this as transparent


def slug(name: str) -> str:
    """`13_Conference_Hall_48x48.png` -> `conference_hall`."""
    stem = name.replace("_48x48.png", "").replace(".png", "")
    parts = stem.split("_", 1)
    if parts[0].isdigit():
        stem = parts[1] if len(parts) > 1 else parts[0]
    return "".join(c if c.isalnum() else "_" for c in stem.lower()).strip("_")


def theme_order(name: str) -> int:
    head = name.split("_", 1)[0]
    return int(head) if head.isdigit() else 999


# ---------------------------------------------------------------------------
# Connected components via run-length union-find.
#
# Pixel-by-pixel flood fill over ~40M pixels is painfully slow in pure Python.
# Instead we collect horizontal runs of opaque pixels (a few thousand per sheet)
# and union runs that touch vertically, including diagonally. Cost scales with
# run count rather than pixel count.
# ---------------------------------------------------------------------------

def find_components(alpha: bytes, w: int, h: int):
    runs_by_row = []
    for y in range(h):
        base = y * w
        runs, start = [], -1
        for x in range(w):
            if alpha[base + x] >= ALPHA_MIN:
                if start < 0:
                    start = x
            elif start >= 0:
                runs.append((start, x - 1))
                start = -1
        if start >= 0:
            runs.append((start, w - 1))
        runs_by_row.append(runs)

    parent: list[int] = []

    def make() -> int:
        parent.append(len(parent))
        return len(parent) - 1

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    ids_by_row: list[list[int]] = []
    prev_runs: list[tuple[int, int]] = []
    prev_ids: list[int] = []
    for y in range(h):
        runs = runs_by_row[y]
        ids = [make() for _ in runs]
        # 8-connectivity: expand this run by one pixel each side when testing.
        for i, (s, e) in enumerate(runs):
            for j, (ps, pe) in enumerate(prev_runs):
                if ps <= e + 1 and pe >= s - 1:
                    union(ids[i], prev_ids[j])
        ids_by_row.append(ids)
        prev_runs, prev_ids = runs, ids

    comps: dict[int, dict] = {}
    for y in range(h):
        for (s, e), rid in zip(runs_by_row[y], ids_by_row[y]):
            root = find(rid)
            c = comps.get(root)
            if c is None:
                comps[root] = {"x0": s, "x1": e, "y0": y, "y1": y, "px": e - s + 1}
            else:
                c["x0"] = min(c["x0"], s)
                c["x1"] = max(c["x1"], e)
                c["y1"] = y
                c["px"] += e - s + 1
    return list(comps.values()), runs_by_row, ids_by_row, find


def dominant_colors(im: Image.Image, box, limit: int = 3):
    """Top quantized colors inside a box, as hex. Gives a blind reader a hint."""
    x0, y0, x1, y1 = box
    crop = im.crop((x0, y0, x1 + 1, y1 + 1))
    counter: Counter = Counter()
    for r, g, b, a in crop.getdata():
        if a >= ALPHA_MIN:
            counter[(r >> 4, g >> 4, b >> 4)] += 1
    out = []
    for (r, g, b), _ in counter.most_common(limit):
        out.append("#%02x%02x%02x" % (r * 17, g * 17, b * 17))
    return out


def describe_footprint(tw: int, th: int) -> str:
    if tw == 1 and th == 1:
        return "small prop"
    if tw >= 3 and th >= 3:
        return "large furniture"
    if th >= 3 and tw <= 2:
        return "tall furniture"
    if tw >= 3 and th <= 2:
        return "wide furniture"
    if tw >= 2 and th >= 2:
        return "medium furniture"
    if th >= 2:
        return "tall prop"
    return "wide prop"


def index_sheet(key: str, path: Path, served: str, kind: str, theme: str | None):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    cols, rows = w // TILE, h // TILE
    alpha = im.getchannel("A").tobytes()

    # Per-frame occupancy. Cheap and immediately useful: it tells a caller which
    # frame indices are blank so they stop picking empty tiles.
    frames: dict[str, dict] = {}
    non_empty: list[int] = []
    for row in range(rows):
        for col in range(cols):
            filled = 0
            for y in range(row * TILE, row * TILE + TILE):
                base = y * w + col * TILE
                for x in range(TILE):
                    if alpha[base + x] >= ALPHA_MIN:
                        filled += 1
            if filled:
                idx = row * cols + col
                non_empty.append(idx)
                frames[str(idx)] = {
                    "col": col,
                    "row": row,
                    "fill": round(filled / (TILE * TILE), 3),
                }

    sheet = {
        "key": key,
        "path": served,
        "kind": kind,
        "width": w,
        "height": h,
        "tile": TILE,
        "cols": cols,
        "rows": rows,
        "frameCount": cols * rows,
        "nonEmptyCount": len(non_empty),
        "frames": frames,
    }
    if theme:
        sheet["theme"] = theme

    # Wall/floor tilesets are contiguous sheets; component detection would just
    # return one giant blob, so it is only meaningful for object sheets.
    if kind != "objects":
        sheet["objects"] = []
        sheet["objectCount"] = 0
        return sheet, im

    comps, runs_by_row, ids_by_row, find = find_components(alpha, w, h)

    # Map each component root to the tile cells it actually touches.
    cells_by_root: dict[int, set[int]] = {}
    for y in range(h):
        trow = y // TILE
        for (s, e), rid in zip(runs_by_row[y], ids_by_row[y]):
            root = find(rid)
            bucket = cells_by_root.setdefault(root, set())
            for col in range(s // TILE, e // TILE + 1):
                bucket.add(trow * cols + col)

    roots = {}
    for y in range(h):
        for (s, e), rid in zip(runs_by_row[y], ids_by_row[y]):
            roots.setdefault(find(rid), None)

    objects = []
    comp_list = []
    for root in roots:
        cells = sorted(cells_by_root.get(root, ()))
        if not cells:
            continue
        comp_list.append((root, cells))

    # Recover bboxes keyed by root so ordering is stable (top-left first).
    bbox_by_root: dict[int, dict] = {}
    for y in range(h):
        for (s, e), rid in zip(runs_by_row[y], ids_by_row[y]):
            root = find(rid)
            b = bbox_by_root.get(root)
            if b is None:
                bbox_by_root[root] = {"x0": s, "x1": e, "y0": y, "y1": y, "px": e - s + 1}
            else:
                b["x0"] = min(b["x0"], s)
                b["x1"] = max(b["x1"], e)
                b["y1"] = y
                b["px"] += e - s + 1

    comp_list.sort(key=lambda rc: (bbox_by_root[rc[0]]["y0"], bbox_by_root[rc[0]]["x0"]))

    for n, (root, cells) in enumerate(comp_list, start=1):
        b = bbox_by_root[root]
        # Ignore stray specks (anti-aliasing crumbs, stray single pixels).
        if b["px"] < 24:
            continue
        pw, ph = b["x1"] - b["x0"] + 1, b["y1"] - b["y0"] + 1
        tw = b["x1"] // TILE - b["x0"] // TILE + 1
        th = b["y1"] // TILE - b["y0"] // TILE + 1
        objects.append({
            "id": f"{key}/obj_{n:03d}",
            "originFrame": cells[0],
            "frames": cells,
            "tiles": {"w": tw, "h": th},
            "px": {"x": b["x0"], "y": b["y0"], "w": pw, "h": ph},
            "fill": round(b["px"] / (pw * ph), 3),
            "colors": dominant_colors(im, (b["x0"], b["y0"], b["x1"], b["y1"])),
            "footprint": describe_footprint(tw, th),
            # Heuristic only: anything taller than one tile is probably furniture
            # you should not walk through. Override in asset-labels.json.
            "solidGuess": th > 1 or tw > 1,
        })

    sheet["objects"] = objects
    sheet["objectCount"] = len(objects)
    return sheet, im


def collect_sources():
    """Returns [(key, source_path, served_rel_path, kind, theme)]."""
    out = []
    for key, (fname, kind) in LEGACY.items():
        p = SERVED_TILES / fname
        if p.exists():
            theme = fname.replace("_48x48.png", "").split("_", 1)
            label = theme[1] if theme[0].isdigit() and len(theme) > 1 else None
            out.append((key, p, f"game-assets/tiles/{fname}", kind, label))

    legacy_files = {f for f, _ in LEGACY.values()}
    for src in sorted(THEMES_SRC.glob("*_48x48.png"), key=lambda p: theme_order(p.name)):
        if src.name in legacy_files:
            continue  # already served at its original path
        # The pack keeps lighting variants next to the originals (one is even
        # misspelled "Tevelision"). We only want the default shadowed art.
        if "Shadowless" in src.name or "Black_Shadow" in src.name:
            continue
        key = slug(src.name)
        dest = SERVED_THEMES / src.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dest)
        label = src.name.replace("_48x48.png", "").split("_", 1)
        out.append((
            key, dest, f"game-assets/tiles/themes/{src.name}", "objects",
            label[1] if label[0].isdigit() and len(label) > 1 else None,
        ))
    return out


def write_docs(index: dict) -> None:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    sheets = index["sheets"]

    lines = [
        "# Asset index",
        "",
        "Generated by `tools/index_assets.py` — do not edit by hand.",
        "Re-run after adding sheets: `python tools/index_assets.py`",
        "",
        "This exists so the sheets can be used without looking at the images.",
        "Frame indices are `row * cols + col` on a 48px grid.",
        "",
        "- `kind: objects` — discrete props; `objects[]` lists detected multi-tile items.",
        "- `kind: tileset` — contiguous floors/walls; only per-frame occupancy is useful.",
        "- `solidGuess` is a heuristic (anything larger than 1x1). Override in",
        "  `game-assets/asset-labels.json`, which is merged on re-run and never clobbered.",
        "",
        "## Known limitation",
        "",
        "Objects are found by connected-component analysis, so props whose pixels touch",
        "are reported as one object. Kitchen counters, for example, are drawn as",
        "continuous strips and come out as a single 16x3 item. Compare `objectCount`",
        "against the pack's `Theme_Sorter_Singles_48x48/` folders to gauge the gap",
        "(kitchen: 235 detected vs 408 singles). Footprints of 1x1-3x3 are reliable;",
        "treat anything wider than ~4 tiles as possibly several merged props.",
        "",
        "| sheet key | theme | kind | grid | frames | non-empty | objects | detail |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for s in sheets:
        detail = f"[{s['key']}](assets/{s['key']}.md)" if s["kind"] == "objects" else "—"
        lines.append(
            f"| `{s['key']}` | {s.get('theme') or '—'} | {s['kind']} | "
            f"{s['cols']}x{s['rows']} | {s['frameCount']} | {s['nonEmptyCount']} | "
            f"{len(s.get('objects', []))} | {detail} |"
        )
    totals = sum(len(s.get("objects", [])) for s in sheets)
    lines += ["", f"**Totals:** {len(sheets)} sheets, {totals} detected objects.", ""]
    DOCS_OUT.parent.mkdir(parents=True, exist_ok=True)
    DOCS_OUT.write_text("\n".join(lines), encoding="utf-8")

    for s in sheets:
        named = s.get("namedFrames") or []
        if s["kind"] != "objects" and not named:
            continue
        d = [
            f"# {s['key']}",
            "",
            f"Theme: **{s.get('theme') or 'n/a'}**  ",
            f"Sheet: `{s['path']}`  ",
            f"Grid: {s['cols']}x{s['rows']} tiles of {s['tile']}px "
            f"({s['frameCount']} frames, {s['nonEmptyCount']} non-empty)",
            "",
        ]
        if named:
            d += ["## Named frames", ""]
            d.append("Hand-labeled in `game-assets/asset-labels.json`.")
            if s["kind"] == "objects":
                d.append("These names are authoritative — prefer them over the")
                d.append("detected objects below, which can merge touching props.")
            d += [
                "",
                "| frame | name | tags | fill |",
                "| --- | --- | --- | --- |",
            ]
            for f in named:
                info = s["frames"][str(f)]
                tags = ", ".join(info.get("tags", [])) or "—"
                d.append(f"| `{s['key']}#{f}` | {info['name']} | {tags} | {info['fill']} |")
            d.append("")
        if s["kind"] != "objects":
            (DOCS_DIR / f"{s['key']}.md").write_text("\n".join(d) + "\n", encoding="utf-8")
            continue
        d += [
            "## Detected objects",
            "",
            "Frame index = `row * cols + col`. `frames` lists every tile the object",
            "covers, so you can stamp it as a unit.",
            "",
            "| id | name | tiles | footprint | origin frame | frames | fill | colors | solid? |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for o in s["objects"]:
            frames = ",".join(str(f) for f in o["frames"])
            if len(frames) > 48:
                frames = frames[:45] + "…"
            d.append(
                f"| `{o['id']}` | {o.get('name') or '—'} | {o['tiles']['w']}x{o['tiles']['h']} | "
                f"{o['footprint']} | {o['originFrame']} | {frames} | {o['fill']} | "
                f"{' '.join(o['colors'])} | {'yes' if o.get('solid', o['solidGuess']) else 'no'} |"
            )
        (DOCS_DIR / f"{s['key']}.md").write_text("\n".join(d) + "\n", encoding="utf-8")


def prune(sources, sheets) -> None:
    """Delete generated files for sheets that no longer exist.

    Keeps re-runs idempotent, e.g. after excluding the pack's shadow variants.
    Only ever touches directories this script owns.
    """
    keys = {s["key"] for s in sheets}
    keep_pngs = {Path(served).name for _, _, served, _, _ in sources}
    for p in DETAIL_DIR.glob("*.json"):
        if p.stem not in keys:
            p.unlink()
            print(f"  pruned {p.relative_to(ROOT)}")
    for p in DOCS_DIR.glob("*.md"):
        if p.stem not in keys:
            p.unlink()
            print(f"  pruned {p.relative_to(ROOT)}")
    if SERVED_THEMES.exists():
        for p in SERVED_THEMES.glob("*.png"):
            if p.name not in keep_pngs:
                p.unlink()
                print(f"  pruned {p.relative_to(ROOT)}")


def main() -> None:
    labels = {}
    if LABELS_FILE.exists():
        labels = json.loads(LABELS_FILE.read_text(encoding="utf-8"))

    sources = collect_sources()
    sheets = []
    for key, src, served, kind, theme in sources:
        sheet, _ = index_sheet(key, src, served, kind, theme)

        # Object-level labels, keyed "<sheet>/obj_NNN".
        for o in sheet.get("objects", []):
            lab = labels.get(o["id"])
            if lab:
                o.update({k: v for k, v in lab.items() if v is not None})

        # Frame-level labels, keyed "<sheet>#<frame>". Needed because touching
        # props merge into one component: every kitchen counter, dining table
        # and sink shares a single 16x3 object, so only per-frame names can
        # tell them apart.
        prefix = f"{key}#"
        for lkey, lab in labels.items():
            if not lkey.startswith(prefix):
                continue
            fidx = lkey[len(prefix):]
            if not fidx.isdigit():
                continue
            entry = sheet["frames"].get(fidx)
            if entry is None:
                print(f"  ! label {lkey} points at an empty/out-of-range frame")
                continue
            entry.update({k: v for k, v in lab.items() if v is not None})

        sheet["namedFrames"] = sorted(
            (int(f) for f, v in sheet["frames"].items() if v.get("name")),
        )
        sheets.append(sheet)
        print(f"  {key:24s} {sheet['cols']:>3}x{sheet['rows']:<3} "
              f"non-empty={sheet['nonEmptyCount']:>4} objects={len(sheet.get('objects', []))}")

    # Split: a small summary the app always loads, plus per-sheet detail files
    # (frame occupancy + object lists) fetched only when a sheet is selected.
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    summary_sheets = []
    for s in sheets:
        detail_rel = f"game-assets/asset-index/{s['key']}.json"
        (DETAIL_DIR / f"{s['key']}.json").write_text(
            json.dumps({
                "key": s["key"],
                "cols": s["cols"],
                "rows": s["rows"],
                "frames": s["frames"],
                "objects": s.get("objects", []),
            }, indent=1),
            encoding="utf-8",
        )
        summary_sheets.append({
            k: v for k, v in s.items() if k not in ("frames", "objects")
        } | {"detail": detail_rel})

    index = {
        "generatedBy": "tools/index_assets.py",
        "tile": TILE,
        "note": "Frame index = row * cols + col. See docs/ASSETS.md.",
        "labelsFile": "game-assets/asset-labels.json",
        "sheets": summary_sheets,
    }
    INDEX_OUT.write_text(json.dumps(index, indent=1, sort_keys=False), encoding="utf-8")

    # Seed an empty labels file so it is obvious where names belong.
    if not LABELS_FILE.exists():
        LABELS_FILE.write_text(json.dumps({
            "_readme": "Map object id -> {name, tags, solid}. Merged into "
                       "asset-index.json on re-run; safe to edit by hand.",
            "_example": {"name": "Fridge", "tags": ["appliance"], "solid": True},
        }, indent=1), encoding="utf-8")

    write_docs({"sheets": sheets})
    prune(sources, sheets)

    kb = INDEX_OUT.stat().st_size / 1024
    detail_kb = sum(p.stat().st_size for p in DETAIL_DIR.glob("*.json")) / 1024
    print(f"\nwrote {INDEX_OUT.relative_to(ROOT)} ({kb:.0f} KB summary)")
    print(f"wrote {len(sheets)} detail files in game-assets/asset-index/ ({detail_kb:.0f} KB total)")
    print(f"wrote {DOCS_OUT.relative_to(ROOT)} and docs/assets/*.md")


if __name__ == "__main__":
    main()
