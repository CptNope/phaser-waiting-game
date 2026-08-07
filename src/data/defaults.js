// Default floor plan + guest roster so the game is playable immediately.
// Tile frames chosen via pixel analysis of the Modern Interiors spritesheets.
// All chosen frames are 100% opaque (no transparency artifacts).
import { TILE } from './catalog.js';

// Tile references — sheet + frame index, verified opaque via pixel analysis.
const T = {
  floorDining:  { s: 'room_floors', f: 34 },  // warm beige (r=224,g=216,b=205)
  floorKitchen: { s: 'room_floors', f: 30 },  // blue-gray  (r=184,g=184,b=197)
  floorWaiting: { s: 'room_floors', f: 38 },  // light tile for waiting area
  wall:         { s: 'room_walls',  f: 0 },   // gray wall  (r=194,g=197,b=201)
  wall3d:       { s: 'room_3d',     f: 8 },   // 3D gray wall (r=187,g=187,b=191)
  counter:      { s: 'kitchen',     f: 32 },  // light counter (r=213,g=207,b=222)
  counterAlt:   { s: 'kitchen',     f: 48 },  // light counter variant
  stove:        { s: 'kitchen',     f: 82 },  // red stove (r=228,g=88,b=71)
  fridge:       { s: 'kitchen',     f: 80 },  // blue fridge (r=77,g=153,b=213)
  table:        { s: 'kitchen',     f: 44 },  // tan dining table (r=181,g=162,b=138)
  tableAlt:     { s: 'kitchen',     f: 46 },  // wood dining table (r=195,g=154,b=101)
  plant:        { s: 'generic',     f: 78 },  // greenish decoration (r=158,g=161,b=125)
  hostStand:    { s: 'kitchen',     f: 48 },  // counter variant for the host stand
  bench:        { s: 'kitchen',     f: 44 },  // low table reused as a waiting bench
};

const COLS = 36;
const ROWS = 20;

