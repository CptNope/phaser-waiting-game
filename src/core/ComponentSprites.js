// Bridges the Components catalog's user-uploaded images into Phaser textures.
// A custom sprite's raw art lives as a base64 data URI on its CustomSprite
// record (see data/defaults.js's DEFAULT_COMPONENTS comment and
// ComponentEditor.js) — this module is what turns that into something
// `this.add.image(x, y, key, frame)` can actually draw, on demand, in
// whichever scene needs it (the editor, the Floor Plan Editor, and Game.js
// all import it rather than duplicating the addBase64 dance three times).
import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';

const CUSTOM_PREFIX = 'custom_';

export function customTexKey(id) { return CUSTOM_PREFIX + id; }
export function isCustomTexKey(key) { return typeof key === 'string' && key.startsWith(CUSTOM_PREFIX); }
export function customIdFromTexKey(key) { return key.slice(CUSTOM_PREFIX.length); }

// Phaser's TextureManager is shared game-wide (every scene's `this.textures`
// is the same instance), so a texture registered from one scene is already
// `exists()` in every other — this map just dedupes concurrent registration
// attempts for the same key across scenes, not per-scene state.
const pending = new Map();

/**
 * Registers a CustomSprite's base64 image as a texture, resolving once it's
 * actually decoded and usable (addBase64 returns before the browser has
 * finished decoding the image, so callers must await this rather than using
 * the texture on the very next line).
 */
export function registerCustomSprite(scene, customSprite) {
  const key = customTexKey(customSprite.id);
  if (scene.textures.exists(key)) return Promise.resolve(key);
  if (pending.has(key)) return pending.get(key);

  const promise = new Promise((resolve, reject) => {
    const onAdd = (addedKey) => {
      if (addedKey !== key) return;
      scene.textures.off(Phaser.Textures.Events.ADD, onAdd);
      scene.textures.off(Phaser.Textures.Events.ERROR, onError);
      pending.delete(key);
      resolve(key);
    };
    const onError = (erroredKey) => {
      if (erroredKey !== key) return;
      scene.textures.off(Phaser.Textures.Events.ADD, onAdd);
      scene.textures.off(Phaser.Textures.Events.ERROR, onError);
      pending.delete(key);
      reject(new Error(`Failed to decode custom sprite "${customSprite.name || customSprite.id}"`));
    };
    scene.textures.on(Phaser.Textures.Events.ADD, onAdd);
    scene.textures.on(Phaser.Textures.Events.ERROR, onError);
    scene.textures.addBase64(key, customSprite.dataURL);
  });
  pending.set(key, promise);
  return promise;
}

/** Registers every custom sprite in a list, in parallel; failures don't block the others. */
export async function registerCustomSprites(scene, customSprites) {
  await Promise.all((customSprites || []).map(cs => registerCustomSprite(scene, cs).catch(() => null)));
}

/**
 * Resolves a component to the {key, frame} its sprite should be drawn from.
 * `frame` is left undefined for custom sprites — addBase64 textures have a
 * single, unnamed default frame, and passing an explicit numeric frame index
 * that may not exist would throw where omitting it (Phaser's own "use the
 * texture's default frame" convention, same as `this.add.image(x,y,key)`
 * with no frame arg elsewhere in this codebase) just works.
 */
export function componentTextureRef(component) {
  return component.custom
    ? { key: customTexKey(component.customId), frame: undefined }
    : { key: component.sheet, frame: component.frame };
}
