// Central catalog of spritesheets, tile size, and menu items.
// Sheets are loaded once in Boot and referenced by key everywhere else.
export const TILE = 48;

export const SHEETS = [
  { key: 'generic',     path: 'game-assets/tiles/1_Generic_48x48.png',           frameW: 48, frameH: 48 },
  { key: 'kitchen',     path: 'game-assets/tiles/12_Kitchen_48x48.png',          frameW: 48, frameH: 48 },
  { key: 'room',        path: 'game-assets/tiles/Room_Builder_48x48.png',         frameW: 48, frameH: 48 },
  { key: 'room_floors', path: 'game-assets/tiles/Room_Builder_Floors_48x48.png',  frameW: 48, frameH: 48 },
  { key: 'room_walls',  path: 'game-assets/tiles/Room_Builder_Walls_48x48.png',   frameW: 48, frameH: 48 },
  { key: 'room_3d',     path: 'game-assets/tiles/Room_Builder_3d_walls_48x48.png',frameW: 48, frameH: 48 },
  { key: 'room_borders',path: 'game-assets/tiles/Room_Builder_borders_48x48.png', frameW: 48, frameH: 48 },
  { key: 'ui',          path: 'game-assets/ui/UI_48x48.png',                      frameW: 48, frameH: 48 }
];

// Named characters from Single_Characters_Legacy.
// idle/run sheets use a plain 48×96 grid (characters are 2 tiles tall).
export const CHAR_FRAME_W = 48;
export const CHAR_FRAME_H = 96;

export const CHARACTERS = [
  'Adam', 'Alex', 'Amelia', 'Ash', 'Bob', 'Bruce',
  'Conference_man', 'Conference_woman', 'Dan', 'Edward',
  'Kid_Abby', 'kid_Karen', 'kid_Oscar', 'Lucy', 'Molly',
  'Old_woman_Jenny', 'Pier', 'Rob', 'Roki', 'Samuel'
];

// Build sheet load list: idle sheets use the plain 48×96 grid.
export const CHARACTER_SHEETS = [];
for (const name of CHARACTERS) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  CHARACTER_SHEETS.push({ key: `${key}_idle`, path: `game-assets/characters/single/${name}_idle.png`, frameW: CHAR_FRAME_W, frameH: CHAR_FRAME_H });
}

// Sit sheets are NOT on a 48px grid: 12 sprites of 48×96 in 96px-wide cells.
// Left-facing boxes start at x=18+96i, right-facing at x=606+96i (i=0..5).
// Verified consistent across all 20 characters. Loaded as plain images and
// sliced manually in Boot (see registerSitFrames).
export const SIT_SHEETS = CHARACTERS.map(name => ({
  key: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}_sit`,
  path: `game-assets/characters/single/${name}_sit.png`
}));

export const SIT_GEOM = { w: 48, h: 96, stride: 96, leftX0: 18, rightX0: 606, perDir: 6 };

// Waiter uses Chef_Alex with idle + run sheets.
export const WAITER_SHEETS = [
  { key: 'waiter_idle', path: 'game-assets/characters/single/Chef_Alex_idle.png', frameW: CHAR_FRAME_W, frameH: CHAR_FRAME_H },
  { key: 'waiter_run',  path: 'game-assets/characters/single/Chef_Alex_run.png',  frameW: CHAR_FRAME_W, frameH: CHAR_FRAME_H }
];

// Idle sheet: 4 frames of 48×96. Col 0=RIGHT, 1=UP, 2=LEFT, 3=DOWN.
export const IDLE_FRAMES = { right: 0, up: 1, left: 2, down: 3 };
export const IDLE_FRAME_DOWN = 3;

// Sit frames registered by Boot: 0-5 = LEFT poses, 6-11 = RIGHT poses.
// Only side views exist, so up/down map to a side pose.
export const SIT_FRAMES = { left: 0, right: 6 };

// Run sheet: 24 frames of 48×96. 4 directions × 6 frames.
// Cols 0-5=RIGHT, 6-11=UP, 12-17=LEFT, 18-23=DOWN.
export const RUN_FRAMES = {
  right: [0, 1, 2, 3, 4, 5],
  up:    [6, 7, 8, 9, 10, 11],
  left:  [12, 13, 14, 15, 16, 17],
  down:  [18, 19, 20, 21, 22, 23]
};

// Helper: get sheet keys for a character name.
export function charKeys(name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return { idle: `${key}_idle`, sit: `${key}_sit` };
}

// Menu items the waiter can serve. frame is an index into the named sheet.
export const DEFAULT_MENU = [
  { id: 'burger',  name: 'Burger',  sheet: 'kitchen', frame: 1 },
  { id: 'salad',   name: 'Salad',   sheet: 'kitchen', frame: 2 },
  { id: 'coffee',  name: 'Coffee',  sheet: 'kitchen', frame: 6 },
  { id: 'cake',    name: 'Cake',    sheet: 'kitchen', frame: 7 }
];

export const MENU_LABELS = {
  burger: 'Burger',
  salad: 'Salad',
  coffee: 'Coffee',
  cake: 'Cake'
};

export const MENU_FRAMES = {
  burger: 1,
  salad: 2,
  coffee: 6,
  cake: 7
};