function buildDefaultFloorPlan() {
  const ground = new Array(COLS * ROWS).fill(null);
  const objects = new Array(COLS * ROWS).fill(null);
  const solids = new Array(COLS * ROWS).fill(false);
  const tables = [];
  const benches = [];
  const idx = (x, y) => y * COLS + x;

  // Layout: 36×20 grid
  //   Cols 0-6:   Waiting area — door, host stand, benches, queue line
  //   Col  7:     Divider wall (passage gap at row 8)
  //   Cols 8-27:  Restaurant — kitchen along the top, dining below
  //   Col  28:    Divider wall (passage gap at row 10)
  //   Cols 29-35: Bar area — counter, bar tables, bartender station
  //
  //   Row 0:      top wall, door at x=3
  //   Rows 1-2:   kitchen appliances + walkway
  //   Row 3:      kitchen/dining divider wall (gaps for passage)
  //   Rows 4-14:  dining area with mixed-size tables
  //   Row 15:     bottom wall of the original section (cols 0-27 only)
  //   Rows 16-19: sealed dead space under cols 0-27; full-height bar area
  //               to the right (cols 28-35)

  // --- Ground (floor) ---
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x <= 6) ground[idx(x, y)] = T.floorWaiting;                 // waiting area
      else if (x >= 8 && y >= 1 && y <= 2) ground[idx(x, y)] = T.floorKitchen;
      else ground[idx(x, y)] = T.floorDining;
    }
  }

  // --- Walls (border) ---
  for (let x = 0; x < COLS; x++) {
    objects[idx(x, 0)] = T.wall;
    solids[idx(x, 0)] = true;
    objects[idx(x, ROWS - 1)] = T.wall3d;
    solids[idx(x, ROWS - 1)] = true;
  }
  for (let y = 1; y < ROWS - 1; y++) {
    objects[idx(0, y)] = T.wall;
    solids[idx(0, y)] = true;
    objects[idx(COLS - 1, y)] = T.wall;
    solids[idx(COLS - 1, y)] = true;
  }

  // --- Door (top of waiting area) ---
  const doorX = 3;
  objects[idx(doorX, 0)] = null;
  solids[idx(doorX, 0)] = false;

  // --- Divider wall between waiting area and restaurant (col 7) ---
  // Row 8 is the only passage, so it and the tile feeding it must stay clear.
  const passageY = 8;
  for (let y = 1; y < ROWS - 1; y++) {
    if (y === passageY) continue;
    objects[idx(7, y)] = T.wall;
    solids[idx(7, y)] = true;
  }

  // --- Host stand (one row above the passage, never blocking it) ---
  const host = { x: 6, y: passageY - 1 };
  objects[idx(host.x, host.y)] = T.hostStand;
  solids[idx(host.x, host.y)] = true;

  // --- Waiting benches (left wall of the waiting area) ---
  // Parties sit here while they wait; the queue line forms in front of them.
  const benchPositions = [
    { x: 1, y: 4 }, { x: 1, y: 5 }, { x: 1, y: 6 },
    { x: 1, y: 10 }, { x: 1, y: 11 }, { x: 1, y: 12 },
  ];
  for (const b of benchPositions) {
    objects[idx(b.x, b.y)] = T.bench;
    solids[idx(b.x, b.y)] = true;
    benches.push({ x: b.x, y: b.y });
  }

  // --- Kitchen (row 1: fridge, stove, counters) ---
  const kitchenRow = 1;
  const kitchenItems = [
    { x: 9,  tile: T.fridge },
    { x: 10, tile: T.stove },
    { x: 11, tile: T.counter },
    { x: 12, tile: T.counter },
    { x: 13, tile: T.counterAlt },
    { x: 14, tile: T.counter },
    { x: 15, tile: T.counter },
  ];
  for (const item of kitchenItems) {
    objects[idx(item.x, kitchenRow)] = item.tile;
    solids[idx(item.x, kitchenRow)] = true;
  }
  const kitchen = { x: 11, y: 2 };

  // --- Kitchen / dining divider (row 3, gaps at x=9 and x=20) ---
  // Bounded at the original section's right edge (28), not COLS - 1: the
  // grid grew wider for the bar area, and this divider must not wall that
  // off too.
  for (let x = 8; x < 28; x++) {
    if (x === 9 || x === 20) continue;
    objects[idx(x, 3)] = T.wall;
    solids[idx(x, 3)] = true;
  }

  // --- Dining tables (mixed sizes) ---
  // w×h is the table footprint in tiles. Seats are the walkable tiles around
  // it, so 1×1 ≈ 4 seats, 2×1 ≈ 6 seats, 2×2 ≈ 8 seats.
  const tablePositions = [
    // Row 1 — small two-tops
    { x: 10, y: 5,  w: 1, h: 1, tile: T.table },
    { x: 14, y: 5,  w: 1, h: 1, tile: T.tableAlt },
    { x: 18, y: 5,  w: 1, h: 1, tile: T.table },
    { x: 22, y: 5,  w: 1, h: 1, tile: T.tableAlt },
    // Row 2 — wide four/six-tops
    { x: 10, y: 8,  w: 2, h: 1, tile: T.tableAlt },
    { x: 15, y: 8,  w: 2, h: 1, tile: T.table },
    { x: 20, y: 8,  w: 2, h: 1, tile: T.tableAlt },
    // Row 3 — large party tables
    { x: 10, y: 11, w: 2, h: 2, tile: T.table },
    { x: 16, y: 11, w: 2, h: 2, tile: T.tableAlt },
    { x: 22, y: 11, w: 1, h: 2, tile: T.table },
  ];
  for (const t of tablePositions) {
    for (let dy = 0; dy < t.h; dy++) {
      for (let dx = 0; dx < t.w; dx++) {
        objects[idx(t.x + dx, t.y + dy)] = t.tile;
        solids[idx(t.x + dx, t.y + dy)] = true;
      }
    }
    tables.push({ x: t.x, y: t.y, w: t.w, h: t.h });
  }

  // --- Decorative plants ---
  objects[idx(5, 2)] = T.plant;
  solids[idx(5, 2)] = true;
  objects[idx(5, 14)] = T.plant;
  solids[idx(5, 14)] = true;
  objects[idx(26, 5)] = T.plant;
  solids[idx(26, 5)] = true;

  // --- Seal the original dining room's south edge ---
  // The grid grew taller (16 -> 20 rows) to make room for the bar area, so the
  // old bottom border (row 15) is no longer auto-generated by the outer-wall
  // loop above (that now runs to row ROWS-1 = 19). Recreate it explicitly so
  // rows 16-19 under the original 28-wide section stay sealed, inert space
  // rather than an open void.
  for (let x = 0; x < 28; x++) {
    objects[idx(x, 15)] = T.wall3d;
    solids[idx(x, 15)] = true;
  }

  // --- Bar area (cols 28-35), added to the right of the original layout ---
  //   Col  28:     Divider wall, passage gap at row 10
  //   Row  1:      back wall behind the counter (cols 29-34)
  //   Row  2:      bar counter (cols 29-33) + end cap (col 34)
  //   Row  3:      patron seats (auto-derived from the counter's footprint)
  //   Rows 4-18:   open bar floor with a few isBar dining tables

  const barDividerX = 28;
  const barPassageY = 10;
  for (let y = 1; y < ROWS - 1; y++) {
    if (y === barPassageY) continue;
    objects[idx(barDividerX, y)] = T.wall;
    solids[idx(barDividerX, y)] = true;
  }

  const barBackWallY = 1;
  const barCounterY = 2;
  for (let x = 29; x <= 34; x++) {
    objects[idx(x, barBackWallY)] = T.wall;
    solids[idx(x, barBackWallY)] = true;
  }
  const barCounterTiles = [T.counter, T.counterAlt, T.counter, T.counterAlt, T.counter];
  for (let i = 0; i < barCounterTiles.length; i++) {
    const x = 29 + i;
    objects[idx(x, barCounterY)] = barCounterTiles[i];
    solids[idx(x, barCounterY)] = true;
  }
  // End cap closes the counter's right edge so it isn't auto-derived as a
  // seat by seatsForTable (which would otherwise place a stool right where
  // the waiter picks up drinks).
  objects[idx(34, barCounterY)] = T.counterAlt;
  solids[idx(34, barCounterY)] = true;
  const barCounter = { x: 29, y: barCounterY, w: 5, h: 1, isBar: true };
  tables.push(barCounter);

  // --- A few regular dining tables in the bar area ---
  const barTablePositions = [
    { x: 30, y: 7,  w: 1, h: 1, tile: T.tableAlt },
    { x: 33, y: 7,  w: 1, h: 1, tile: T.table },
    { x: 30, y: 13, w: 2, h: 1, tile: T.tableAlt },
  ];
  for (const t of barTablePositions) {
    for (let dy = 0; dy < t.h; dy++) {
      for (let dx = 0; dx < t.w; dx++) {
        objects[idx(t.x + dx, t.y + dy)] = t.tile;
        solids[idx(t.x + dx, t.y + dy)] = true;
      }
    }
    tables.push({ x: t.x, y: t.y, w: t.w, h: t.h, isBar: true });
  }

  // --- Bar decoration ---
  objects[idx(33, 17)] = T.plant;
  solids[idx(33, 17)] = true;

  // Bartender station + waiter pickup point, one tile in front of the
  // counter's end cap — never coincides with a guest seat (verified: it is
  // not orthogonally adjacent to any table footprint).
  const bar = { x: 34, y: barCounterY + 1 };

  return {
    name: 'Default Diner',
    cols: COLS,
    rows: ROWS,
    tile: TILE,
    ground,
    objects,
    solids,
    tables,
    benches,
    spawn: { x: 12, y: 14 },
    kitchen,
    host,
    bar,
    door: { x: doorX, y: 0 }
  };
}

