import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';

// Touch controls for mobile play: dynamic virtual joystick, action button, menu button,
// and zoom +/− buttons. Rendered on a separate fixed UI camera (no zoom/follow)
// so they stay pinned to the screen regardless of the main game camera's
// position or zoom.

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
    this._joystickPointerId = null;
    this._tapStart = null;
    
    this.visible = false;
    this.objects = [];
    this._resizeBinding = null;
    this.sizes = this.computeSizes();
    this.build();
    this.setupGlobalInput();
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
    const actionBase = narrow ? 48 : 38;
    const safeArea = getSafeAreaInsets();

    return {
      scale,
      ACTION_R: Math.round(actionBase * scale),
      MENU_BTN: Math.round(40 * scale),
      ZOOM_BTN: Math.round(34 * scale),
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
    
    // UI elements will be created at 1.0x base size and scaled in reposition().
    const ACTION_BASE = 38, MENU_BASE = 40, ZOOM_BASE = 34;

    const actionStyle = { fontFamily: 'system-ui', fontSize: '20px', fontStyle: 'bold', color: '#ffe9a8' };
    const menuStyle = { fontFamily: 'system-ui', fontSize: '20px', color: '#e6e6f0' };
    const zoomStyle = { fontFamily: 'system-ui', fontSize: '18px', fontStyle: 'bold', color: '#e6e6f0' };

    // Set UI buttons to a low opacity (0.4) for a clearish look
    const UI_ALPHA = 0.4;

    // --- Dynamic Joystick Graphics ---
    // The joystick base and thumb are drawn at fixed sizes (scaled dynamically if we wanted, but they spawn under the finger)
    this.joystickBase = scene.add.circle(0, 0, 50, 0x2b2b39, UI_ALPHA)
      .setStrokeStyle(2, 0x8fb6ff, UI_ALPHA)
      .setDepth(DEPTH - 1)
      .setVisible(false);
    
    this.joystickThumb = scene.add.circle(0, 0, 24, 0x8fb6ff, UI_ALPHA)
      .setDepth(DEPTH)
      .setVisible(false);
    
    this.objects.push(this.joystickBase, this.joystickThumb);

    // --- Action button (bottom-right) ---
    this.actionBg = scene.add.circle(0, 0, ACTION_BASE, 0x2b2b39, UI_ALPHA)
      .setStrokeStyle(2, 0x8fb6ff, UI_ALPHA)
      .setDepth(DEPTH);
    this.actionTxt = scene.add.text(0, 0, 'E', actionStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1).setAlpha(UI_ALPHA + 0.2); // Text slightly more visible
    this.actionBg.setInteractive();
    this._wireTap(this.actionBg, this.actionTxt, () => this.onInteract());
    this.objects.push(this.actionBg, this.actionTxt);

    // --- Menu button (top-right) ---
    this.menuBg = scene.add.rectangle(0, 0, MENU_BASE, MENU_BASE, 0x2b2b39, UI_ALPHA)
      .setStrokeStyle(2, 0x4a4a5e, UI_ALPHA)
      .setDepth(DEPTH);
    this.menuTxt = scene.add.text(0, 0, '\u2261', menuStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1).setAlpha(UI_ALPHA + 0.2);
    this.menuBg.setInteractive();
    this._wireTap(this.menuBg, this.menuTxt, () => this.onMenu());
    this.objects.push(this.menuBg, this.menuTxt);

    // --- Zoom buttons (right side, stacked vertically above action button) ---
    this.zoomInBg = scene.add.rectangle(0, 0, ZOOM_BASE, ZOOM_BASE, 0x2b2b39, UI_ALPHA)
      .setStrokeStyle(2, 0x6b8fcc, UI_ALPHA)
      .setDepth(DEPTH);
    this.zoomInTxt = scene.add.text(0, 0, '+', zoomStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1).setAlpha(UI_ALPHA + 0.2);
    this.zoomInBg.setInteractive();
    this._wireTap(this.zoomInBg, this.zoomInTxt, () => this.onZoomIn());
    this.objects.push(this.zoomInBg, this.zoomInTxt);

    this.zoomOutBg = scene.add.rectangle(0, 0, ZOOM_BASE, ZOOM_BASE, 0x2b2b39, UI_ALPHA)
      .setStrokeStyle(2, 0x6b8fcc, UI_ALPHA)
      .setDepth(DEPTH);
    this.zoomOutTxt = scene.add.text(0, 0, '\u2212', zoomStyle)
      .setOrigin(0.5).setDepth(DEPTH + 1).setAlpha(UI_ALPHA + 0.2);
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

  setupGlobalInput() {
    // Listen to global pointer events on the scene for the dynamic joystick and tap-to-interact anywhere.
    this.scene.input.on('pointerdown', (pointer, currentlyOver) => {
      // If we clicked on an existing UI element (like the Menu or Action button), ignore it here.
      if (currentlyOver.length > 0) return;
      
      const width = this.scene.scale.width;
      
      // If on the left half of the screen, start the virtual joystick.
      if (pointer.x < width / 2) {
        this._joystickPointerId = pointer.id;
        this.joystickBase.setPosition(pointer.x, pointer.y).setVisible(true);
        this.joystickThumb.setPosition(pointer.x, pointer.y).setVisible(true);
      } else {
        // If on the right half, trigger action immediately.
        this.onInteract();
      }

      // Record tap start to detect quick taps (even on the left side)
      this._tapStart = {
        id: pointer.id,
        time: this.scene.time.now,
        x: pointer.x,
        y: pointer.y
      };
    });

    this.scene.input.on('pointermove', (pointer) => {
      if (this._joystickPointerId === pointer.id) {
        const maxRadius = 40;
        let dx = pointer.x - this.joystickBase.x;
        let dy = pointer.y - this.joystickBase.y;
        
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Cap the thumb distance to maxRadius
        if (dist > maxRadius) {
          dx = (dx / dist) * maxRadius;
          dy = (dy / dist) * maxRadius;
        }
        
        this.joystickThumb.setPosition(this.joystickBase.x + dx, this.joystickBase.y + dy);
        
        // Calculate direction based on angle
        if (dist > 10) { // Small deadzone before recognizing direction
          const angle = Phaser.Math.Angle.Between(0, 0, dx, dy);
          if (angle > -Math.PI/4 && angle <= Math.PI/4) this._heldDir = 'right';
          else if (angle > Math.PI/4 && angle <= 3*Math.PI/4) this._heldDir = 'down';
          else if (angle > -3*Math.PI/4 && angle <= -Math.PI/4) this._heldDir = 'up';
          else this._heldDir = 'left';
        } else {
          this._heldDir = null;
        }
      }
    });

    const onPointerUp = (pointer) => {
      if (this._joystickPointerId === pointer.id) {
        this._joystickPointerId = null;
        this._heldDir = null;
        this.joystickBase.setVisible(false);
        this.joystickThumb.setVisible(false);
      }
      
      // Detect quick tap on the left side to trigger interact
      if (this._tapStart && this._tapStart.id === pointer.id) {
        // Only process left-side taps here, as right-side taps triggered immediately on pointerdown
        if (this._tapStart.x < this.scene.scale.width / 2) {
          const dt = this.scene.time.now - this._tapStart.time;
          const dist = Phaser.Math.Distance.Between(pointer.x, pointer.y, this._tapStart.x, this._tapStart.y);
          if (dt < 250 && dist < 15) {
            this.onInteract();
          }
        }
        this._tapStart = null;
      }
    };

    this.scene.input.on('pointerup', onPointerUp);
    this.scene.input.on('pointercancel', onPointerUp);
  }

  _wireTap(bg, txt, callback) {
    const UI_ALPHA = 0.4;
    const press = () => {
      bg.setFillStyle(0x4a4a5e, UI_ALPHA + 0.2);
      if (txt) txt.setScale(0.9);
    };
    const release = () => {
      bg.setFillStyle(0x2b2b39, UI_ALPHA);
      if (txt) txt.setScale(1);
    };
    bg.on('pointerdown', () => {
      press();
      callback();
    });
    bg.on('pointerup', release);
    bg.on('pointerout', release);
    bg.on('pointercancel', release);
    bg.on('contextmenu', (e) => { e.event?.preventDefault?.(); });
  }

  reposition() {
    // Recalculate size in case the device was rotated/resized across thresholds.
    this.sizes = this.computeSizes();
    const scene = this.scene;
    const { ACTION_R, MENU_BTN, ZOOM_BTN, MARGIN,
            SAFE_BOTTOM, SAFE_RIGHT } = this.sizes;

    // Bottom margin includes safe area for notched phones.
    const botMargin = MARGIN + SAFE_BOTTOM;
    const rightMargin = MARGIN + SAFE_RIGHT;

    // Scale factors based on the 1.0x base sizes used in build().
    const actionScale = ACTION_R / 38;
    const menuScale = MENU_BTN / 40;
    const zoomScale = ZOOM_BTN / 34;

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
