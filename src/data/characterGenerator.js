// Character Generator layered sprite catalog (Modern Interiors pack).
// Source: assets/moderninteriors-win/2_Characters/Character_Generator/*/48x48/
// Copied into game-assets/characters/generator/<Category>/ (see AGENTS.md
// "Character Sprites" convention: assets/ is the raw pack, game-assets/ is
// what the game actually loads).
//
// Layers stack in this order (per the pack's CHARACTER_GENERATOR.txt):
//   Body -> Eyes -> Outfit -> Hairstyle -> Accessory
// All layers in a matching adult/kid profile share the same frame grid so
// they overlay pixel-for-pixel when composited (see AppearanceCompositor).

export const GEN_BASE = 'game-assets/characters/generator';
export const LAYER_ORDER = ['body', 'eyes', 'outfit', 'hairstyle', 'accessory'];

// Real frames are 48 wide x 96 tall (characters are 2 tiles tall, same as
// Single_Characters_Legacy). Row/column offsets below were measured from the
// actual Bodies sheet (48x48-cell pixel-occupancy scan) and cross-checked
// against the legacy sit sheet's known 12-frame (6 left + 6 right) layout,
// which lines up exactly with the generator's first "Sit" row. Verify
// visually in the Guest Editor preview after any pack update.
export const ADULT_PROFILE = {
  kid: false,
  frameW: 48, frameH: 96,
  idleRow: 1, idleCols: { right: 0, up: 6, left: 12, down: 18 },
  sitRow: 4, sitCols: { left: 0, right: 6 }, sitMirrorRight: false
};

// Kid sheets are a much smaller grid (1152x384 = 24 cols x 8 half-rows = 4
// real rows: header, idle, walk, sit). Only one sit pose exists, so the
// "right" sit frame is produced by mirroring the "left" one at composite time.
export const KID_PROFILE = {
  kid: true,
  frameW: 48, frameH: 96,
  idleRow: 1, idleCols: { right: 0, up: 6, left: 12, down: 18 },
  sitRow: 3, sitCols: { left: 0, right: 0 }, sitMirrorRight: true
};

function pad2(n) { return String(n).padStart(2, '0'); }
function range(n, start = 1) { return Array.from({ length: n }, (_, i) => i + start); }

// --- Bodies / Eyes (adult) ---------------------------------------------
export const BODIES = range(9).map(n => ({
  id: `${n}`, label: `Body ${n}`,
  path: `${GEN_BASE}/Bodies/Body_48x48_${pad2(n)}.png`
}));

export const EYES = range(7).map(n => ({
  id: `${n}`, label: `Eyes ${n}`,
  path: `${GEN_BASE}/Eyes/Eyes_48x48_${pad2(n)}.png`
}));

// --- Bodies / Eyes (kids) ------------------------------------------------
export const BODIES_KIDS = range(4).map(n => ({
  id: `${n}`, label: `Body ${n}`,
  path: `${GEN_BASE}/Bodies_kids/Body_${n}_kid_48x48.png`
}));

export const EYES_KIDS = range(6).map(n => ({
  id: `${n}`, label: `Eyes ${n}`,
  path: `${GEN_BASE}/Eyes_kids/Eyes_kids_48x48_${n}.png`
}));

// --- Outfits (adult): 33 styles, variable color-variant counts ----------
const OUTFIT_STYLE_COLORS = [10, 4, 4, 3, 5, 4, 4, 3, 3, 5, 4, 3, 4, 5, 3, 3, 3, 4, 4, 3, 4, 4, 4, 4, 5, 3, 3, 4, 4, 3, 5, 5, 3];
export const OUTFITS = OUTFIT_STYLE_COLORS.flatMap((colors, i) => {
  const style = i + 1;
  return range(colors).map(color => ({
    id: `${pad2(style)}_${pad2(color)}`, style, color,
    label: `Outfit ${style}.${color}`,
    path: `${GEN_BASE}/Outfits/Outfit_${pad2(style)}_48x48_${pad2(color)}.png`
  }));
});

// --- Hairstyles (adult): 29 styles, 7 colors each except 27-29 (6) ------
const HAIRSTYLE_STYLE_COLORS = [...range(26).map(() => 7), 6, 6, 6];
export const HAIRSTYLES = HAIRSTYLE_STYLE_COLORS.flatMap((colors, i) => {
  const style = i + 1;
  return range(colors).map(color => ({
    id: `${pad2(style)}_${pad2(color)}`, style, color,
    label: `Hairstyle ${style}.${color}`,
    path: `${GEN_BASE}/Hairstyles/Hairstyle_${pad2(style)}_48x48_${pad2(color)}.png`
  }));
});