function buildDefaultGuests() {
  // Each guest uses a named character from Single_Characters_Legacy.
  // charName maps to <name>_idle (walking) and <name>_sit (seated) sheets.
  // groupSize on the first guest of a party decides how many queued guests
  // arrive together; the whole party shares one table.
  //
  // Dine-in guests order a drink first (drinkOrder), then food (foodOrder)
  // once the drink is delivered. prefersBar guests skip the host queue,
  // seat themselves at the bar, order only a drink, and leave — foodOrder
  // is unused for them.
  return [
    { id: 'g1',  name: 'Adam',   charName: 'Adam',            patience: 75, drinkOrder: 'beer',   foodOrder: null,     prefersBar: true,  groupSize: 2 },
    { id: 'g2',  name: 'Lucy',   charName: 'Lucy',            patience: 60, drinkOrder: 'wine',   foodOrder: null,     prefersBar: true,  groupSize: 2 },
    { id: 'g3',  name: 'Molly',  charName: 'Molly',           patience: 90, drinkOrder: 'coffee', foodOrder: null,     prefersBar: true,  groupSize: 1 },
    { id: 'g4',  name: 'Rob',    charName: 'Rob',             patience: 65, drinkOrder: 'beer',   foodOrder: 'cake',   groupSize: 4 },
    { id: 'g5',  name: 'Amelia', charName: 'Amelia',          patience: 80, drinkOrder: 'wine',   foodOrder: 'burger', groupSize: 4 },
    { id: 'g6',  name: 'Dan',    charName: 'Dan',             patience: 70, drinkOrder: 'coffee', foodOrder: 'salad',  groupSize: 4 },
    { id: 'g7',  name: 'Bob',    charName: 'Bob',             patience: 85, drinkOrder: 'beer',   foodOrder: 'burger', groupSize: 4 },
    { id: 'g8',  name: 'Ash',    charName: 'Ash',             patience: 75, drinkOrder: 'wine',   foodOrder: 'cake',   groupSize: 6 },
    { id: 'g9',  name: 'Bruce',  charName: 'Bruce',           patience: 80, drinkOrder: 'coffee', foodOrder: 'burger', groupSize: 6 },
    { id: 'g10', name: 'Edward', charName: 'Edward',          patience: 70, drinkOrder: 'beer',   foodOrder: 'burger', groupSize: 6 },
    { id: 'g11', name: 'Jenny',  charName: 'Old_woman_Jenny', patience: 95, drinkOrder: 'wine',   foodOrder: 'cake',   groupSize: 6 },
    { id: 'g12', name: 'Pier',   charName: 'Pier',            patience: 65, drinkOrder: 'coffee', foodOrder: 'salad',  groupSize: 6 },
    { id: 'g13', name: 'Roki',   charName: 'Roki',            patience: 75, drinkOrder: 'beer',   foodOrder: 'burger', groupSize: 6 },
    { id: 'g14', name: 'Samuel', charName: 'Samuel',          patience: 80, drinkOrder: 'wine',   foodOrder: 'cake',   groupSize: 3 },
    { id: 'g15', name: 'Abby',   charName: 'Kid_Abby',        patience: 55, drinkOrder: 'coffee', foodOrder: 'cake',   groupSize: 3 },
    { id: 'g16', name: 'Oscar',  charName: 'kid_Oscar',       patience: 55, drinkOrder: 'beer',   foodOrder: 'salad',  groupSize: 3 },
  ];
}

export const DEFAULT_FLOOR_PLAN = buildDefaultFloorPlan();
export const DEFAULT_GUESTS = buildDefaultGuests();
