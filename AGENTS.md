# Waiting Game

A Phaser 3 PWA waiting-tables sim using the Modern Interiors asset pack by limezu.

## Running

Serve the folder over HTTP (ESM imports require it, not `file://`):

```
python -m http.server 8080
```

Then open `http://127.0.0.1:8080`.

## Tech Stack

- **Phaser 3.90.0** via ESM CDN import (`import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js'`)
  - The ESM build has NO default export — always use `import * as Phaser`.
- **No build step** — plain HTML + ES modules served statically.
- **PWA** — `manifest.json` + `sw.js` for offline caching.

## Project Structure

```
index.html              PWA shell
manifest.json           PWA manifest
sw.js                   Service worker (cache-first for assets)
src/
  main.js               Phaser game config + scene registration + SW registration
  scenes/
    Boot.js             Asset loading with progress bar, creates __pixel texture
    Menu.js             Main menu: Play / Floor Plan Editor / Guest Editor / Import-Export
    FloorPlanEditor.js  Tile-based floor plan editor with visual palette
    GuestEditor.js      Guest roster editor with character frame picker + DOM form inputs
    Game.js             Core gameplay: seat guests, take orders, deliver food, score
  data/
    catalog.js          Spritesheet definitions, tile size, menu items
    defaults.js         Default floor plan + guest roster (playable without editing)
    assetIndex.js       Loads the generated asset index; on-demand sheet/detail fetch
  core/
    Storage.js          localStorage + JSON export/import helpers
    Palette.js          Frame picker; `only` option renders just non-empty frames
    MobileControls.js   Touch D-pad + action + menu buttons; auto-shows on touch/narrow screens
tools/
  index_assets.py       Generates the asset index + docs (run from repo root)
docs/
  ASSETS.md             Generated overview of every sheet
  assets/<key>.md       Generated per-sheet frame/object listings
game-assets/
  tiles/                1_Generic, 12_Kitchen, Room_Builder + subfiles (48x48)
  tiles/themes/         Other 24 themed sheets, fetched on demand
  asset-index.json      Generated summary (~12 KB, always loaded)
  asset-index/<key>.json  Generated per-sheet detail, fetched on demand
  asset-labels.json     Hand-written names (merged in; never overwritten)
  characters/           20 premade character sheets (48x48)
  ui/                   UI spritesheet + generated PWA icon
```

## Asset Index (read this before picking frame numbers)

The sprite sheets ship with **no metadata**, so `kitchen:44` is a magic number.
`tools/index_assets.py` derives that information so sheets can be used without
looking at the images. Regenerate after adding sheets:

```bash
python tools/index_assets.py     # needs Pillow; ~90s for 31 sheets
```

It records, per sheet: grid size, which frames are non-empty (with fill ratio),
and connected-component **objects** with tile footprint, pixel bbox, dominant
colors and a `solidGuess`. Start from `docs/ASSETS.md`.

**Naming.** Put names in `game-assets/asset-labels.json`; the script merges them
and never clobbers them. Two key forms:

- `"<sheet>#<frame>"` — labels one frame, e.g. `"kitchen#44"`
- `"<sheet>/obj_NNN"` — labels a detected object

Prefer frame keys. Objects are found by connected components, so **props whose
pixels touch merge into one item** — every kitchen counter, dining table and sink
shares a single 16x3 object, so only per-frame names distinguish them. Footprints
of 1x1–3x3 are reliable; treat anything wider than ~4 tiles as possibly merged.
The script warns if a label points at an empty or out-of-range frame.

**Loading.** Only the 12 KB summary loads up front. Per-sheet detail and the
themed PNGs are fetched on demand (`src/data/assetIndex.js`), and the service
worker's runtime cache picks them up. `Game.ensurePlanSheets()` pulls in any
sheet a saved floor plan references but Boot did not preload.

## Spritesheet Frame Selection