// --- Outfits / Hairstyles (kids) ----------------------------------------
// Irregular filenames (two named pajama outfits) - listed explicitly.
export const OUTFITS_KIDS = [
  { id: '1', label: 'Outfit 1', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_1_48x48.png` },
  { id: '2', label: 'Outfit 2', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_2_48x48.png` },
  { id: '3', label: 'Outfit 3', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_3_48x48.png` },
  { id: '4', label: 'Outfit 4', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_4_48x48.png` },
  { id: '5', label: 'Outfit 5', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_5_48x48.png` },
  { id: '6', label: 'Pajama Frog', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_6_pajama_frog_48x48.png` },
  { id: '7', label: 'Pajama Tiger', path: `${GEN_BASE}/Outfits_kids/Outfit_kid_7_pajama_tiger_48x48.png` }
];

const HAIRSTYLE_KIDS_STYLE_COLORS = [5, 5, 5, 5, 5, 5];
export const HAIRSTYLES_KIDS = HAIRSTYLE_KIDS_STYLE_COLORS.flatMap((colors, i) => {
  const style = i + 1;
  return range(colors).map(color => ({
    id: `${style}_${color}`, style, color,
    label: `Hairstyle ${style}.${color}`,
    path: `${GEN_BASE}/Hairstyles_kids/Hairstyle_kid_${style}_48x48_${color}.png`
  }));
});

// --- Accessories (adult only - the pack has no _kids accessory set;
// kid guests can still pick from this list, e.g. Beanie/Glasses fit fine) --
const ACCESSORY_STYLES = [
  ['01', 'Ladybug', 4], ['02', 'Bee', 3], ['03', 'Backpack', 10], ['04', 'Snapback', 6],
  ['05', 'Dino_Snapback', 3], ['06', 'Policeman_Hat', 6], ['07', 'Bataclava', 3],
  ['08', 'Detective_Hat', 3], ['09', 'Zombie_Brain', 3], ['10', 'Bolt', 3],
  ['11', 'Beanie', 5], ['12', 'Mustache', 5], ['13', 'Beard', 5], ['14', 'Gloves', 4],
  ['15', 'Glasses', 6], ['16', 'Monocle', 3], ['17', 'Medical_Mask', 5], ['18', 'Chef', 3],
  ['19', 'Party_Cone', 4]
];
export const ACCESSORIES = ACCESSORY_STYLES.flatMap(([style, name, colors]) =>
  range(colors).map(color => ({
    id: `${style}_${pad2(color)}`, style, color,
    label: `${name.replace(/_/g, ' ')} ${color}`,
    path: `${GEN_BASE}/Accessories/Accessory_${style}_${name}_48x48_${pad2(color)}.png`
  }))
);

// Category -> { adult manifest, kid manifest | null } for building pickers.
export const CATEGORIES = {
  body: { label: 'Body', adult: BODIES, kids: BODIES_KIDS },
  eyes: { label: 'Eyes', adult: EYES, kids: EYES_KIDS },
  outfit: { label: 'Outfit', adult: OUTFITS, kids: OUTFITS_KIDS },
  hairstyle: { label: 'Hairstyle', adult: HAIRSTYLES, kids: HAIRSTYLES_KIDS },
  accessory: { label: 'Accessory', adult: ACCESSORIES, kids: ACCESSORIES }
};

export function profileFor(kid) { return kid ? KID_PROFILE : ADULT_PROFILE; }

/** Find a manifest entry by id within a category (respecting the kid flag). */
export function findVariant(category, kid, id) {
  if (id == null) return null;
  const list = kid ? CATEGORIES[category].kids : CATEGORIES[category].adult;
  return list.find(v => v.id === id) || null;
}

/** Pick a random variant id (or null for accessory, which allows "none"). */
export function randomVariantId(category, kid, allowNone) {
  const list = kid ? CATEGORIES[category].kids : CATEGORIES[category].adult;
  if (allowNone && Math.random() < 0.35) return null;
  return list[Math.floor(Math.random() * list.length)].id;
}

/** A random full custom appearance, respecting the kid flag. */
export function randomAppearance(kid = false) {
  return {
    kid,
    body: randomVariantId('body', kid, false),
    eyes: randomVariantId('eyes', kid, false),
    outfit: randomVariantId('outfit', kid, false),
    hairstyle: randomVariantId('hairstyle', kid, false),
    accessory: randomVariantId('accessory', kid, true)
  };
}
