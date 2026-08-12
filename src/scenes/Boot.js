import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { SHEETS, CHARACTER_SHEETS, WAITER_SHEETS, SIT_SHEETS, SIT_GEOM, RUN_FRAMES } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { DEFAULT_GUESTS } from '../data/defaults.js';
import { collectLayerFiles } from '../core/AppearanceCompositor.js';
import { loadDefaultMenuItems } from '../data/menu.js';

// Only the generator-layer files actually referenced by guests in the current
// roster get preloaded — same philosophy as CHARACTER_SHEETS only listing the
// 20 named legacy characters, not the whole pack. Custom appearances added
// later via Import are loaded lazily by the Guest Editor / AppearanceCompositor.
function currentRosterAppearances() {
  const guests = Storage.loadGuests() || DEFAULT_GUESTS;
  return guests
    .map(g => g.appearance)
    .filter(a => a?.mode === 'custom' && a.custom)
    .map(a => a.custom);
}

export class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload() {
    const { width, height } = this.scale;
    const barW = Math.min(400, width * 0.7);
    const barX = (width - barW) / 2;
    const barY = height / 2;
    this.add.rectangle(width / 2, barY, barW + 8, 18, 0x000000, 0.4).setStrokeStyle(2, 0x8fb6ff);
    const bar = this.add.rectangle(barX, barY, 0, 14, 0x8fb6ff).setOrigin(0, 0.5);
    const txt = this.add.text(width / 2, barY - 30, 'Loading…', {
      fontFamily: 'system-ui', fontSize: '18px', color: '#c9c9d6'
    }).setOrigin(0.5);

    this.load.on('progress', (p) => {
      bar.width = barW * p;
      txt.setText(`Loading… ${Math.floor(p * 100)}%`);
    });
    this.load.on('complete', () => txt.setText('Starting…'));

    for (const s of SHEETS) this.load.spritesheet(s.key, s.path, { frameWidth: s.frameW, frameHeight: s.frameH });
    for (const c of CHARACTER_SHEETS) this.load.spritesheet(c.key, c.path, { frameWidth: c.frameW, frameHeight: c.frameH });
    for (const w of WAITER_SHEETS) this.load.spritesheet(w.key, w.path, { frameWidth: w.frameW, frameHeight: w.frameH });
    // Sit sheets are sliced manually in create() — load as plain images.
    for (const s of SIT_SHEETS) this.load.image(s.key, s.path);

    // Generator layer files for any custom-appearance guests already in the roster.
    for (const f of collectLayerFiles(currentRosterAppearances())) this.load.image(f.key, f.path);
  }

  // Sit sheets place a 48×96 sprite inside each 96px-wide cell, so the plain
  // 48px grid cuts characters in half. Register the real frame boxes instead.
  registerSitFrames() {
    const { w, h, stride, leftX0, rightX0, perDir } = SIT_GEOM;
    for (const s of SIT_SHEETS) {
      const tex = this.textures.get(s.key);
      if (!tex || tex.frameTotal > 1) continue;
      for (let i = 0; i < perDir; i++) tex.add(i, 0, leftX0 + stride * i, 0, w, h);
      for (let i = 0; i < perDir; i++) tex.add(perDir + i, 0, rightX0 + stride * i, 0, w, h);
    }
  }

  async create() {
    this.registerSitFrames();

    // 1x1 white pixel used as a placeholder texture for editor cells.
    if (!this.textures.exists('__pixel')) {
      const g = this.make.graphics({ x: 0, y: 0 });
      g.fillStyle(0xffffff, 1).fillRect(0, 0, 1, 1);
      g.generateTexture('__pixel', 1, 1);
      g.destroy();
    }

    // Waiter walk animations (Chef_Alex run sheet: 4 dirs × 6 frames).
    if (!this.anims.exists('waiter_down')) {
      for (const [dir, frames] of Object.entries(RUN_FRAMES)) {
        this.anims.create({
          key: `waiter_${dir}`,
          frames: frames.map(f => ({ key: 'waiter_run', frame: f })),
          frameRate: 10, repeat: -1
        });
      }
    }

    // Warm the default-menu cache now so every later loadMenuItems() call
    // (Guest Editor, Menu Editor, Game) resolves instantly from cache.
    await loadDefaultMenuItems();

    document.getElementById('boot-fallback')?.classList.add('hidden');
    this.scene.start('Menu');
  }
}