Default floor plan uses verified-opaque frames chosen via pixel analysis:
- **Floors**: `room_floors` f:30 (blue-gray kitchen), f:34 (warm beige dining)
- **Walls**: `room_walls` f:0 (gray top/side walls), `room_3d` f:8 (3D bottom wall)
- **Kitchen**: `kitchen` f:80 (fridge), f:82 (stove), f:32/48 (counters)
- **Tables**: `kitchen` f:44/46 (alternating tan/wood dining tables)
- **Decor**: `generic` f:78 (plants in dining corners)
- **Menu icons**: `kitchen` f:1 (burger), f:2 (salad), f:6 (coffee), f:7 (cake),
  f:400 (a green glass bottle, used for both beer and wine — the pack has no
  dedicated wine glass sprite, so wine reuses the bottle with a burgundy
  `setTint()` applied only to the order-bubble icon; see `MENU_TINTS` in
  catalog.js)

## Character Sprites

Uses **Single_Characters_Legacy** from the asset pack — labeled by name and pose
(e.g. `Adam_idle_48x48.png`, `Adam_sit_48x48.png`). Much better than guessing
frame indices from the big premade sheets.

- **20 named characters** with both `_idle` (standing/walking) and `_sit` (seated) poses:
  Adam, Alex, Amelia, Ash, Bob, Bruce, Conference_man, Conference_woman, Dan, Edward,
  Kid_Abby, kid_Karen, kid_Oscar, Lucy, Molly, Old_woman_Jenny, Pier, Rob, Roki, Samuel
- **Waiter**: Chef_Alex with `_idle` (standing) and `_run` (walking) sheets
- Copied to `game-assets/characters/single/` as `<Name>_idle.png` / `<Name>_sit.png`

### Sheet layouts (48×96 sprites — characters are 2 tiles tall)
Frames are 48 wide × 96 tall. **idle** and **run** sit on a plain 48px grid
(ink is inset ~3px), so `load.spritesheet` works for them.

- **idle**: 4 frames. Col 0=RIGHT, 1=UP, 2=LEFT, 3=DOWN. `IDLE_FRAME_DOWN = 3`
- **run**: 24 frames. Cols 0-5=RIGHT, 6-11=UP, 12-17=LEFT, 18-23=DOWN. `RUN_FRAMES` in catalog.js
- **Sprite origin**: `(0.5, 0.75)` — anchor is the tile center, so the 96px frame's
  bottom lands on the tile bottom and the head extends into the tile above
- **Depth**: Characters at depth 10, floor at 0, objects at 1
- **No flipX**: Run sheet has dedicated directional animations, so flipX is not used

#### sit sheets are NOT on a 48px grid (gotcha)
Each sit PNG is 1152×96 and holds only **12 sprites**, one 48×96 sprite centered in
a **96px-wide cell**. Slicing every 48px cuts each character in half (you get hair/back
and lose the face). Real boxes, verified identical across all 20 characters:

- Left-facing:  x = `18 + 96*i` for i=0..5
- Right-facing: x = `606 + 96*i` for i=0..5

So sit sheets are loaded with `load.image` and sliced manually in
`BootScene.registerSitFrames()` using `SIT_GEOM`, producing frames 0-5 (LEFT)
and 6-11 (RIGHT). `SIT_FRAMES = { left: 0, right: 6 }`. Only side views exist,
so a table directly above/below maps to a side pose.

### Game behavior
- Guests arrive in **parties** (`groupSize` on the first guest decides how many
  queued guests arrive together). A party always shares one table.
- Parties spawn at the door and queue in the **waiting area** — unless the
  party leader has `prefersBar: true`, in which case the whole party skips
  the queue and self-seats at the bar (see "Bartender NPC" below).
- The **host NPC** seats dine-in parties; the player never has to. Interacting
  with the host stand just reports status.
