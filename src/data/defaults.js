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
  hostStand:    { s: 'kitchen',     f: 32 },  // counter reused for host stand
  bench:        { s: 'generic',     f: 78 },  // plant/bench for waiting area decor
};

const COLS = 24;
const ROWS = 14;

function buildDefaultFloorPlan() {
  const ground = new Array(COLS * ROWS).fill(null);
  const objects = new Array(COLS * ROWS).fill(null);
  const solids = new Array(COLS * ROWS).fill(false);
  const tables = [];
  const idx = (x, y) => y * COLS + x;

  // Layout: 24×14 grid
  //   Cols 0-3:  Waiting area (host stand, guests wait here)
  //   Cols 4-23: Restaurant (kitchen top, dining below)
  //
  //   Row 0:  walls + door
  //   Row 1:  kitchen appliances
  //   Row 2:  kitchen walkway
  //   Row 3:  divider wall between kitchen and dining
  //   Rows 4-12: dining area with tables
  //   Row 13: bottom wall

  // --- Ground (floor) ---
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x <= 3) ground[idx(x, y)] = T.floorWaiting;   // waiting area
      else if (y >= 1 && y <= 2) ground[idx(x, y)] = T.floorKitchen; // kitchen
      else ground[idx(x, y)] = T.floorDining;            // dining
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
  const doorX = 2;
  objects[idx(doorX, 0)] = null;
  solids[idx(doorX, 0)] = false;

  // --- Divider wall between waiting area and restaurant (col 4, rows 3-12) ---
  // Leave a gap at row 7 for passage
  for (let y = 3; y < ROWS - 1; y++) {
    if (y === 7) continue; // walkway gap
    objects[idx(4, y)] = T.wall;
    solids[idx(4, y)] = true;
  }

  // --- Host stand (col 3, row 7 — at the passage gap) ---
  const host = { x: 3, y: 7 };
  objects[idx(host.x, host.y)] = T.hostStand;
  solids[idx(host.x, host.y)] = true;

  // --- Kitchen (row 1: fridge, stove, counters) ---
  const kitchenRow = 1;
  const kitchenItems = [
    { x: 6,  tile: T.fridge },
    { x: 7,  tile: T.stove },
    { x: 8,  tile: T.counter },
    { x: 9,  tile: T.counter },
    { x: 10, tile: T.counterAlt },
    { x: 11, tile: T.counter },
  ];
  for (const item of kitchenItems) {
    objects[idx(item.x, kitchenRow)] = item.tile;
    solids[idx(item.x, kitchenRow)] = true;
  }
  const kitchen = { x: 8, y: 2 };

  // --- Dining tables ---
  // 3 rows × 3 tables, spaced in the dining area (cols 6-22, rows 5-11)
  const tablePositions = [
    { x: 7,  y: 5,  tile: T.table },
    { x: 12, y: 5,  tile: T.tableAlt },
    { x: 17, y: 5,  tile: T.table },
    { x: 7,  y: 8,  tile: T.tableAlt },
    { x: 12, y: 8,  tile: T.table },
    { x: 17, y: 8,  tile: T.tableAlt },
    { x: 7,  y: 11, tile: T.table },
    { x: 12, y: 11, tile: T.tableAlt },
    { x: 17, y: 11, tile: T.table },
  ];
  for (const t of tablePositions) {
    objects[idx(t.x, t.y)] = t.tile;
    solids[idx(t.x, t.y)] = true;
    tables.push({ x: t.x, y: t.y });
  }

  // --- Decorative plants ---
  objects[idx(1, 4)] = T.plant;
  solids[idx(1, 4)] = true;
  objects[idx(22, 4)] = T.plant;
  solids[idx(22, 4)] = true;

  return {
    name: 'Default Diner',
    cols: COLS,
    rows: ROWS,
    tile: TILE,
    ground,
    objects,
    solids,
    tables,
    spawn: { x: 12, y: 12 },
    kitchen,
    host,
    door: { x: doorX, y: 0 }
  };
}

function buildDefaultGuests() {
  // Each guest uses a named character from Single_Characters_Legacy.
  // charName maps to <name>_idle (walking) and <name>_sit (seated) sheets.
  // groupSize: how many guests arrive together (1-4). They share a table.
  return [
    { id: 'g1', name: 'Adam',   charName: 'Adam',   patience: 75, order: 'burger', groupSize: 2 },
    { id: 'g2', name: 'Lucy',   charName: 'Lucy',   patience: 60, order: 'salad',  groupSize: 2 },
    { id: 'g3', name: 'Molly',  charName: 'Molly',  patience: 90, order: 'coffee', groupSize: 1 },
    { id: 'g4', name: 'Rob',    charName: 'Rob',    patience: 65, order: 'cake',   groupSize: 3 },
    { id: 'g5', name: 'Amelia', charName: 'Amelia', patience: 80, order: 'burger', groupSize: 3 },
    { id: 'g6', name: 'Dan',    charName: 'Dan',    patience: 70, order: 'salad',  groupSize: 3 },
    { id: 'g7', name: 'Bob',    charName: 'Bob',    patience: 85, order: 'burger', groupSize: 2 },
    { id: 'g8', name: 'Molly',  charName: 'Molly',  patience: 75, order: 'cake',   groupSize: 2 },
  ];
}

export const DEFAULT_FLOOR_PLAN = buildDefaultFloorPlan();
export const DEFAULT_GUESTS = buildDefaultGuests();
