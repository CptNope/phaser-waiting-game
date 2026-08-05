import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { TILE, MENU_LABELS, MENU_FRAMES, charKeys, IDLE_FRAMES, IDLE_FRAME_DOWN, SIT_FRAMES, RUN_FRAMES } from '../data/catalog.js';

// All character sprites are 48×96 on a 48px grid. Origin Y=0.75 puts feet at tile bottom.
const CHAR_ORIGIN_Y = 0.75;
import { loadAssetIndex, ensureSheetTexture } from '../data/assetIndex.js';
import { Storage } from '../core/Storage.js';
import { DEFAULT_FLOOR_PLAN, DEFAULT_GUESTS } from '../data/defaults.js';
import { MobileControls } from '../core/MobileControls.js';

const DIRS = {
  up:    { x: 0, y: -1, anim: 'up' },
  down:  { x: 0, y: 1,  anim: 'down' },
  left:  { x: -1, y: 0, anim: 'left' },
  right: { x: 1, y: 0,  anim: 'right' }
};

export class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  create() {
    this.plan = Storage.loadPlan() || DEFAULT_FLOOR_PLAN;
    this.guestDefs = Storage.loadGuests() || DEFAULT_GUESTS;
    this.cols = this.plan.cols;
    this.rows = this.plan.rows;
    this.idx = (x, y) => y * this.cols + x;
    this.solids = this.plan.solids.slice();
    for (const t of this.plan.tables) this.solids[this.idx(t.x, t.y)] = true;

    this.worldW = this.cols * TILE;
    this.worldH = this.rows * TILE;
    this.cameras.main.setBackgroundColor('#1b1b22');

    // The editor can paint with any indexed sheet, but Boot only preloads the
    // core ones. Pull in whatever this plan actually references, then redraw.
    this.ensurePlanSheets();

    this.renderFloor();
    this.spawnWaiter();
    this.setupInput();
    this.setupHUD();
    this.setupCamera();
    this.setupMobileControls();

    this.guests = [];
    this.queue = [...this.guestDefs];
    this.score = 0;
    this.served = 0;
    this.angry = 0;
    this.shiftTime = 120;
    this.shiftActive = true;
    this.carrying = null;
    this.preparedOrder = null;
    this.spawnTimer = 0;
    this.spawnEvery = 6;