- Waiting guests show blue patience bars; seated guests show green→red
- HUD shows "Waiting N", "Bar wait N" and "Seating N" while parties are queued
- On serve/angry-leave, swap back to `_idle` and walk to door
- Waiter plays `waiter_<dir>` walk animation while moving, returns to idle pose when stopped

### Two-stage ordering: drink, then food

Dine-in guests order in two stages once seated, each taken/delivered the same
way (walk up, face them, press E):

`seated` → (order drink) → `ordered_drink` → (deliver drink) → `drink_served`
→ (order food) → `ordered_food` → (deliver food) → `served`, guest leaves.

`prefersBar` guests stop after the drink stage — delivering it ends their
visit (tip + leave) instead of advancing to `drink_served`. Patience is a
single continuous budget from `onGuestSeated` through the final delivery; it
is not reset between stages. `guestAdjacent()`/`interact()` in Game.js branch
on these states; `deliverToGuest()` (the tip/leave finale) is shared by both
the food-finale and bar-drink-finale paths since it never reads the order
directly, only the guest's name and patience ratio.

### Bartender NPC

The bartender is the **kitchen for drinks**: no state machine, no walking —
`spawnBartender()` places a static `Alex` sprite with a "BARTENDER" badge at
`plan.bar`, and (like the kitchen) taking a drink order instantly makes it
"ready" for pickup there. `this.preparedDrink`/`this.carrying` mirror
`this.preparedOrder`/`this.carrying` for the kitchen. The bar counter and any
bar-area dining tables are regular `tables` entries flagged `isBar: true`,
which auto-derive seats the same way every other table does.

