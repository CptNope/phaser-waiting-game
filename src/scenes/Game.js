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

    // UI camera: fixed (no zoom/follow) for HUD + controls. Created before
    // any world objects so we can assign cameraFilter as they're created.
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam.setScroll(0, 0).setZoom(1).setRoundPixels(true);
    this.uiCam.setBackgroundColor('rgba(0,0,0,0)');

    // The editor can paint with any indexed sheet, but Boot only preloads the
    // core ones. Pull in whatever this plan actually references, then redraw.
    this.ensurePlanSheets();

    // Game state — initialized BEFORE setupHUD() since updateHUD() reads these.
    this.guests = [];
    this.queue = [...this.guestDefs];
    this.waitingGroups = [];   // groups waiting at host area, ready to be seated
    this.score = 0;
    this.served = 0;
    this.angry = 0;
    this.shiftTime = 120;
    this.shiftActive = true;
    this.carrying = null;
    this.preparedOrder = null;
    this.spawnTimer = 0;
    this.spawnEvery = 8;       // seconds between guest group arrivals

    this.renderFloor();
    this.spawnWaiter();
    this.setupInput();
    this.setupHUD();
    this.setupCamera();
    this.setupMobileControls();

    this.time.addEvent({ delay: 1000, loop: true, callback: this.tickShift, callbackScope: this });
    this.events.on('shutdown', () => {
      this.input.keyboard?.destroy?.();
      this.mobileControls?.destroy();
      this.scale.off('resize', this._resizeCb);
      this.cameras.remove(this.uiCam);
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
    // World objects render only on the main (zoomed/following) camera.
    this.worldOnly(this.floorTiles);
  }

  spawnWaiter() {
    const s = this.plan.spawn || { x: 1, y: 1 };
    this.waiter = this.add.sprite(s.x * TILE + TILE / 2, s.y * TILE + TILE / 2, 'waiter_idle', IDLE_FRAME_DOWN).setOrigin(0.5, CHAR_ORIGIN_Y).setDepth(10);
    this.waiter.tileX = s.x;
    this.waiter.tileY = s.y;
    this.waiter.facing = 'down';
    this.moving = false;
    this.worldOnly(this.waiter);
  }

  setupInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D,E');
    this.input.keyboard.on('keydown-E', () => this.interact());
    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));
  }

  /**
   * Mark objects as UI-only: hidden from the main (zoomed/following) camera,
   * visible only on the fixed UI camera.
   */
  uiOnly(...objs) {
    const flat = objs.flat().filter(o => o);
    if (flat.length) this.cameras.main.ignore(flat);
  }

  /**
   * Mark objects as world-only: hidden from the UI camera, visible only on
   * the main camera. Call this for every world object (floor tiles, waiter,
   * guest sprites, patience bars, order bubbles).
   */
  worldOnly(...objs) {
    const flat = objs.flat().filter(o => o);
    if (flat.length) this.uiCam.ignore(flat);
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
    // Resize UI camera to match viewport so UI objects fill the screen.
    this.uiCam.setSize(vw, vh);
    this.repositionHUD();
    // Padding: HUD bar at top, D-pad + action button at bottom.
    const narrow = vw < 900;
    const padTop = 44, padBottom = 140, padSide = narrow ? 10 : 40;
    const availW = vw - padSide * 2;
    const availH = vh - padTop - padBottom;
    // Show as much of the world as fits, but keep each 48px tile between
    // 24 and 96 screen pixels (zoom 0.5x - 2.0x). 24px is the practical
    // minimum for small phones; 96px is the max before the view feels
    // too zoomed-in on large desktops.
    const fullWorldZoom = Math.min(availW / this.worldW, availH / this.worldH);
    const zoom = Phaser.Math.Clamp(fullWorldZoom, 24 / TILE, 96 / TILE);
    cam.setZoom(zoom);
    // Round to nearest pixel to keep pixel art crisp at integer-ish zooms.
    cam.setRoundPixels(true);
    cam.startFollow(this.waiter, true, 0.12, 0.12);
  }

  setupMobileControls() {
    this.mobileControls = new MobileControls(this, {
      onInteract: () => this.interact(),
      onMenu: () => this.scene.start('Menu')
    });
    // Controls render only on the fixed UI camera.
    this.uiOnly(this.mobileControls.objects);
  }

  /** Calculate responsive HUD font size (px) based on viewport width. */
  hudFontSize() {
    const w = this.scale.width;
    if (w < 600) return 12;
    if (w < 900) return 14;
    return 16;
  }

  /** Reposition HUD elements after a viewport resize. */
  repositionHUD() {
    const w = this.scale.width, h = this.scale.height;
    const mainFont = `${this.hudFontSize()}px`;
    const hintFont = `${Math.max(10, this.hudFontSize() - 2)}px`;
    this.hudBg?.setSize(w, 36);
    this.scoreText?.setPosition(12, 8);
    this.scoreText?.setFontSize(mainFont);
    this.timeText?.setPosition(w / 2, 8);
    this.timeText?.setFontSize(mainFont);
    this.carryText?.setPosition(w - 12, 8);
    this.carryText?.setFontSize(mainFont);
    this.hintText?.setPosition(w / 2, h - 24);
    this.hintText?.setFontSize(hintFont);
  }

  setupHUD() {
    const mainFont = `${this.hudFontSize()}px`;
    const hintFont = `${Math.max(10, this.hudFontSize() - 2)}px`;
    this.hudBg = this.add.rectangle(0, 0, this.scale.width, 36, 0x000000, 0.55).setOrigin(0).setDepth(1000);
    this.scoreText = this.add.text(12, 8, '', { fontFamily: 'system-ui', fontSize: mainFont, color: '#ffe9a8' }).setDepth(1001);
    this.timeText = this.add.text(this.scale.width / 2, 8, '', { fontFamily: 'system-ui', fontSize: mainFont, color: '#e6e6f0' }).setOrigin(0.5, 0).setDepth(1001);
    this.carryText = this.add.text(this.scale.width - 12, 8, '', { fontFamily: 'system-ui', fontSize: mainFont, color: '#9aff9a' }).setOrigin(1, 0).setDepth(1001);
    this.hintText = this.add.text(this.scale.width / 2, this.scale.height - 24, '', { fontFamily: 'system-ui', fontSize: hintFont, color: '#8fb6ff' }).setOrigin(0.5).setDepth(1001);
    // HUD renders only on the fixed UI camera — no zoom/follow distortion.
    this.uiOnly([this.hudBg, this.scoreText, this.timeText, this.carryText, this.hintText]);
    this.updateHUD();
  }

  updateHUD() {
    const waiting = this.waitingGroups.reduce((n, g) => n + g.length, 0);
    const parts = [`Served ${this.served}`, `Angry ${this.angry}`, `Score ${this.score}`];
    if (waiting > 0) parts.push(`Waiting ${waiting}`);
    this.scoreText.setText(parts.join('  •  '));
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
      this.spawnGuestGroup(def);
    }
  }

  /**
   * Spawn a group of guests at the door. They walk to the waiting area
   * (near the host stand) and wait there until the waiter seats them.
   * If no host stand exists, fall back to direct seating (legacy behavior).
   */
  spawnGuestGroup(leaderDef) {
    const door = this.plan.door || { x: 1, y: 0 };
    const groupSize = leaderDef.groupSize || 1;
    const group = [];

    // Collect groupSize guests from the queue (leader + followers).
    // If queue runs out, the group is smaller.
    const defs = [leaderDef];
    for (let i = 1; i < groupSize && this.queue.length > 0; i++) {
      defs.push(this.queue.shift());
    }

    for (const def of defs) {
      const keys = charKeys(def.charName || 'Adam');
      const g = {
        def,
        state: 'incoming',
        seat: null,
        table: null,
        sprite: this.add.image(door.x * TILE + TILE / 2, door.y * TILE + TILE / 2, keys.idle, IDLE_FRAME_DOWN).setOrigin(0.5, CHAR_ORIGIN_Y).setDepth(10),
        idleKey: keys.idle,
        sitKey: keys.sit,
        patience: def.patience,
        maxPatience: def.patience,
        patienceBar: null,
        patienceFill: null,
        orderBubble: null,
        group: null,       // set below
        waitSpot: null,    // tile in waiting area
      };
      this.guests.push(g);
      this.worldOnly(g.sprite);
      group.push(g);
    }
    for (const g of group) g.group = group;

    // If no host stand, fall back to direct seating (legacy).
    if (!this.plan.host) {
      this.seatGroupDirectly(group);
      return;
    }

    // Walk to waiting area near the host stand.
    this.assignWaitingSpots(group);
  }

  /** Legacy path: no host stand — seat guests directly at free seats. */
  seatGroupDirectly(group) {
    for (const g of group) {
      const seat = this.findFreeSeat();
      if (!seat) { this.queue.push(g.def); this.guests = this.guests.filter(x => x !== g); g.sprite.destroy(); continue; }
      g.seat = seat;
      g.table = seat.table;
      this.walkGuestTo(g, seat.x, seat.y, () => this.onGuestSeated(g));
    }
  }

  /** Assign each guest in a group a spot in the waiting area near the host. */
  assignWaitingSpots(group) {
    const host = this.plan.host;
    // Find walkable tiles near the host stand for waiting.
    const spots = this.findWaitingSpots(host, group.length);
    for (let i = 0; i < group.length; i++) {
      const g = group[i];
      const spot = spots[i] || spots[0] || host;
      g.waitSpot = spot;
      g.state = 'walking_to_wait';
      this.walkGuestTo(g, spot.x, spot.y, () => {
        g.state = 'waiting';
        // Show patience bar while waiting
        if (!g.patienceBar) {
          g.patienceBar = this.add.rectangle(g.sprite.x, g.sprite.y - 80, 36, 5, 0x000000, 0.5).setDepth(50);
          g.patienceFill = this.add.rectangle(g.sprite.x - 18, g.sprite.y - 80, 36, 5, 0x8fb6ff).setOrigin(0, 0.5).setDepth(51);
          this.worldOnly(g.patienceBar, g.patienceFill);
        }
      });
    }
    this.waitingGroups.push(group);
  }

  /** Find walkable tiles near the host stand for waiting guests. */
  findWaitingSpots(host, count) {
    const spots = [];
    const seen = new Set();
    const queue = [{ x: host.x, y: host.y, dist: 0 }];
    while (spots.length < count && queue.length) {
      const cur = queue.shift();
      const k = cur.y * this.cols + cur.x;
      if (seen.has(k)) continue;
      seen.add(k);
      // Don't use the host stand tile itself or solid tiles
      if (!(cur.x === host.x && cur.y === host.y) && !this.solids[k]) {
        spots.push({ x: cur.x, y: cur.y });
      }
      // BFS neighbors
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const nk = ny * this.cols + nx;
        if (seen.has(nk)) continue;
        queue.push({ x: nx, y: ny, dist: cur.dist + 1 });
      }
    }
    return spots;
  }

  /**
   * Waiter interacts with host stand: seat the next waiting group at a
   * free table with enough seats for the whole group.
   */
  seatNextGroup() {
    if (this.waitingGroups.length === 0) {
      this.hint('No guests waiting to be seated.');
      return;
    }
    const group = this.waitingGroups[0];
    // Find a table with enough free seats for the whole group.
    const table = this.findFreeTableForGroup(group.length);
    if (!table) {
      this.hint('No free table big enough for this group.');
      return;
    }
    this.waitingGroups.shift();
    const seats = this.findFreeSeatsForTable(table, group.length);
    for (let i = 0; i < group.length; i++) {
      const g = group[i];
      const seat = seats[i];
      if (!seat) continue;
      g.seat = seat;
      g.table = table;
      g.state = 'walking_to_seat';
      // Remove waiting patience bar
      if (g.patienceBar) { g.patienceBar.destroy(); g.patienceFill.destroy(); g.patienceBar = null; g.patienceFill = null; }
      this.walkGuestTo(g, seat.x, seat.y, () => this.onGuestSeated(g));
    }
    this.hint(`Seated party of ${group.length} at table (${table.x},${table.y}).`);
  }

  /** Called when a guest arrives at their seat. */
  onGuestSeated(g) {
    g.state = 'seated';
    const sitDir = this.sitFacing(g.seat, g.table);
    g.sprite.setTexture(g.sitKey, SIT_FRAMES[sitDir]);
    g.sprite.setOrigin(0.5, CHAR_ORIGIN_Y);
    g.sprite.flipX = false;
    // Reset patience to full when seated (waiting patience was separate)
    g.patience = g.def.patience;
    g.maxPatience = g.def.patience;
    g.patienceBar = this.add.rectangle(g.sprite.x, g.sprite.y - 80, 36, 5, 0x000000, 0.5).setDepth(50);
    g.patienceFill = this.add.rectangle(g.sprite.x - 18, g.sprite.y - 80, 36, 5, 0x6cff6c).setOrigin(0, 0.5).setDepth(51);
    this.worldOnly(g.patienceBar, g.patienceFill);
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

  /** Find a table with at least `count` free adjacent seats. */
  findFreeTableForGroup(count) {
    for (const t of this.plan.tables) {
      const seats = this.countFreeSeatsForTable(t);
      if (seats >= count) return t;
    }
    // If no table has enough seats, find the one with the most free seats
    // (as long as it has at least 1)
    let best = null, bestCount = 0;
    for (const t of this.plan.tables) {
      const seats = this.countFreeSeatsForTable(t);
      if (seats > bestCount) { best = t; bestCount = seats; }
    }
    return best && bestCount > 0 ? best : null;
  }

  countFreeSeatsForTable(t) {
    const adj = [[t.x, t.y - 1], [t.x, t.y + 1], [t.x - 1, t.y], [t.x + 1, t.y]];
    let count = 0;
    for (const [ax, ay] of adj) {
      if (ax < 0 || ay < 0 || ax >= this.cols || ay >= this.rows) continue;
      if (this.solids[this.idx(ax, ay)]) continue;
      if (this.guests.some(g => g.seat && g.seat.x === ax && g.seat.y === ay)) continue;
      count++;
    }
    return count;
  }

  /** Get up to `count` free seats adjacent to a table. */
  findFreeSeatsForTable(t, count) {
    const adj = [[t.x, t.y - 1], [t.x, t.y + 1], [t.x - 1, t.y], [t.x + 1, t.y]];
    const seats = [];
    for (const [ax, ay] of adj) {
      if (seats.length >= count) break;
      if (ax < 0 || ay < 0 || ax >= this.cols || ay >= this.rows) continue;
      if (this.solids[this.idx(ax, ay)]) continue;
      if (this.guests.some(g => g.seat && g.seat.x === ax && g.seat.y === ay)) continue;
      seats.push({ x: ax, y: ay, table: t });
    }
    return seats;
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
      if (g.state === 'waiting' || g.state === 'seated' || g.state === 'ordered') {
        g.patience -= dt;
        if (g.patience <= 0) {
          this.guestLeavesAngry(g);
        } else if (g.patienceBar) {
          const ratio = Phaser.Math.Clamp(g.patience / g.maxPatience, 0, 1);
          g.patienceFill.width = 36 * ratio;
          // Waiting guests show blue→yellow; seated show green→red
          if (g.state === 'waiting') {
            g.patienceFill.fillColor = ratio > 0.5 ? 0x8fb6ff : (ratio > 0.25 ? 0xffe9a8 : 0xff6c6c);
          } else {
            g.patienceFill.fillColor = ratio > 0.5 ? 0x6cff6c : (ratio > 0.25 ? 0xffe9a8 : 0xff6c6c);
          }
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

    // Host stand: seat the next waiting group
    const h = this.plan.host;
    if (h && h.x === fx && h.y === fy) {
      this.seatNextGroup();
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
    this.worldOnly(g.orderBubble, bg, icon);
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
    if (g.patienceBar) { g.patienceBar.destroy(); g.patienceFill.destroy(); g.patienceBar = null; g.patienceFill = null; }
    // Remove from waiting groups if still waiting
    if (g.group && g.state === 'waiting') {
      this.waitingGroups = this.waitingGroups.filter(grp => grp !== g.group);
    }
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
    if (this.queue.length === 0 && this.guests.length === 0 && this.waitingGroups.length === 0) this.endShift();
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
    this.waitingGroups = [];
  }

  hint(msg) {
    this.hintText.setText(msg);
    this.time.delayedCall(3000, () => { if (this.hintText) this.hintText.setText(''); });
  }
}