    this.time.addEvent({ delay: 1000, loop: true, callback: this.tickShift, callbackScope: this });
    this.events.on('shutdown', () => {
      this.input.keyboard?.destroy?.();
      this.mobileControls?.destroy();
      this.scale.off('resize', this._resizeCb);
    });
  }

  /**
   * Loads any spritesheet referenced by the floor plan that Boot did not
   * preload, then re-renders. Missing sheets are skipped rather than fatal, so
   * a plan referencing a deleted sheet still loads.
   */
  async ensurePlanSheets() {
    const needed = new Set();
    for (const list of [this.plan.ground, this.plan.objects]) {
      for (const cell of list) {
        if (cell?.s && !this.textures.exists(cell.s)) needed.add(cell.s);
      }
    }
    if (!needed.size) return;

    const index = await loadAssetIndex();
    if (!index?.sheets) return;
    const loads = [];
    for (const key of needed) {
      const sheet = index.sheets.find(s => s.key === key);
      if (sheet) loads.push(ensureSheetTexture(this, sheet).catch(() => null));
    }
    if (!loads.length) return;
    await Promise.all(loads);
    if (this.scene.isActive()) this.renderFloor();
  }

  // Safe to call repeatedly: previously drawn tiles are discarded first so that
  // re-rendering after a late sheet load does not stack duplicate sprites.
  renderFloor() {
    this.floorTiles?.forEach(t => t.destroy());
    this.floorTiles = [];
    const draw = (x, y, cell, depth) => {
      if (!cell || !this.textures.exists(cell.s)) return;
      this.floorTiles.push(
        this.add.image(x * TILE, y * TILE, cell.s, cell.f).setOrigin(0, 0).setDepth(depth)
      );
    };

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) draw(x, y, this.plan.ground[this.idx(x, y)], 0);
    }
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) draw(x, y, this.plan.objects[this.idx(x, y)], 1);
    }
    const k = this.plan.kitchen;
    if (k) {
      this.floorTiles.push(
        this.add.image(k.x * TILE + TILE / 2, k.y * TILE + TILE / 2, 'kitchen', 0)
          .setOrigin(0.5).setAlpha(0.85).setDepth(1)
      );
    }
  }

  spawnWaiter() {
    const s = this.plan.spawn || { x: 1, y: 1 };
    this.waiter = this.add.sprite(s.x * TILE + TILE / 2, s.y * TILE + TILE / 2, 'waiter_idle', IDLE_FRAME_DOWN).setOrigin(0.5, CHAR_ORIGIN_Y).setDepth(10);
    this.waiter.tileX = s.x;
    this.waiter.tileY = s.y;
    this.waiter.facing = 'down';
    this.moving = false;
  }

  setupInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D,E');
    this.input.keyboard.on('keydown-E', () => this.interact());
    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));
  }

  /**
   * Camera always follows the waiter. Zoom adapts to screen size:
   * shows ~16×10 tiles on desktop, ~10×7 on mobile, clamped so the
   * world never looks too tiny or too cropped.
   */
  setupCamera() {
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.worldW, this.worldH);
    this._resizeCb = () => this.fitCamera();
    this.scale.on('resize', this._resizeCb);
    this.fitCamera();
  }

  fitCamera() {
    const cam = this.cameras.main;
    const vw = this.scale.width, vh = this.scale.height;
    this.repositionHUD();
    // Target tiles visible: more on wide screens, fewer on narrow.
    const narrow = vw < 900;
    const targetTilesW = narrow ? 10 : 16;
    const targetTilesH = narrow ? 7 : 10;
    // Padding: HUD bar at top, D-pad + action button at bottom.
    const padTop = 44, padBottom = 140, padSide = narrow ? 10 : 40;
    const availW = vw - padSide * 2;
    const availH = vh - padTop - padBottom;
    const targetW = Math.min(targetTilesW, this.cols) * TILE;
    const targetH = Math.min(targetTilesH, this.rows) * TILE;
    // Zoom so the target tile area fits in the available space.
    // Clamp: don't zoom in past 2x (too pixelated) or out past 0.5x (too tiny).
    const zoom = Phaser.Math.Clamp(
      Math.min(availW / targetW, availH / targetH),
      0.5, 2.0
    );
    cam.setZoom(zoom);
    cam.startFollow(this.waiter, true, 0.12, 0.12);
  }

  setupMobileControls() {
    this.mobileControls = new MobileControls(this, {
      onInteract: () => this.interact(),
      onMenu: () => this.scene.start('Menu')
    });
  }

  /** Reposition HUD elements after a viewport resize. */
  repositionHUD() {
    const w = this.scale.width, h = this.scale.height;
    this.hudBg?.setSize(w, 36);
    this.scoreText?.setPosition(12, 8);
    this.timeText?.setPosition(w / 2, 8);
    this.carryText?.setPosition(w - 12, 8);
    this.hintText?.setPosition(w / 2, h - 24);
  }

  setupHUD() {
    this.hudBg = this.add.rectangle(0, 0, this.scale.width, 36, 0x000000, 0.55).setOrigin(0).setDepth(1000).setScrollFactor(0);
    this.scoreText = this.add.text(12, 8, '', { fontFamily: 'system-ui', fontSize: '16px', color: '#ffe9a8' }).setDepth(1001).setScrollFactor(0);
    this.timeText = this.add.text(this.scale.width / 2, 8, '', { fontFamily: 'system-ui', fontSize: '16px', color: '#e6e6f0' }).setOrigin(0.5, 0).setDepth(1001).setScrollFactor(0);
    this.carryText = this.add.text(this.scale.width - 12, 8, '', { fontFamily: 'system-ui', fontSize: '16px', color: '#9aff9a' }).setOrigin(1, 0).setDepth(1001).setScrollFactor(0);
    this.hintText = this.add.text(this.scale.width / 2, this.scale.height - 24, '', { fontFamily: 'system-ui', fontSize: '13px', color: '#8fb6ff' }).setOrigin(0.5).setDepth(1001).setScrollFactor(0);
    this.updateHUD();
  }

  updateHUD() {
    this.scoreText.setText(`Served ${this.served}  •  Angry ${this.angry}  •  Score ${this.score}`);
    this.timeText.setText(this.shiftActive ? `Time ${Math.max(0, Math.ceil(this.shiftTime))}s` : 'Shift over');
    this.carryText.setText(this.carrying ? `Carrying: ${MENU_LABELS[this.carrying] || this.carrying}` : 'Hands free');
  }

  update() {
    if (!this.shiftActive) return;
    this.handleMovement();
    this.updateGuests(Phaser.Math.Clamp(this.game.loop.delta / 1000, 0, 0.1));
    this.handleSpawning(Phaser.Math.Clamp(this.game.loop.delta / 1000, 0, 0.1));
    this.updateHUD();
  }

  handleMovement() {
    if (this.moving) return;
    let dir = null;
    const mDir = this.mobileControls?.heldDir;
    if (mDir) {
      dir = DIRS[mDir] || null;
    } else if (this.cursors.left.isDown || this.wasd.A.isDown) dir = DIRS.left;
    else if (this.cursors.right.isDown || this.wasd.D.isDown) dir = DIRS.right;
    else if (this.cursors.up.isDown || this.wasd.W.isDown) dir = DIRS.up;
    else if (this.cursors.down.isDown || this.wasd.S.isDown) dir = DIRS.down;
    if (!dir) {
      // Stop walk animation when idle, show direction-appropriate idle pose.
      if (this.waiter.anims.isPlaying) {
        this.waiter.anims.stop();
        this.waiter.setTexture('waiter_idle', IDLE_FRAMES[this.waiter.facing] ?? IDLE_FRAME_DOWN);
      }
      return;
    }
    this.waiter.facing = dir.anim;
    const nx = this.waiter.tileX + dir.x;
    const ny = this.waiter.tileY + dir.y;
    if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) return;
    if (this.solids[this.idx(nx, ny)]) return;
    this.moving = true;
    // Run sheet has dedicated directional animations — no flipX needed.
    this.waiter.anims.play(`waiter_${dir.anim}`, true);
    this.tweens.add({
      targets: this.waiter,
      x: nx * TILE + TILE / 2,
      y: ny * TILE + TILE / 2,
      duration: 140,
      onComplete: () => {
        this.waiter.tileX = nx; this.waiter.tileY = ny; this.moving = false;
        this.waiter.anims.stop();
        this.waiter.setTexture('waiter_idle', IDLE_FRAMES[dir.anim] ?? IDLE_FRAME_DOWN);
      }
    });
  }

  handleSpawning(dt) {
    if (this.queue.length === 0) return;
    this.spawnTimer += dt;
    if (this.spawnTimer >= this.spawnEvery) {
      this.spawnTimer = 0;
      const def = this.queue.shift();
      this.spawnGuest(def);
    }
  }

  spawnGuest(def) {
    const door = this.plan.door || { x: 1, y: 0 };
    const seat = this.findFreeSeat();
    if (!seat) { this.queue.push(def); return; }
    const keys = charKeys(def.charName || 'Adam');
    const g = {
      def,
      state: 'incoming',
      seat,
      table: seat.table,
      sprite: this.add.image(door.x * TILE + TILE / 2, door.y * TILE + TILE / 2, keys.idle, IDLE_FRAME_DOWN).setOrigin(0.5, CHAR_ORIGIN_Y).setDepth(10),
      idleKey: keys.idle,
      sitKey: keys.sit,
      patience: def.patience,
      maxPatience: def.patience,
      patienceBar: null,
      orderBubble: null
    };
    this.guests.push(g);
    this.walkGuestTo(g, seat.x, seat.y, () => {
      g.state = 'seated';
      // Swap to sitting sprite (48×96), facing the table.
      const sitDir = this.sitFacing(g.seat, g.table);
      g.sprite.setTexture(g.sitKey, SIT_FRAMES[sitDir]);
      g.sprite.setOrigin(0.5, CHAR_ORIGIN_Y);
      g.sprite.flipX = false;
      g.patienceBar = this.add.rectangle(g.sprite.x, g.sprite.y - 80, 36, 5, 0x000000, 0.5).setDepth(50);
      g.patienceFill = this.add.rectangle(g.sprite.x - 18, g.sprite.y - 80, 36, 5, 0x6cff6c).setOrigin(0, 0.5).setDepth(51);
    });
  }

  // Determine which sit pose to use based on table position relative to seat.
  // Sit sheets only have LEFT/RIGHT poses (side view), so map up/down to nearest side.
  sitFacing(seat, table) {
    if (table.x < seat.x) return 'left';
    if (table.x > seat.x) return 'right';
    // Table is directly above/below — use left pose as default.
    return 'left';
  }

  findFreeSeat() {
    for (const t of this.plan.tables) {
      const adj = [[t.x, t.y - 1], [t.x, t.y + 1], [t.x - 1, t.y], [t.x + 1, t.y]];
      for (const [ax, ay] of adj) {
        if (ax < 0 || ay < 0 || ax >= this.cols || ay >= this.rows) continue;
        if (this.solids[this.idx(ax, ay)]) continue;
        if (this.guests.some(g => g.seat && g.seat.x === ax && g.seat.y === ay)) continue;
        return { x: ax, y: ay, table: t };
      }
    }
    return null;
  }

  walkGuestTo(g, tx, ty, onArrive) {
    const path = this.findPath({ x: Math.round((g.sprite.x - TILE / 2) / TILE), y: Math.round((g.sprite.y - TILE / 2) / TILE) }, { x: tx, y: ty });
    if (!path || path.length === 0) { g.sprite.setPosition(tx * TILE + TILE / 2, ty * TILE + TILE / 2); onArrive(); return; }
    let step = 0;
    const next = () => {
      if (step >= path.length) { onArrive(); return; }
      const node = path[step++];
      const targetX = node.x * TILE + TILE / 2;
      const targetY = node.y * TILE + TILE / 2;
      // Set idle frame based on movement direction.
      if (targetX < g.sprite.x - 1) g.sprite.setTexture(g.idleKey, IDLE_FRAMES.left);
      else if (targetX > g.sprite.x + 1) g.sprite.setTexture(g.idleKey, IDLE_FRAMES.right);
      else if (targetY < g.sprite.y - 1) g.sprite.setTexture(g.idleKey, IDLE_FRAMES.up);
      else if (targetY > g.sprite.y + 1) g.sprite.setTexture(g.idleKey, IDLE_FRAMES.down);
      g.sprite.flipX = false;
      this.tweens.add({
        targets: g.sprite,
        x: targetX,
        y: targetY,
        duration: 120,
        onComplete: next
      });
    };
    next();
  }

  findPath(start, goal) {
    if (start.x === goal.x && start.y === goal.y) return [];
    const key = (x, y) => y * this.cols + x;
    const visited = new Set([key(start.x, start.y)]);
    const queue = [{ x: start.x, y: start.y, prev: null }];
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    let goalNode = null;
    while (queue.length) {
      const cur = queue.shift();
      if (cur.x === goal.x && cur.y === goal.y) { goalNode = cur; break; }
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        if (this.solids[k] && !(nx === goal.x && ny === goal.y)) continue;
        visited.add(k);
        queue.push({ x: nx, y: ny, prev: cur });
      }
    }
    if (!goalNode) return null;
    const path = [];
    let n = goalNode;
    while (n.prev) { path.unshift({ x: n.x, y: n.y }); n = n.prev; }
    return path;
  }

  updateGuests(dt) {
    for (const g of this.guests) {
      if (g.state === 'seated' || g.state === 'ordered') {
        g.patience -= dt;
        if (g.patience <= 0) this.guestLeavesAngry(g);
        else if (g.patienceBar) {
          const ratio = Phaser.Math.Clamp(g.patience / g.maxPatience, 0, 1);
          g.patienceFill.width = 36 * ratio;
          g.patienceFill.fillColor = ratio > 0.5 ? 0x6cff6c : (ratio > 0.25 ? 0xffe9a8 : 0xff6c6c);
        }
      }
    }
  }

  interact() {
    if (!this.shiftActive) return;
    const wx = this.waiter.tileX, wy = this.waiter.tileY;
    const d = DIRS[this.waiter.facing] || DIRS.down;
    const fx = wx + d.x, fy = wy + d.y;

    const k = this.plan.kitchen;
    if (k && k.x === fx && k.y === fy) {
      if (this.carrying) { this.hint('Already carrying something.'); return; }
      if (this.preparedOrder) {
        this.carrying = this.preparedOrder;
        this.preparedOrder = null;
        this.hint(`Picked up ${MENU_LABELS[this.carrying]}.`);
      } else {
        this.hint('No order ready at kitchen.');
      }
      return;
    }

    const g = this.guestAdjacent(fx, fy);
    if (g) {
      if (g.state === 'seated') {
        this.preparedOrder = g.def.order;
        g.state = 'ordered';
        this.showOrderBubble(g);
        this.hint(`Took order: ${MENU_LABELS[g.def.order]}. Ready at kitchen.`);
      } else if (g.state === 'ordered' && this.carrying === g.def.order) {
        this.deliverToGuest(g);
      } else if (g.state === 'ordered') {
        this.hint(`They want ${MENU_LABELS[g.def.order]}.`);
      }
      return;
    }

    this.hint('Nothing to interact with here.');
  }

  guestAdjacent(x, y) {
    return this.guests.find(g => (g.state === 'seated' || g.state === 'ordered') &&
      g.seat && g.seat.x === x && g.seat.y === y);
  }

  showOrderBubble(g) {
    if (g.orderBubble) g.orderBubble.destroy();
    const bx = g.sprite.x, by = g.sprite.y - 88;
    g.orderBubble = this.add.container(bx, by).setDepth(60);
    const bg = this.add.rectangle(0, 0, 40, 28, 0xffffff, 0.9).setStrokeStyle(1, 0x333333);
    const icon = this.add.image(0, 0, 'kitchen', this.menuFrameFor(g.def.order)).setDisplaySize(24, 24);
    g.orderBubble.add([bg, icon]);
  }

  menuFrameFor(id) { return MENU_FRAMES[id] ?? 0; }

  deliverToGuest(g) {
    this.carrying = null;
    g.state = 'served';
    const tip = Math.round(10 + 20 * Phaser.Math.Clamp(g.patience / g.maxPatience, 0, 1));
    this.score += tip;
    this.served += 1;
    this.hint(`Served ${g.def.name}! +${tip}`);
    if (g.orderBubble) { g.orderBubble.destroy(); g.orderBubble = null; }
    if (g.patienceBar) { g.patienceBar.destroy(); g.patienceFill.destroy(); }
    // Swap back to idle sprite (48×48) for walking out.
    g.sprite.setTexture(g.idleKey, IDLE_FRAME_DOWN);
    g.sprite.setOrigin(0.5, CHAR_ORIGIN_Y);
    const door = this.plan.door || { x: 1, y: 0 };
    this.walkGuestTo(g, door.x, door.y, () => {
      g.sprite.destroy();
      this.guests = this.guests.filter(x => x !== g);
      this.checkShiftEnd();
    });
  }

  guestLeavesAngry(g) {
    this.angry += 1;
    this.score = Math.max(0, this.score - 5);
    g.state = 'angry';
    if (g.orderBubble) { g.orderBubble.destroy(); g.orderBubble = null; }
    if (g.patienceBar) { g.patienceBar.destroy(); g.patienceFill.destroy(); }
    g.sprite.setTexture(g.idleKey, IDLE_FRAME_DOWN);
    g.sprite.setOrigin(0.5, CHAR_ORIGIN_Y);
    const door = this.plan.door || { x: 1, y: 0 };
    this.walkGuestTo(g, door.x, door.y, () => {
      g.sprite.destroy();
      this.guests = this.guests.filter(x => x !== g);
      this.checkShiftEnd();
    });
  }

  checkShiftEnd() {
    if (this.queue.length === 0 && this.guests.length === 0) this.endShift();
  }

  tickShift() {
    if (!this.shiftActive) return;
    this.shiftTime -= 1;
    if (this.shiftTime <= 0) this.endShift();
  }

  endShift() {
    this.shiftActive = false;
    this.hint(`Shift over! Served ${this.served}, angry ${this.angry}, score ${this.score}. Tap \u2261 or press ESC for menu.`);
    for (const g of this.guests) {
      if (g.patienceBar) { g.patienceBar.destroy(); g.patienceFill.destroy(); }
      if (g.orderBubble) g.orderBubble.destroy();
    }
  }

  hint(msg) {
    this.hintText.setText(msg);
    this.time.delayedCall(3000, () => { if (this.hintText) this.hintText.setText(''); });
  }
}
