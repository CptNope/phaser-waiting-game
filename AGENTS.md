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
  catalog.js), f:384 (fries — closest available plated-dish icon, not a
  literal fries sprite), f:385 (stir fry), f:354 (stack of plates — reused
  both as the dish-area tile and the dirty-table indicator icon)

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
  with the host stand just reports status. The host will not seat a party at
  a still-empty table once `maxActiveTables` (3) non-bar tables are already
  occupied — see "Table cap" below. Adding to an already-active table (a
  party joining one that already has guests) is never blocked by the cap.
- Waiting guests show blue patience bars; seated guests show green→red
- HUD is two rows: status (Served/Score/Tables/…) + time on row 1, the carry
  tray on its own row 2 below — always its own line so a long status string
  can never run over it (see "HUD" under Controls)
- On serve/angry-leave, swap back to `_idle` and walk to door
- Waiter plays `waiter_<dir>` walk animation while moving, returns to idle pose when stopped

### Table cap: the server juggles at most 3 tables

`this.maxActiveTables = 3` (Game.js `create()`). `findFreeTableForGroup()`
(the host's regular, non-bar seating pool) refuses to hand out a still-**empty**
table once `activeTableCount()` — non-bar tables with at least one seated
guest *or still dirty*, via `tableIsEmpty()`/`dirtyTables` — already meets the
cap; the party stays in `waitingGroups` and `updateHost()` retries it each
tick, exactly like waiting for any other table to free up. Dirty tables
count even with zero guests, so bussing promptly is what actually keeps
capacity available — see "Bussing" under the Kitchen section below. This
only throttles the *dine-in* pipeline — bar seating (`findFreeBarTableForGroup`)
is uncapped, since the bartender handles those guests entirely on its own.

### Whole-table ordering and the carry tray

Facing any guest at an occupied (non-bar) table handles the **whole table**
in one interaction (`handleTableInteraction()`), not just the faced guest:

1. Deliver anything already on the tray that matches someone at the table.
2. Take drink orders for anyone `seated` without one yet.
3. Take food orders for anyone `drink_served` without one yet — including a
   guest whose drink step 1 *just* delivered, so a table can go from "just
   sat down" to "food on the way" in one visit if the tray has what it needs.

Per-guest state machine (unchanged shape, just driven per-table now):
`seated` → `ordered_drink` → `drink_served` → `ordered_food` → `served`.
Patience is a single continuous budget from `onGuestSeated` through the final
delivery; it is not reset between stages. `guestAdjacent()` only matches
guests at non-bar tables — guests seated at the bar are excluded entirely and
served by the bartender instead, never by the player (see "Bartender NPC").

**The tray** (`this.carrying`): an array of `{ type: 'drink'|'food'|'dirty_dish',
item, guest }`, capped at `CARRY_CAP` (4) total items of any mix. Ordering
just enqueues — `readyDrinks`/`readyFood` — it never touches the tray
directly. Picking up at the bar/kitchen marker drains up to the tray's
remaining room from the matching queue (`Array.splice(0, room)`), so the
player can grab several guests' items in one trip instead of one at a time.
Delivery matches tray entries to guests by `type` + `guest` reference
(`Array.findIndex`), so several items can be handed out to one table in one
visit too. Food runners and the bartender drain the *same* shared queues in
the background (see below) — whichever caller (player or NPC) calls
`shift()`/`splice()` first simply claims the entry; there is no separate
conflict handling needed since JS is single-threaded.

### Bartender NPC

The bartender has two independent jobs:

1. **Dine-in drink pickup** — same "kitchen for drinks" model as before: no
   walking, no per-drink state. `spawnBartender()` places a static `Alex`
   sprite with a "BARTENDER" badge (plus a "DRINK PICKUP" stand-in label —
   see "Pickup labels" below) at `plan.bar`. Taking a dine-in guest's drink
   order pushes `{ guest, item }` onto `this.readyDrinks` immediately (no
   prep delay); the player picks up from there, same tray/`CARRY_CAP` rules
   as the kitchen.
2. **Full service for bar-seated guests** — `onGuestSeated()` calls
   `startBartenderService(g)` whenever `g.table.isBar` is true: the bartender
   notices the guest (~1.2s), takes their drink order, prepares it (~1.8s),
   and delivers it directly via `finalizeGuestVisit()` — no player
   involvement at all, and it never touches `readyDrinks`/`carrying`. Each
   step re-checks the guest's state first so a guest who left angry
   mid-service is silently skipped rather than double-handled.

`finalizeGuestVisit()` is the shared tip/leave finale (score, `served` count,
walk to the door). It's called from three places — the bartender's
autonomous bar finale, a food runner's autonomous food finale, and the
player delivering a table's food order by hand (`handleTableInteraction`,
which removes the tray item first) — and deliberately does **not** touch
`this.carrying`/the queues itself, so whichever of the three finalizes one
guest can never clobber items still on the tray or in flight for someone
else.

