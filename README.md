# Phaser Waiting Game

A browser-based waiting-tables simulation built with [Phaser 3](https://phaser.io),
using the [Modern Interiors](https://limezu.itch.io/moderninteriors) pixel-art pack
by limezu. It's a PWA — installable, works offline, no backend.

Seat guests, take orders, pick up food from the kitchen, deliver before patience
runs out. Design your own floor plans and guest rosters in the in-app editors.

## Run it

The project ships as plain HTML + ES modules — no build step. Serve the folder
over HTTP (ESM imports won't load from `file://`):

```bash
python -m http.server 8080
# then open http://127.0.0.1:8080
```

Or any static server will do (`npx serve`, `php -S`, etc.).

### Controls

- **WASD / Arrow keys** — move the waiter
- **E** — interact (take order / pick up / deliver)
- **ESC** — back to menu

## What's in the box

- **Game scene** — BFS-pathfinding guests, patience timers, order bubbles,
  scoring. Plays on the default floor plan with the default roster out of the box.
- **Floor Plan Editor** — paint tiles, place tables and a spawn point, resize the
  grid, toggle layers. Browse all 31 indexed sprite sheets; non-preloaded sheets
  load on demand. On narrow/mobile screens the toolbar's tool and layer/size/
  station rows become horizontally scrollable strips instead of shrinking
  illegibly, and a Palette/Grid tab gives the tile grid the full screen width.
  The grid itself renders on its own camera, so it's zoomable and pannable on
  every screen size — mouse wheel or the +/−/Fit buttons to zoom, right-click-drag
  or two-finger touch drag to pan, pinch to zoom on touch — independent of the
  toolbar and palette around it.
- **Guests & Staff Editor** — a Guests tab and a Staff tab share one
  appearance picker: 20 named preset characters, or a custom look on the
  **Custom** tab (body/eyes/outfit/hairstyle/accessory, layered from the
  pack's character generator sheets, plus a Kid toggle and a Randomize
  button). Guests also get patience, drink/food order, and allergies; Staff
  covers the host, bartender, five cooks, and two food runners — their
  appearance and name badge are editable, though the roster itself is fixed
  (each role is tied to a spot on the floor plan). Both tabs scroll and the
  whole editor reflows into a single stacked column on narrow/mobile screens.
- **Menu Editor** — create/edit menu items: name, drink or food, a sprite
  picked from any sprite sheet, an optional tint, a kitchen station (food),
  and allergens. The Guests & Staff Editor's order dropdowns pull from this
  list.
- **Import / Export** — share floor plans, guest rosters, staff rosters, and
  menus as JSON, from Export/Import buttons inside each editor. No backend,
  no account, no localStorage dependency for sharing. The default menu
  itself ships as `game-assets/default-menu.json`.

## Assets

The game art is **Modern Interiors by limezu**
(https://limezu.itch.io/moderninteriors). That pack is **not** included in this
repository — please download it from the link above and unpack the
`moderninteriors-win/` folder under `assets/` if you want to regenerate the
curated subset or the asset index. The curated 48×48 tiles, character sheets,
and UI sprites actually used by the game live in `game-assets/` and are
committed here for convenience; they remain under limezu's license terms — see
the pack's page for usage details.

### Asset index

The sprite sheets ship with no frame metadata, so `kitchen:44` is otherwise a
magic number. `tools/index_assets.py` derives that metadata (frame occupancy,
connected-component objects with footprints and dominant colors) and writes it
to `game-assets/asset-index.json` plus per-sheet detail files. The editor and
game fetch these on demand. Regenerate after adding sheets:

```bash
python tools/index_assets.py     # needs Pillow; ~90s for 31 sheets
```

Hand-written frame/object names go in `game-assets/asset-labels.json`; the
script merges them in and never clobbers them. See `docs/ASSETS.md` for the
generated overview.

## Project layout

```
index.html              PWA shell
manifest.json           PWA manifest
sw.js                   Service worker (cache-first)
src/
  main.js               Phaser config + scene registration + SW registration
  scenes/               Boot, Menu, FloorPlanEditor, GuestEditor (Guests & Staff), MenuEditor, Game
  data/                 catalog, defaults, assetIndex loader, characterGenerator, menu
  core/                 Storage, Palette, AppearanceCompositor
tools/
  index_assets.py       Asset index + docs generator
docs/
  ASSETS.md             Generated overview of every sheet
  assets/<key>.md       Generated per-sheet listings
game-assets/
  tiles/                Core sheets + themes/ (on-demand)
  characters/single/    20 named characters + waiter
  characters/generator/ Layered body/eyes/outfit/hairstyle/accessory sheets (+ kids)
  default-menu.json     Default menu items (editable, importable)
  asset-index.json      Generated summary (~12 KB, always loaded)
  asset-index/<key>.json  Generated per-sheet detail, fetched on demand
  asset-labels.json     Hand-written names (merged in; never overwritten)
```

## Tech

- **Phaser 3.90.0** via ESM CDN import — no build step, no bundler.
- **PWA** — `manifest.json` + `sw.js`, cache-first for assets, installable.
- **No backend** — all state is in localStorage or exported JSON.

## License

Code is released under the **MIT License** — see [LICENSE](LICENSE).

The art assets in `game-assets/` are from **Modern Interiors by limezu** and are
**not** covered by the MIT license above; they remain under their own terms.
Download the pack from https://limezu.itch.io/moderninteriors for full usage
rights.
