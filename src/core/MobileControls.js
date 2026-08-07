import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';

// Touch controls for mobile play: virtual D-pad, action button, menu button,
// and zoom +/− buttons. Rendered on a separate fixed UI camera (no zoom/follow)
// so they stay pinned to the screen regardless of the main game camera's
// position or zoom.

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

/**
 * Read CSS safe-area insets via a temporary element. Returns pixel values
 * for bottom, left, right (top is rarely needed for controls).
 */
function getSafeAreaInsets() {
  try {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;' +
      'padding-bottom:env(safe-area-inset-bottom,0px);' +
      'padding-left:env(safe-area-inset-left,0px);' +
      'padding-right:env(safe-area-inset-right,0px);visibility:hidden;';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const insets = {
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
      right: parseFloat(cs.paddingRight) || 0
    };
    document.body.removeChild(el);
    return insets;
  } catch {
    return { bottom: 0, left: 0, right: 0 };
  }
}

export class MobileControls {
  /**
   * @param {Phaser.Scene} scene
   * @param {{ onInteract: Function, onMenu: Function, onZoomIn?: Function, onZoomOut?: Function }} callbacks
   */
  constructor(scene, { onInteract, onMenu, onZoomIn, onZoomOut }) {
    this.scene = scene;
    this.onInteract = onInteract || (() => {});
    this.onMenu = onMenu || (() => {});
    this.onZoomIn = onZoomIn || (() => {});
    this.onZoomOut = onZoomOut || (() => {});
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
    const w = this.scene?.scale?.width || 800;
    const h = this.scene?.scale?.height || 600;
    const short = Math.min(w, h);
    const narrow = w < 900;

    // Larger base sizes on small screens for better touch targets.
    // Scale based on the shorter viewport side, with wider clamp range.
    const scale = Phaser.Math.Clamp(short / 550, 0.9, 1.4);
    const dpadBase = narrow ? 64 : 56;
    const actionBase = narrow ? 48 : 38;
    const safeArea = getSafeAreaInsets();

    return {
      scale,
      DPAD_BTN: Math.round(dpadBase * scale),
      DPAD_GAP: Math.max(2, Math.round(4 * scale)),
      ACTION_R: Math.round(actionBase * scale),
      MENU_BTN: Math.round(40 * scale),
      ZOOM_BTN: Math.round(34 * scale),
      DPAD_FONT: Math.round(24 * scale),
      ACTION_FONT: Math.round(20 * scale),
      MENU_FONT: Math.round(20 * scale),
      ZOOM_FONT: Math.round(18 * scale),
      MARGIN: Math.max(10, Math.round(18 * scale)),
      SAFE_BOTTOM: safeArea.bottom,
      SAFE_LEFT: safeArea.left,
      SAFE_RIGHT: safeArea.right
    };
  }