The bar counter and any bar-area dining tables are regular `tables` entries
flagged `isBar: true`, which auto-derive seats the same way every other table
does. `findFreeTableForGroup()` (host's regular seating pool) excludes
`isBar` tables; `findFreeBarTableForGroup()` is the mirror image, used only by
`prefersBar` parties. Bar parties that arrive when the bar is full queue in
`barWaitingGroups` (mirroring `waitingGroups`/`reflowWaitingQueue`, but
simpler — no bench/queue-line logic, just a handful of holding tiles near
`plan.bar` from `barWaitingSpots()`) and are retried each tick by
`updateBarWaiting()`.

### Kitchen: 5 stations, cooks, food runners, bussing

The kitchen row (row 1, cols 9-27) has a two-tile appliance footprint per
station — grill, fry, sauté, salad, dessert, then a two-tile dish area —
each separated by an open gap column so they read as distinct areas on the
map, reusing existing tiles (`T.stove`/`T.counter`/`T.counterAlt`/`T.dishRack`);
stations are told apart by their cook's badge, not unique art, same as
HOST/BARTENDER. `plan.kitchen` is no longer tied to any one station — it's
the food pickup point (plus a "FOOD PICKUP" stand-in label — below), a
status/decoration anchor sitting in a gap column, central to the whole span.
`COOK_STATIONS` in Game.js maps each `plan.stations.<key>` position (row 2,
under the station's first appliance tile) to a character + badge;
`spawnCooks()` places one static sprite+badge per station, no AI, same model
as the bartender for dine-in drinks.

**Order flow**: taking a food order (step 3 of whole-table handling, above)
calls `startCookPrep(g, food)`, which looks up the item's station via
`STATION_FOR_FOOD` and, after a prep delay, pushes `{ guest, item,
stationPost }` onto `this.readyFood`. From there, **either** the player
(facing `plan.kitchen`, tray-capped multi-pickup) **or** a food runner can
claim and deliver it — see "Food runners" below. State is re-checked at
every async boundary (prep complete, delivery) so a guest who left angry
mid-flight is dropped cleanly instead of crashing.

**Food runners** (`FOOD_RUNNER_CHARACTERS`, posts at `plan.runnerPosts`) are
the only kitchen NPCs that walk — they reuse `walkActorTo()` exactly like
the host does — and have two jobs, checked in priority order each tick for
every idle runner (`updateFoodRunners()`):
1. **Deliver ready food** (`dispatchRunnerToFood`) — walk to the station,
   then the guest's seat, then `finalizeGuestVisit()`. Guest-state guarded at
   both legs, same pattern as `startBartenderService()`.
2. **Bus a dirty table** (`dispatchRunnerToBus`), only when there's no food
   waiting — walk to any tile in the table's seat ring, then to `plan.dish`,
   +2 score. Claims the table via `clearTableDirty()` immediately on pickup,
   same call the player's own bussing uses, so there's no double-claim.

**Bussing**: `removeGuestSprite()` — the shared cleanup both `finalizeGuestVisit()`
and `guestLeavesAngry()` funnel into once a guest's sprite reaches the door —
marks a table dirty (`markTableDirty()`, a small stack-of-plates icon,
kitchen frame 354) once `tableIsEmpty()` is true for it, i.e. the whole
party is gone. Dirty tables are excluded from `findFreeTableFrom()`
regardless of guest occupancy (so neither the host nor `prefersBar` seating
will use one) and count as "active" in `activeTableCount()` even with zero
guests, keeping the 3-table cap meaningful until bussed. The player picks up
a dirty dish (tray-capped) by facing any tile of the table's footprint
(`tableAt()`) and drops it off at `plan.dish` for +2 score per dish — but a
food runner may beat them to it (above). Applies to bar tables too — the
bartender handles drinks, not cleaning.

### Pickup labels

Neither the bar nor the kitchen has a dedicated pickup-counter sprite yet, so
`spawnBartender()`/`spawnPickupLabels()` add plain text badges ("DRINK
PICKUP" below the bartender, "FOOD PICKUP" floating over `plan.kitchen`) as
placeholders — same visual language as the HOST/BARTENDER/cook name badges,
just marking a spot rather than an NPC. Swap these out once real
pickup-counter frames are chosen from the kitchen sheet.

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
  at row 8; kitchen along row 1 (cols 9-27: fridge + 5 two-tile stations +
  a two-tile dish area, each separated by a gap column, cooks/runners
  standing in the row-2 walkway below); and ten dining tables in mixed
  1×1 / 2×1 / 1×2 / 2×2 footprints. Rows 16-19 under that original
  28-wide section are sealed dead space (the grid grew taller for the bar
  area, and that section didn't need to). To the right (cols 28-35), a second
  divider (passage at row 10) leads into the bar area: a 5-wide counter + a
  few `isBar` dining tables, with the bartender's station at (34,3).
- **Kitchen station/dish/runner-post positions** (`plan.stations`,
  `plan.dish`, `plan.runnerPosts`) have Floor Plan Editor marker tools
  (Station/Dish/Runner — see below), same as every other marker. A saved
  plan predating this feature simply has empty/missing fields, which
  `spawnCooks()`/`spawnFoodRunners()` fall back to `plan.kitchen`'s position
  for, so nothing crashes — it just visually clusters until placed.

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
- **Spawn / Kitchen / Bar / Door / Host / Bench / Table / Station / Dish / Runner**
  (markers) — place the marker AND auto-paint the selected object tile on
  that cell (sets solid=true). Removes marker on re-click. Each marker
  button has a small preview icon (bottom-right corner); right-click the
  preview to assign the current palette selection as that marker's
  dedicated tile. Per-marker tiles are stored in `plan.markerTiles` and
  saved with the plan.
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
  - **Station** places a cook's post at `plan.stations.<key>`; the **Station**
    picker row (Grill/Fry/Saute/Salad/Dsrt) chooses which key a click writes
    to. Re-placing a key just moves it — there's no separate remove.
  - **Dish** = the bussing drop-off point (`plan.dish`), single marker like
    Kitchen/Bar.
  - **Runner** = a food-runner idle post (`plan.runnerPosts`, an array like
    Bench — click again on the same tile to remove it).

The tool row is responsive: with 16 tools it shrinks the sheet selector, the
action buttons, the button width and finally the font so it never runs under
the Menu/Import/Export/Save buttons. Row 2 (Layers/Size/Table/Station
pickers) is not responsive — it can overflow on narrow viewports.

If the index fails to load, the editor falls back to the sheets Boot preloaded.

## Controls

- **WASD / Arrow keys** — move waiter
- **E** — interact: at a table, handles the whole table at once (deliver
  anything matching on the tray, take drink/food orders — see "Whole-table
  ordering and the carry tray"); at the bar/kitchen, picks up as many ready
  drinks/dishes as the tray (cap 4) has room for; at a dirty table, picks up
  the dish; at the dish area, drops off everything bussed; at the host
  stand, reports front-of-house status (the host seats parties itself)
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
