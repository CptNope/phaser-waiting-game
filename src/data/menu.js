// Runtime access to the default menu (game-assets/default-menu.json) — the
// same shape a user gets from Export Menu / could hand-write and Import.
// Fetched once and cached, same pattern as loadAssetIndex() in assetIndex.js.
import { Storage } from '../core/Storage.js';

const DEFAULT_MENU_URL = 'game-assets/default-menu.json';

let defaultMenuPromise = null;

/** Fetches + caches the default menu item list. */
export function loadDefaultMenuItems() {
  if (!defaultMenuPromise) {
    defaultMenuPromise = fetch(DEFAULT_MENU_URL)
      .then(r => {
        if (!r.ok) throw new Error(`default-menu.json HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.warn('[menu] failed to load default-menu.json:', err.message);
        defaultMenuPromise = null;
        return [];
      });
  }
  return defaultMenuPromise;
}

/** The effective menu: the user's saved/edited list, or the shipped default. */
export async function loadMenuItems() {
  return Storage.loadMenu() || await loadDefaultMenuItems();
}
