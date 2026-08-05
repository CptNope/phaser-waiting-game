// Runtime access to the generated asset index (see tools/index_assets.py).
//
// The index exists so sheets can be used without eyeballing the PNGs: it records
// which frames are non-empty, and groups pixels into multi-tile objects with
// footprints, colors and optional names from game-assets/asset-labels.json.
//
// Only the ~11 KB summary is fetched up front. Per-sheet detail (frame
// occupancy + object lists) and the sheet PNG itself are pulled on demand,
// because the full detail is several megabytes across 31 sheets.

const SUMMARY_URL = 'game-assets/asset-index.json';

let summaryPromise = null;
const detailCache = new Map();
const textureLoads = new Map();

/** Fetches the sheet summary once. Returns { tile, sheets: [...] }. */
export function loadAssetIndex() {
  if (!summaryPromise) {
    summaryPromise = fetch(SUMMARY_URL)
      .then(r => {
        if (!r.ok) throw new Error(`asset index HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        // Keep the editor usable if the index is missing (e.g. not generated yet).
        console.warn('[assetIndex] falling back to eager sheets:', err.message);
        summaryPromise = null;
        return null;
      });
  }
  return summaryPromise;
}

/** Per-sheet detail: { key, cols, rows, frames, objects }. Cached. */
export function loadSheetDetail(sheet) {
  if (!sheet?.detail) return Promise.resolve(null);
  if (!detailCache.has(sheet.key)) {
    detailCache.set(sheet.key, fetch(sheet.detail)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return detailCache.get(sheet.key);
}

/**
 * Ensures a sheet's texture is available in the given scene, loading the PNG at
 * runtime if it was not preloaded in Boot. Resolves to the texture key.
 */
export function ensureSheetTexture(scene, sheet) {
  const { key, path, tile = 48 } = sheet;
  if (scene.textures.exists(key)) return Promise.resolve(key);
  if (textureLoads.has(key)) return textureLoads.get(key);

  const p = new Promise((resolve, reject) => {
    scene.load.spritesheet(key, path, { frameWidth: tile, frameHeight: tile });
    const done = () => { cleanup(); resolve(key); };
    const fail = (file) => {
      if (file?.key && file.key !== key) return;
      cleanup();
      textureLoads.delete(key);
      reject(new Error(`failed to load sheet ${key}`));
    };
    const cleanup = () => {
      scene.load.off('complete', done);
      scene.load.off('loaderror', fail);
    };
    scene.load.once('complete', done);
    scene.load.on('loaderror', fail);
    scene.load.start();
  });
  textureLoads.set(key, p);
  return p;
}

/** Non-empty frame indices for a sheet, ascending. Empty array if unknown. */
export function nonEmptyFrames(detail) {
  if (!detail?.frames) return [];
  return Object.keys(detail.frames).map(Number).sort((a, b) => a - b);
}

/** Looks up the object (if any) that a frame belongs to. */
export function objectAtFrame(detail, frame) {
  if (!detail?.objects) return null;
  return detail.objects.find(o => o.frames.includes(frame)) || null;
}

/**
 * Short human-readable description of a frame, for editor status text.
 * Hand-written frame labels win over detected objects, because touching props
 * merge into a single component (all kitchen counters share one 16x3 object).
 */
export function describeFrame(detail, frame) {
  if (!detail) return `frame ${frame}`;
  const info = detail.frames?.[String(frame)];
  if (!info) return `frame ${frame} (empty)`;
  if (info.name) return `frame ${frame} · ${info.name}`;

  const obj = objectAtFrame(detail, frame);
  if (!obj) return `frame ${frame} · ${Math.round(info.fill * 100)}% filled`;
  const size = `${obj.tiles.w}x${obj.tiles.h}`;
  return `frame ${frame} · ${obj.name || obj.footprint} (${size})`;
}
