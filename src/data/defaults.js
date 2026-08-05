// Default floor plan + guest roster so the game is playable immediately.
// Tile frames chosen via pixel analysis of the Modern Interiors spritesheets.
// All chosen frames are 100% opaque (no transparency artifacts).
import { TILE } from './catalog.js';

// Tile references — sheet + frame index, verified opaque via pixel analysis.
const T = {
  floorDining:  { s: 'room_floors', f: 34 },  // warm beige (r=224,g=216,b=205)
  floorKitchen: { s: 'room_floors', f: 30 },  // blue-gray  (r=184,g=184,b=197)
  wall:         { s: 'room_walls',  f: 0 },   // gray wall  (r=194,g=197,b=201)
  wall3d:       { s: 'room_3d',     f: 8 },   // 3D gray wall (r=187,g=187,b=191)
  counter:      { s: 'kitchen',     f: 32 },  // light counter (r=213,g=207,b=222)
  counterAlt:   { s: 'kitchen',     f: 48 },  // light counter variant
  stove:        { s: 'kitchen',     f: 82 },  // red stove (r=228,g=88,b=71)
  fridge:       { s: 'kitchen',     f: 80 },  // blue fridge (r=77,g=153,b=213)
  table:        { s: 'kitchen',     f: 44 },  // tan dining table (r=181,g=162,b=138)
  tableAlt:     { s: 'kitchen',     f: 46 },  // wood dining table (r=195,g=154,b=101)
  plant:        { s: 'generic',     f: 78 },  // greenish decoration (r=158,g=161,b=125)
};

const COLS = 20;
const ROWS = 12;

function buildDefaultFloorPlan() {
  const ground = new Array(COLS * ROWS).fill(null);
  const objects = new Array(COLS * ROWS).fill(null);
  const solids = new Array(COLS * ROWS).fill(false);
  const tables = [];
  const idx = (x, y) => y * COLS + x;

  // --- Ground (floor) ---
  // Kitchen area: rows 1-3, cols 1-18 → blue-gray floor
  // Dining area:  rows 4-10, cols 1-18 → warm beige floor
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const isKitchen = y >= 1 && y <= 3;
      ground[idx(x, y)] = isKitchen ? T.floorKitchen : T.floorDining;
    }
  }

  // --- Walls (border) ---
  // Top wall (row 0) — flat gray walls
  for (let x = 0; x < COLS; x++) {
    objects[idx(x, 0)] = T.wall;
    solids[idx(x, 0)] = true;
  }
  // Bottom wall (row 11) — 3D wall for depth (facing camera)
  for (let x = 0; x < COLS; x++) {
    objects[idx(x, ROWS - 1)] = T.wall3d;
    solids[idx(x, ROWS - 1)] = true;
  }
  // Side walls
  for (let y = 1; y < ROWS - 1; y++) {
    objects[idx(0, y)] = T.wall;
    solids[idx(0, y)] = true;
    objects[idx(COLS - 1, y)] = T.wall;
    solids[idx(COLS - 1, y)] = true;
  }

  // --- Door (top center, walkable gap) ---
  const doorX = 10;
  objects[idx(doorX, 0)] = null;
  solids[idx(doorX, 0)] = false;

  // --- Kitchen (row 1: fridge, stove, counters) ---
  const kitchenRow = 1;
  const kitchenItems = [
    { x: 1, tile: T.fridge },
    { x: 2, tile: T.stove },
    { x: 3, tile: T.counter },
    { x: 4, tile: T.counter },
    { x: 5, tile: T.counterAlt },
    { x: 6, tile: T.counter },
  ];
  for (const item of kitchenItems) {
    objects[idx(item.x, kitchenRow)] = item.tile;
    solids[idx(item.x, kitchenRow)] = true;
  }

  // Kitchen pickup point: the walkable tile directly below the first counter
  const kitchen = { x: 3, y: 2 };

  // --- Dining tables ---
  // Two rows of three tables, evenly spaced
  const tablePositions = [
    { x: 4,  y: 5,  tile: T.table },
    { x: 9,  y: 5,  tile: T.tableAlt },
    { x: 14, y: 5,  tile: T.table },
    { x: 4,  y: 8,  tile: T.tableAlt },
    { x: 9,  y: 8,  tile: T.table },
    { x: 14, y: 8,  tile: T.tableAlt },
  ];
  for (const t of tablePositions) {
    objects[idx(t.x, t.y)] = t.tile;
    solids[idx(t.x, t.y)] = true;
    tables.push({ x: t.x, y: t.y });
  }

  // --- Decorative plants in corners of dining area ---
  objects[idx(1, 4)] = T.plant;
  solids[idx(1, 4)] = true;
  objects[idx(18, 4)] = T.plant;
  solids[idx(18, 4)] = true;

  return {
    name: 'Default Diner',
    cols: COLS,
    rows: ROWS,
    tile: TILE,
    ground,
    objects,
    solids,
    tables,
    spawn: { x: 10, y: 10 },
    kitchen,
    door: { x: doorX, y: 0 }
  };
}

function buildDefaultGuests() {
  // Each guest uses a named character from Single_Characters_Legacy.
  // charName maps to <name>_idle (walking) and <name>_sit (seated) sheets.
  return [
    { id: 'g1', name: 'Adam',   charName: 'Adam',   patience: 75, order: 'burger' },
    { id: 'g2', name: 'Lucy',   charName: 'Lucy',   patience: 60, order: 'salad'  },
    { id: 'g3', name: 'Molly',  charName: 'Molly',  patience: 90, order: 'coffee' },
    { id: 'g4', name: 'Rob',    charName: 'Rob',    patience: 65, order: 'cake'   },
    { id: 'g5', name: 'Amelia', charName: 'Amelia', patience: 80, order: 'burger' },
    { id: 'g6', name: 'Dan',    charName: 'Dan',    patience: 70, order: 'salad'  }
  ];
}

export const DEFAULT_FLOOR_PLAN = buildDefaultFloorPlan();
export const DEFAULT_GUESTS = buildDefaultGuests();
