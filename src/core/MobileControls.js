import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';

// Touch controls for mobile play: virtual D-pad, action button, and menu button.
// Rendered on a separate fixed UI camera (no zoom/follow) so they stay pinned
// to the screen regardless of the main game camera's position or zoom.

const DIR_KEYS = { up: 'up', down: 'down', left: 'left', right: 'right' };

export function isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

export function isSmallScreen(w = window.innerWidth) {
  return w < 900;
}

export function shouldShowMobileControls() {
  return isTouchDevice() || isSmallScreen();
}

export class MobileControls {
  /**
   * @param {Phaser.Scene} scene
   * @param {{ onInteract: Function, onMenu: Function }} callbacks
   */
  constructor(scene, { onInteract, onMenu }) {
    this.scene = scene;
    this.onInteract = onInteract || (() => {});
    this.onMenu = onMenu || (() => {});
    this._heldDir = null;
    this._activePointers = new Map(); // pointerId -> dir
    this.visible = false;
    this.objects = [];
    this._resizeBinding = null;
    this.sizes = this.computeSizes();
    this.build();
  }

  get heldDir() { return this._heldDir; }

  computeSizes() {
    // Scale based on the shorter viewport side. The D-pad base (56px) is
    // tuned for ~600px short side. Cap the scale so controls don't get huge
    // on 4K and don't shrink too small on phones.
    const w = this.scene?.scale?.width || 800;
    const h = this.scene?.scale?.height || 600;
    const short = Math.min(w, h);
    const scale = Phaser.Math.Clamp(short / 600, 0.85, 1.3);
    return {
      scale,
      DPAD_BTN: Math.round(56 * scale),
      DPAD_GAP: Math.max(2, Math.round(4 * scale)),
      ACTION_R: Math.round(38 * scale),
      MENU_BTN: Math.round(40 * scale),
      DPAD_FONT: Math.round(24 * scale),
      ACTION_FONT: Math.round(18 * scale),
      MENU_FONT: Math.round(20 * scale),
      MARGIN: Math.max(8, Math.round(16 * scale))
    };
  }

  build() {
    const scene = this.scene;
    const DEPTH = 2000;
    // Create at the base 1.0x size; reposition() applies the correct scale
    // for the current viewport and every resize.
    const DPAD_BASE = 56, DPAD_GAP = 4, ACTION_BASE = 38, MENU_BASE = 40;
    const MARGIN = 16, DPAD_UNIT = DPAD_BASE + DPAD_GAP;

    const style = {
      fontFamily: 'system-ui', fontSize: '24px', fontStyle: 'bold', color: '#e6e6f0'
    };
    const actionStyle = {
      fontFamily: 'system-ui', fontSize: '18px', fontStyle: 'bold', color: '#ffe9a8'
    };
    const menuStyle = {
      fontFamily: 'system-ui', fontSize: '20px', color: '#e6e6f0'
    };

    // --- D-pad (bottom-left, cross layout) ---
    const dpadOriginX = MARGIN + DPAD_BASE / 2 + DPAD_UNIT;
    const dpadOriginY = scene.scale.height - MARGIN - DPAD_BASE / 2 - DPAD_UNIT;

    const makeDirBtn = (relX, relY, dir, label) => {
      const x = dpadOriginX + relX * DPAD_UNIT;
      const y = dpadOriginY + relY * DPAD_UNIT;
      const bg = scene.add.rectangle(x, y, DPAD_BASE, DPAD_BASE, 0x2b2b39, 0.7)
        .setStrokeStyle(2, 0x4a4a5e)
        .setDepth(DEPTH);
      const txt = scene.add.text(x, y, label, style)
        .setOrigin(0.5).setDepth(DEPTH + 1);
      bg.setInteractive({ useHandCursor: false });
      this._wireHold(bg, dir);
      this.objects.push(bg, txt);
      return { bg, txt, dir };
    };

    this.dpad = {
      up:    makeDirBtn(0, -1, 'up',    '\u25B2'),
      down:  makeDirBtn(0,  1, 'down',  '\u25BC'),
      left:  makeDirBtn(-1, 0, 'left',  '\u25C0'),
      right: makeDirBtn(1,  0, 'right', '\u25B6'),
    };

    // --- Action button (bottom-right) ---
    this.actionBg = scene.add.circle(0, 0, ACTION_BASE, 0x2b2b39, 0.7)
      .setStrokeStyle(2, 0x8fb6ff)
      .setDepth(DEPTH);
    this.actionTxt = scene.add.text(0, 0, 'E', actionStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1);
    this.actionBg.setInteractive();
    this._wireTap(this.actionBg, this.actionTxt, () => this.onInteract());
    this.objects.push(this.actionBg, this.actionTxt);

    // --- Menu button (top-right) ---
    this.menuBg = scene.add.rectangle(0, 0, MENU_BASE, MENU_BASE, 0x2b2b39, 0.7)
      .setStrokeStyle(2, 0x4a4a5e)
      .setDepth(DEPTH);
    this.menuTxt = scene.add.text(0, 0, '\u2261', menuStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1);
    this.menuBg.setInteractive();
    this._wireTap(this.menuBg, this.menuTxt, () => this.onMenu());
    this.objects.push(this.menuBg, this.menuTxt);

    // Apply correct scale/position for current viewport.
    this.reposition();

    // Reposition on resize
    this._resizeBinding = scene.scale.on('resize', () => this.reposition());

    // Always visible — on-screen controls are the primary input method.
    this.setVisible(true);
  }

