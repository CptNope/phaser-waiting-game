// Touch controls for mobile play: virtual D-pad, action button, and menu button.
// Renders Phaser game objects with setScrollFactor(0) so they stay fixed on screen
// regardless of camera position. Auto-shows on touch devices or narrow screens.

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
    this.build();
  }

  get heldDir() { return this._heldDir; }

  build() {
    const scene = this.scene;
    const DPAD_BTN = 56;
    const DPAD_GAP = 4;
    const DPAD_UNIT = DPAD_BTN + DPAD_GAP;
    const ACTION_R = 38;
    const MENU_BTN = 40;
    const DEPTH = 2000;

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
    const margin = 16;
    const dpadOriginX = margin + DPAD_BTN / 2 + DPAD_UNIT; // center of cross
    const dpadOriginY = scene.scale.height - margin - DPAD_BTN / 2 - DPAD_UNIT;

    const makeDirBtn = (relX, relY, dir, label) => {
      const x = dpadOriginX + relX * DPAD_UNIT;
      const y = dpadOriginY + relY * DPAD_UNIT;
      const bg = scene.add.rectangle(x, y, DPAD_BTN, DPAD_BTN, 0x2b2b39, 0.7)
        .setStrokeStyle(2, 0x4a4a5e)
        .setDepth(DEPTH)
        .setScrollFactor(0);
      const txt = scene.add.text(x, y, label, style)
        .setOrigin(0.5).setDepth(DEPTH + 1).setScrollFactor(0);
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
    const actionX = scene.scale.width - margin - ACTION_R;
    const actionY = scene.scale.height - margin - ACTION_R - 20;
    this.actionBg = scene.add.circle(actionX, actionY, ACTION_R, 0x2b2b39, 0.7)
      .setStrokeStyle(2, 0x8fb6ff)
      .setDepth(DEPTH)
      .setScrollFactor(0);
    this.actionTxt = scene.add.text(actionX, actionY, 'E', actionStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1).setScrollFactor(0);
    this.actionBg.setInteractive();
    this._wireTap(this.actionBg, this.actionTxt, () => this.onInteract());
    this.objects.push(this.actionBg, this.actionTxt);

    // --- Menu button (top-right) ---
    const menuX = scene.scale.width - margin - MENU_BTN / 2;
    const menuY = margin + MENU_BTN / 2 + 36; // below HUD bar
    this.menuBg = scene.add.rectangle(menuX, menuY, MENU_BTN, MENU_BTN, 0x2b2b39, 0.7)
      .setStrokeStyle(2, 0x4a4a5e)
      .setDepth(DEPTH)
      .setScrollFactor(0);
    this.menuTxt = scene.add.text(menuX, menuY, '\u2261', menuStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1).setScrollFactor(0);
    this.menuBg.setInteractive();
    this._wireTap(this.menuBg, this.menuTxt, () => this.onMenu());
    this.objects.push(this.menuBg, this.menuTxt);

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
    const scene = this.scene;
    const DPAD_BTN = 56;
    const DPAD_GAP = 4;
    const DPAD_UNIT = DPAD_BTN + DPAD_GAP;
    const ACTION_R = 38;
    const MENU_BTN = 40;
    const margin = 16;

    const dpadOriginX = margin + DPAD_BTN / 2 + DPAD_UNIT;
    const dpadOriginY = scene.scale.height - margin - DPAD_BTN / 2 - DPAD_UNIT;

    const positions = {
      up:    [dpadOriginX,                  dpadOriginY - DPAD_UNIT],
      down:  [dpadOriginX,                  dpadOriginY + DPAD_UNIT],
      left:  [dpadOriginX - DPAD_UNIT,      dpadOriginY],
      right: [dpadOriginX + DPAD_UNIT,      dpadOriginY],
    };
    for (const [dir, [x, y]] of Object.entries(positions)) {
      const btn = this.dpad[dir];
      btn.bg.setPosition(x, y);
      btn.txt.setPosition(x, y);
    }

    const actionX = scene.scale.width - margin - ACTION_R;
    const actionY = scene.scale.height - margin - ACTION_R - 20;
    this.actionBg.setPosition(actionX, actionY);
    this.actionTxt.setPosition(actionX, actionY);

    const menuX = scene.scale.width - margin - MENU_BTN / 2;
    const menuY = margin + MENU_BTN / 2 + 36;
    this.menuBg.setPosition(menuX, menuY);
    this.menuTxt.setPosition(menuX, menuY);
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
