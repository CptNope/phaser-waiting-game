// Bakes a custom guest appearance (body/eyes/outfit/hairstyle/accessory) into
// two synthetic textures shaped exactly like the legacy character sheets:
//   <key>_idle -> 4 frames (0=right,1=up,2=left,3=down), 48x96 each
//   <key>_sit  -> frames 0 (left) and 6 (right), 48x96 each
// so every caller that already knows how to use charKeys()'s {idle, sit}
// output (Game.js, GuestEditor.js) needs zero changes to consume a custom
// appearance instead of a named preset.
//
// Loading generator layer files is async (Phaser's loader); baking the
// composite from already-loaded layers is synchronous. Game.js's spawn path
// only ever calls the synchronous half — Boot.js is responsible for having
// preloaded every layer file the current guest roster references (via
// collectLayerFiles below), so gameplay never blocks on a network load.

import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { LAYER_ORDER, profileFor, findVariant } from '../data/characterGenerator.js';

const bakedCache = new Map(); // appearanceKey -> { idle, sit }

export function appearanceKey(appearance) {
  const { kid, body, eyes, outfit, hairstyle, accessory } = appearance;
  return `gen_${kid ? 'k' : 'a'}_${body}_${eyes}_${outfit}_${hairstyle}_${accessory || 'x'}`;
}

export function layerTexKey(path) {
  return 'genlayer_' + path.replace(/[^a-zA-Z0-9]/g, '_');
}

/** The manifest entries (with .path) a custom appearance is built from. */
export function collectLayers(appearance) {
  return LAYER_ORDER
    .map(cat => findVariant(cat, appearance.kid, appearance[cat]))
    .filter(Boolean);
}

/** Every {key, path} generator layer file referenced by a list of appearances, deduped. */
export function collectLayerFiles(appearances) {
  const byKey = new Map();
  for (const appearance of appearances) {
    for (const v of collectLayers(appearance)) byKey.set(layerTexKey(v.path), v.path);
  }
  return Array.from(byKey, ([key, path]) => ({ key, path }));
}

/** Async: load whichever of the given layer files aren't already in scene.textures. */
export function preloadLayerFiles(scene, files) {
  const toLoad = files.filter(f => !scene.textures.exists(f.key));
  if (toLoad.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    for (const f of toLoad) scene.load.image(f.key, f.path);
    scene.load.once(Phaser.Loader.Events.COMPLETE, resolve);
    scene.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, (file) => reject(new Error(`Failed to load layer: ${file.key}`)));
    scene.load.start();
  });
}

export function registerLayerFrames(tex, profile) {
  if (tex.has('gen_idle_right')) return; // already registered on this texture
  const { frameW, frameH, idleRow, idleCols, sitRow, sitCols } = profile;
  for (const dir of ['right', 'up', 'left', 'down']) {
    tex.add(`gen_idle_${dir}`, 0, idleCols[dir] * frameW, idleRow * frameH, frameW, frameH);
  }
  tex.add('gen_sit_left', 0, sitCols.left * frameW, sitRow * frameH, frameW, frameH);
  tex.add('gen_sit_right', 0, sitCols.right * frameW, sitRow * frameH, frameW, frameH);
}

function stampLayer(scene, rt, texKey, frameName, destX, destY, flipX) {
  const stamp = new Phaser.GameObjects.Image(scene, 0, 0, texKey, frameName);
  stamp.setOrigin(0, 0);
  if (flipX) stamp.setFlipX(true);
  rt.draw(stamp, destX, destY);
  stamp.destroy();
}

function bakeIdle(scene, layers, key) {
  const rt = scene.make.renderTexture({ width: 192, height: 96 }, false);
  ['right', 'up', 'left', 'down'].forEach((dir, i) => {
    for (const texKey of layers) stampLayer(scene, rt, texKey, `gen_idle_${dir}`, i * 48, 0, false);
  });
  rt.saveTexture(key);
  const tex = scene.textures.get(key);
  for (let i = 0; i < 4; i++) tex.add(i, 0, i * 48, 0, 48, 96);
  rt.destroy();
}

function bakeSit(scene, layers, key, profile) {
  const rt = scene.make.renderTexture({ width: 96, height: 96 }, false);
  for (const texKey of layers) stampLayer(scene, rt, texKey, 'gen_sit_left', 0, 0, false);
  for (const texKey of layers) {
    const mirror = profile.sitMirrorRight;
    stampLayer(scene, rt, texKey, mirror ? 'gen_sit_left' : 'gen_sit_right', 48, 0, mirror);
  }
  rt.saveTexture(key);
  const tex = scene.textures.get(key);
  tex.add(0, 0, 0, 0, 48, 96);  // left
  tex.add(6, 0, 48, 0, 48, 96); // right
  rt.destroy();
}

/**
 * Synchronous: composite an appearance into {idle, sit} texture keys.
 * Requires every referenced layer file to already be in scene.textures
 * (via preloadLayerFiles) — throws otherwise.
 */
export function bakeAppearanceTextures(scene, appearance) {
  const key = appearanceKey(appearance);
  const cached = bakedCache.get(key);
  if (cached) return cached;

  const idleKey = `${key}_idle`, sitKey = `${key}_sit`;
  if (scene.textures.exists(idleKey) && scene.textures.exists(sitKey)) {
    const result = { idle: idleKey, sit: sitKey };
    bakedCache.set(key, result);
    return result;
  }

  const variants = collectLayers(appearance);
  const profile = profileFor(appearance.kid);
  const layerKeys = variants.map(v => layerTexKey(v.path));
  const missing = layerKeys.filter(k => !scene.textures.exists(k));
  if (missing.length > 0) {
    throw new Error(`Cannot bake appearance ${key}: layer textures not loaded (${missing.join(', ')})`);
  }
  for (const k of layerKeys) registerLayerFrames(scene.textures.get(k), profile);

  if (!scene.textures.exists(idleKey)) bakeIdle(scene, layerKeys, idleKey);
  if (!scene.textures.exists(sitKey)) bakeSit(scene, layerKeys, sitKey, profile);

  const result = { idle: idleKey, sit: sitKey };
  bakedCache.set(key, result);
  return result;
}

/** Async convenience: load layer files (if needed) then bake. For editor/UI use. */
export async function ensureAppearanceTextures(scene, appearance) {
  const files = collectLayerFiles([appearance]);
  await preloadLayerFiles(scene, files);
  return bakeAppearanceTextures(scene, appearance);
}