  /**
   * Wire a D-pad button to set heldDir on pointer-down and clear on release.
   * Handles multi-touch: each pointer tracks its own direction.
   */
  _wireHold(bg, dir) {
    const onDown = (pointer) => {
      bg.setFillStyle(0x4a4a5e, 0.85);
      this._activePointers.set(pointer.id, dir);
      this._heldDir = dir;
    };
    const onUp = (pointer) => {
      bg.setFillStyle(0x2b2b39, 0.7);
      this._activePointers.delete(pointer.id);
      this._recomputeHeldDir();
    };
    bg.on('pointerdown', onDown);
    bg.on('pointerup', onUp);
    bg.on('pointerout', onUp);
    bg.on('pointercancel', onUp);
    // Prevent context menu on long-press
    bg.on('contextmenu', (e) => { e.event?.preventDefault?.(); });
  }

  _wireTap(bg, txt, callback) {
    const press = () => {
      bg.setFillStyle(0x4a4a5e, 0.9);
      if (txt) txt.setScale(0.9);
    };
    const release = () => {
      bg.setFillStyle(0x2b2b39, 0.7);
      if (txt) txt.setScale(1);
    };
    bg.on('pointerdown', (pointer) => {
      press();
      callback();
    });
    bg.on('pointerup', release);
    bg.on('pointerout', release);
    bg.on('pointercancel', release);
    bg.on('contextmenu', (e) => { e.event?.preventDefault?.(); });
  }

  _recomputeHeldDir() {
    if (this._activePointers.size === 0) {
      this._heldDir = null;
    } else {
      // Most recently pressed pointer wins
      this._heldDir = [...this._activePointers.values()].pop() || null;
    }
  }

  reposition() {
    // Recalculate size in case the device was rotated/resized across thresholds.
    this.sizes = this.computeSizes();
    const scene = this.scene;
    const { DPAD_BTN, DPAD_GAP, ACTION_R, MENU_BTN, MARGIN } = this.sizes;
    const DPAD_UNIT = DPAD_BTN + DPAD_GAP;

    const dpadOriginX = MARGIN + DPAD_BTN / 2 + DPAD_UNIT;
    const dpadOriginY = scene.scale.height - MARGIN - DPAD_BTN / 2 - DPAD_UNIT;

    const positions = {
      up:    [dpadOriginX,                  dpadOriginY - DPAD_UNIT],
      down:  [dpadOriginX,                  dpadOriginY + DPAD_UNIT],
      left:  [dpadOriginX - DPAD_UNIT,      dpadOriginY],
      right: [dpadOriginX + DPAD_UNIT,      dpadOriginY],
    };
    // Scale factors based on the 1.0x base sizes used in build().
    const dpadScale = DPAD_BTN / 56;
    const actionScale = ACTION_R / 38;
    const menuScale = MENU_BTN / 40;
    for (const [dir, [x, y]] of Object.entries(positions)) {
      const btn = this.dpad[dir];
      if (!btn) continue;
      btn.bg.setPosition(x, y);
      btn.bg.setScale(dpadScale);
      btn.txt.setPosition(x, y);
      btn.txt.setFontSize(this.sizes.DPAD_FONT);
    }

    const actionX = scene.scale.width - MARGIN - ACTION_R;
    const actionY = scene.scale.height - MARGIN - ACTION_R - 20;
    this.actionBg.setPosition(actionX, actionY);
    this.actionBg.setScale(actionScale);
    this.actionTxt.setPosition(actionX, actionY);
    this.actionTxt.setFontSize(this.sizes.ACTION_FONT);

    const menuX = scene.scale.width - MARGIN - MENU_BTN / 2;
    const menuY = MARGIN + MENU_BTN / 2 + 36;
    this.menuBg.setPosition(menuX, menuY);
    this.menuBg.setScale(menuScale);
    this.menuTxt.setPosition(menuX, menuY);
    this.menuTxt.setFontSize(this.sizes.MENU_FONT);
  }

  setVisible(v) {
    this.visible = v;
    for (const o of this.objects) o.setVisible(v);
  }

  destroy() {
    this._resizeBinding?.off();
    for (const o of this.objects) o.destroy();
    this.objects = [];
  }
}