  build() {
    const scene = this.scene;
    const DEPTH = 2000;
    // Create at the base 1.0x size; reposition() applies the correct scale
    // for the current viewport and every resize.
    const DPAD_BASE = 56, DPAD_GAP = 4, ACTION_BASE = 38, MENU_BASE = 40, ZOOM_BASE = 34;
    const MARGIN = 16, DPAD_UNIT = DPAD_BASE + DPAD_GAP;

    const style = {
      fontFamily: 'system-ui', fontSize: '24px', fontStyle: 'bold', color: '#e6e6f0'
    };
    const actionStyle = {
      fontFamily: 'system-ui', fontSize: '20px', fontStyle: 'bold', color: '#ffe9a8'
    };
    const menuStyle = {
      fontFamily: 'system-ui', fontSize: '20px', color: '#e6e6f0'
    };
    const zoomStyle = {
      fontFamily: 'system-ui', fontSize: '18px', fontStyle: 'bold', color: '#e6e6f0'
    };

    // --- D-pad (bottom-left, cross layout) ---
    const dpadOriginX = MARGIN + DPAD_BASE / 2 + DPAD_UNIT;
    const dpadOriginY = scene.scale.height - MARGIN - DPAD_BASE / 2 - DPAD_UNIT;

    const makeDirBtn = (relX, relY, dir, label) => {
      const x = dpadOriginX + relX * DPAD_UNIT;
      const y = dpadOriginY + relY * DPAD_UNIT;
      const bg = scene.add.rectangle(x, y, DPAD_BASE, DPAD_BASE, 0x2b2b39, 0.8)
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
    this.actionBg = scene.add.circle(0, 0, ACTION_BASE, 0x2b2b39, 0.8)
      .setStrokeStyle(2, 0x8fb6ff)
      .setDepth(DEPTH);
    this.actionTxt = scene.add.text(0, 0, 'E', actionStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1);
    this.actionBg.setInteractive();
    this._wireTap(this.actionBg, this.actionTxt, () => this.onInteract());
    this.objects.push(this.actionBg, this.actionTxt);

    // --- Menu button (top-right) ---
    this.menuBg = scene.add.rectangle(0, 0, MENU_BASE, MENU_BASE, 0x2b2b39, 0.8)
      .setStrokeStyle(2, 0x4a4a5e)
      .setDepth(DEPTH);
    this.menuTxt = scene.add.text(0, 0, '\u2261', menuStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1);
    this.menuBg.setInteractive();
    this._wireTap(this.menuBg, this.menuTxt, () => this.onMenu());
    this.objects.push(this.menuBg, this.menuTxt);

    // --- Zoom buttons (right side, stacked vertically above action button) ---
    this.zoomInBg = scene.add.rectangle(0, 0, ZOOM_BASE, ZOOM_BASE, 0x2b2b39, 0.8)
      .setStrokeStyle(2, 0x6b8fcc)
      .setDepth(DEPTH);
    this.zoomInTxt = scene.add.text(0, 0, '+', zoomStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1);
    this.zoomInBg.setInteractive();
    this._wireTap(this.zoomInBg, this.zoomInTxt, () => this.onZoomIn());
    this.objects.push(this.zoomInBg, this.zoomInTxt);

    this.zoomOutBg = scene.add.rectangle(0, 0, ZOOM_BASE, ZOOM_BASE, 0x2b2b39, 0.8)
      .setStrokeStyle(2, 0x6b8fcc)
      .setDepth(DEPTH);
    this.zoomOutTxt = scene.add.text(0, 0, '\u2212', zoomStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1);
    this.zoomOutBg.setInteractive();
    this._wireTap(this.zoomOutBg, this.zoomOutTxt, () => this.onZoomOut());
    this.objects.push(this.zoomOutBg, this.zoomOutTxt);

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
      bg.setFillStyle(0x4a4a5e, 0.9);
      this._activePointers.set(pointer.id, dir);
      this._heldDir = dir;
    };
    const onUp = (pointer) => {
      bg.setFillStyle(0x2b2b39, 0.8);
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
      bg.setFillStyle(0x4a4a5e, 0.95);
      if (txt) txt.setScale(0.9);
    };
    const release = () => {
      bg.setFillStyle(0x2b2b39, 0.8);
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
    const { DPAD_BTN, DPAD_GAP, ACTION_R, MENU_BTN, ZOOM_BTN, MARGIN,
            SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT } = this.sizes;
    const DPAD_UNIT = DPAD_BTN + DPAD_GAP;

    // Bottom margin includes safe area for notched phones.
    const botMargin = MARGIN + SAFE_BOTTOM;
    const leftMargin = MARGIN + SAFE_LEFT;
    const rightMargin = MARGIN + SAFE_RIGHT;

    // --- D-pad: bottom-left ---
    const dpadOriginX = leftMargin + DPAD_BTN / 2 + DPAD_UNIT;
    const dpadOriginY = scene.scale.height - botMargin - DPAD_BTN / 2 - DPAD_UNIT;

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
    const zoomScale = ZOOM_BTN / 34;

    for (const [dir, [x, y]] of Object.entries(positions)) {
      const btn = this.dpad[dir];
      if (!btn) continue;
      btn.bg.setPosition(x, y);
      btn.bg.setScale(dpadScale);
      btn.txt.setPosition(x, y);
      btn.txt.setFontSize(this.sizes.DPAD_FONT);
    }

    // --- Action button: bottom-right ---
    const actionX = scene.scale.width - rightMargin - ACTION_R;
    const actionY = scene.scale.height - botMargin - ACTION_R - 20;
    this.actionBg.setPosition(actionX, actionY);
    this.actionBg.setScale(actionScale);
    this.actionTxt.setPosition(actionX, actionY);
    this.actionTxt.setFontSize(this.sizes.ACTION_FONT);

    // --- Menu button: top-right ---
    const menuX = scene.scale.width - rightMargin - MENU_BTN / 2;
    const menuY = MARGIN + MENU_BTN / 2 + 36;
    this.menuBg.setPosition(menuX, menuY);
    this.menuBg.setScale(menuScale);
    this.menuTxt.setPosition(menuX, menuY);
    this.menuTxt.setFontSize(this.sizes.MENU_FONT);

    // --- Zoom buttons: right side, stacked above action button ---
    const zoomX = scene.scale.width - rightMargin - ZOOM_BTN / 2;
    const zoomGap = ZOOM_BTN + 8;
    const zoomBaseY = actionY - ACTION_R - 30;
    this.zoomOutBg.setPosition(zoomX, zoomBaseY);
    this.zoomOutBg.setScale(zoomScale);
    this.zoomOutTxt.setPosition(zoomX, zoomBaseY);
    this.zoomOutTxt.setFontSize(this.sizes.ZOOM_FONT);

    this.zoomInBg.setPosition(zoomX, zoomBaseY - zoomGap);
    this.zoomInBg.setScale(zoomScale);
    this.zoomInTxt.setPosition(zoomX, zoomBaseY - zoomGap);
    this.zoomInTxt.setFontSize(this.sizes.ZOOM_FONT);
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