`findFreeTableForGroup()` (host's regular seating pool) excludes `isBar`
tables; `findFreeBarTableForGroup()` is the mirror image, used only by
`prefersBar` parties. Bar parties that arrive when the bar is full queue in
`barWaitingGroups` (mirroring `waitingGroups`/`reflowWaitingQueue`, but
simpler — no bench/queue-line logic, just a handful of holding tiles near
`plan.bar` from `barWaitingSpots()`) and are retried each tick by
`updateBarWaiting()`.

### Host NPC

`spawnHost()` places a staff character (`HOST_CHARACTER`, default
`Conference_woman`, with a "HOST" badge) on a walkable tile beside the host
stand. `updateHost()` runs a four-state machine each frame:

`idle` → `fetching` (walk to the head of the queue) → `escorting` (lead the
party to the table, guests peeling off to their seats 120 ms apart) →
`returning` (walk back to the post) → `idle`.

A new escort only starts from `idle`, so a party is never handed off mid-walk.
`releaseParty()` puts a party back at the front of the queue if an escort
cannot complete. Without a `host` marker the game falls back to legacy direct
seating.

### Waiting queue

`waitingSpots()` builds an ordered list of places to wait, cached for the shift:

1. **Queue line** — the longest open run out from the host stand. Runs through
   a chokepoint are rejected (`isChokepoint()` tests whether blocking a tile
   would cut the floor in two), so the line never forms across a doorway.
2. **Bench seats** — the walkable tile in front of each `benches` entry. Guests
   there use the `_sit` pose.

`reflowWaitingQueue()` re-walks everyone to their current position whenever a
party arrives or leaves, so the line closes up.

### Tables and seats

Tables are `{ x, y, w, h }` (w/h default to 1). Every footprint tile is solid;
seats are the walkable tiles orthogonally around it — so **1×1 ≈ 4 seats,
2×1 ≈ 6, 2×2 ≈ 8**. `findFreeTableForGroup()` prefers a still-empty table whose
capacity fits the party most snugly, so a couple does not take the eight-top
while a large party waits.

### Movement gotcha: walk tickets

Actors get re-targeted mid-walk all the time (the queue re-flows, the host
grabs a party). `walkActorTo()` therefore takes a **ticket**: each call bumps
`actor._walkTicket` and kills existing tweens. The previous tween chain checks
the ticket on its next hop and stops. Without this, two chains fight over the
same sprite and a guest can end up flagged `seated` while their sprite is
dragged back to the queue. `walkGuestTo()` is a thin wrapper over it.

## Key Design Decisions

- **48x48 tile size** throughout (assets have 16/32/48 variants; 48 chosen for visibility).
- **Visual palette** approach: users pick tiles/frames directly from spritesheets in the editors,
  no hand-mapped frame indices needed.
- **Export/Import JSON** for sharing floor plans and guest rosters (no backend, no localStorage dependency for sharing).
- **BFS pathfinding** for guest AI (walk from door to waiting area, then to seat).
- **Seat auto-derivation**: seats are the walkable tiles around a table's footprint; no manual seat placement needed.
- **Host stand flow**: parties queue in the waiting area and an autonomous host NPC walks them to a table.
- **Default map** is 36×20: waiting area (cols 0-6) with the door at (3,0), host
  stand at (6,7) and six benches; a divider wall at col 7 with the only passage
  at row 8; kitchen along row 1 (cols 9-15); and ten dining tables in mixed
  1×1 / 2×1 / 1×2 / 2×2 footprints. Rows 16-19 under that original 28-wide
  section are sealed dead space (the grid grew taller for the bar area, and
  that section didn't need to). To the right (cols 28-35), a second divider
  (passage at row 10) leads into the bar area: a 5-wide counter + a few
  `isBar` dining tables, with the bartender's station at (34,3).

## Floor Plan Editor

Toolbar row 1: sheet selector + paint tools. Row 2: layer toggles + grid size.
The toolbar sizes itself to the viewport and abbreviates tool labels when narrow.

- **Sheet ◀ ▶** — browses all 31 indexed sheets. Non-preloaded sheets load on
  demand; the label shows `n/31 key` and the palette footer shows theme + counts.
- **Palette** — renders only non-empty frames when the index is available. This
  matters: `room` is 8588 frames and Palette creates 2 objects per frame.
- **Status text** — describes the selected frame using the index, e.g.
  `frame 44 · Dining table (tan)`, falling back to `large furniture (16x4)`.
- **Layers** (Ground/Objects/Markers) — display-only visibility; plan data is
  never modified.
- **Size -/+ then Apply** — resizes the grid. Overlapping cells keep their
  content, growing pads with empties, shrinking crops. Markers are clamped into
  bounds and out-of-range tables are dropped. Apply turns amber when pending.
- **Auto-fit** — `fitGrid()` scales the grid container so any size stays visible;
  clicks stay accurate because cells are children of the scaled container.

### Tools

- **Ground / Object** — paint the selected palette tile on the ground or object layer.
- **Erase** — clear ground, object, solid, and table marker on a cell.
- **Solid** — toggle collision (red tint overlay).
- **Pick** (eyedropper) — click a cell to copy its tile into the palette selection.
  Switches to the source sheet automatically. Picks object layer first, then ground.
- **Copy** — drag to select a rectangular region. Copies ground + objects + solids
  to an internal clipboard. Release mouse to finalize.
- **Paste** — click to stamp the clipboard region with its top-left at the clicked
  cell. Clips at grid boundaries.
- **Spawn / Kitchen / Bar / Door / Host / Bench / Table** (markers) — place the marker AND
  auto-paint the selected object tile on that cell (sets solid=true). Removes marker on
  re-click. Each marker button has a small preview icon (bottom-right corner);
  right-click the preview to assign the current palette selection as that
  marker's dedicated tile. Per-marker tiles are stored in `plan.markerTiles`
  and saved with the plan.
  - **Host** = the podium the host NPC works from. Do not place it on a
    one-tile passage; it is solid and would wall the room off.
  - **Bar** = the bartender's station / drink pickup point — works exactly
    like Kitchen, but for drinks (`plan.bar`).
  - **Bench** = a waiting-area seat. Guests sit on the tile in front of it.
  - **Table** uses the **1x1 / 2x1 / 1x2 / 2x2** footprint picker on row 2,
    plus a **Bar Tbl** toggle that flags newly placed tables `isBar: true`
    (drawn from the bar's own seating pool instead of the host's). The status
    line reports the seat count. Clicking any tile of an existing table
    removes the whole thing; overlapping footprints are rejected.

The tool row is responsive: with 13 tools it shrinks the sheet selector, the
action buttons, the button width and finally the font so it never runs under
the Menu/Import/Export/Save buttons.

If the index fails to load, the editor falls back to the sheets Boot preloaded.

## Controls

- **WASD / Arrow keys** — move waiter
- **E** — interact (take order at guest, pick up at kitchen, deliver to guest;
  at the host stand it reports front-of-house status — the host seats parties itself)
- **Scroll wheel** — zoom in/out (desktop)
- **Pinch** — zoom in/out (mobile)
- **ESC** — return to menu (from any scene)

### On-Screen Controls (always visible in Game)

On-screen controls are always visible in the Game scene — they're the primary
input method on mobile and complement keyboard on desktop. They render on a
**separate fixed UI camera** (`this.uiCam`) that doesn't zoom or follow, so
they stay pinned to the screen regardless of the main camera's position or zoom.

- **Dynamic Virtual Joystick** (Left half of screen) — touch anywhere on the left
  half of the screen to spawn the joystick, then drag to move. Multi-touch aware.
- **Action / Interact** — tap anywhere on the right half of the screen, or perform
  a quick tap on the left side, to interact. A visual "E" button remains in the
  bottom-right as an affordance, but tapping anywhere works.
- **Zoom +/−** (right side, above action button) — tap to zoom in/out by 0.25x.
- **Menu button** (top-right, ≡) — tap to return to menu.
- **Clearish UI** — all visual buttons render at 40% opacity to minimize interference
  with gameplay visibility.
- **Safe-area insets** — controls read CSS `env(safe-area-inset-*)` and offset
  from edges accordingly, so they don't hide behind notches or gesture bars.

### Camera (two-camera system, player-focused zoom)

The Game scene uses two cameras. The camera is always focused on the player —
there is no fit-to-world mode. The user controls zoom level.

- **Main camera** (`this.cameras.main`) — follows the waiter at a user-controlled
  zoom level. Default zoom is 1.5x (1.25x on very small screens < 500px short
  side). Zoom range is 0.75x–3.0x, controllable via scroll wheel (0.15x steps),
  pinch-to-zoom, or UI +/− buttons (0.25x steps). `this._userZoom` stores the
  current level and is preserved across resizes. Renders all world objects
  (floor tiles, waiter, guests, patience bars, order bubbles).
- **UI camera** (`this.uiCam`) — fixed at zoom 1, scroll (0,0). Renders HUD and
  on-screen controls. Resizes to match the viewport on `fitCamera()`.

Objects are assigned to cameras via `cameraFilter` (set by `camera.ignore()`):
- `uiOnly(...objs)` — hides objects from the main camera (HUD, controls).
- `worldOnly(...objs)` — hides objects from the UI camera (floor, waiter, guests).
Call `worldOnly()` for every dynamically created world object (guest sprites,
patience bars, order bubble containers and their children).

`fitCamera()` recalculates on resize/orientation change but preserves the user's
zoom. The UI camera is removed in the scene's shutdown handler.

`src/core/MobileControls.js` exports the `MobileControls` class and
`shouldShowMobileControls()` (touch device or screen < 900px, used by Menu
for button sizing). Controls use responsive base sizes (larger on narrow
screens) and scale with `setScale()` on every resize. Safe-area insets are
read via a temporary DOM element and applied as extra margin.

## Asset Pack

Modern Interiors by limezu (https://limezu.itch.io/moderninteriors).
Assets live in `assets/moderninteriors-win/`. Only the 48x48 variants are copied to `game-assets/`.
