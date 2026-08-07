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

// Front-of-house NPC. Any name from CHARACTERS works; this one is not in the
// default guest roster so the host is visually distinct from the customers.
const HOST_CHARACTER = 'Conference_woman';

export class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  create() {
    this.plan = Storage.loadPlan() || DEFAULT_FLOOR_PLAN;
    this.guestDefs = Storage.loadGuests() || DEFAULT_GUESTS;
    this.cols = this.plan.cols;
    this.rows = this.plan.rows;
    this.idx = (x, y) => y * this.cols + x;
    this.solids = this.plan.solids.slice();
    // Tables may span several tiles (w/h default to 1). Every tile of the
    // footprint blocks movement; seats are derived from the ring around it.
    for (const t of this.plan.tables) {
      for (const c of this.tableCells(t)) this.solids[this.idx(c.x, c.y)] = true;
    }
    for (const b of (this.plan.benches || [])) this.solids[this.idx(b.x, b.y)] = true;

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
    this.spawnHost();
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

  /**
   * The host is an NPC who works the front of house on their own: they collect
   * the party at the head of the queue, walk them to a table and seat them.
   * They idle on the walkable tile beside the host stand.
   */
  spawnHost() {
    const stand = this.plan.host;
    if (!stand) { this.host = null; return; }
    // Stand beside the podium, but not on a tile the queue wants to use —
    // otherwise the host and the first guest in line overlap.
    const queue = this.waitingSpots();
    const near = this.tilesNear(stand, 6);
    const postTile = near.find(t => !queue.some(q => q.x === t.x && q.y === t.y))
      || near[0] || stand;
    const keys = charKeys(HOST_CHARACTER);
    this.host = {
      post: postTile,
      state: 'idle',        // idle | fetching | escorting | returning
      party: null,
      table: null,
      idleKey: keys.idle,
      sprite: this.add.image(
        postTile.x * TILE + TILE / 2, postTile.y * TILE + TILE / 2,
        keys.idle, IDLE_FRAME_DOWN
      ).setOrigin(0.5, CHAR_ORIGIN_Y).setDepth(11)
    };
    this.worldOnly(this.host.sprite);

    // A small badge so the host reads as staff rather than another guest.
    this.host.badge = this.add.text(this.host.sprite.x, this.host.sprite.y - 78, 'HOST', {
      fontFamily: 'system-ui', fontSize: '10px', fontStyle: 'bold',
      color: '#1b1b22', backgroundColor: '#ffe9a8', padding: { x: 3, y: 1 }
    }).setOrigin(0.5).setDepth(52);
    this.worldOnly(this.host.badge);
  }

  /** Keeps the HOST badge glued above the host sprite. */
  syncHostBadge() {
    if (!this.host?.badge) return;
    this.host.badge.setPosition(this.host.sprite.x, this.host.sprite.y - 78);
  }

  /**
   * Host state machine, ticked every frame. Only starts a new escort when
   * idle, so a party is never handed off mid-walk.
   */
  updateHost() {
    const h = this.host;
    if (!h || h.state !== 'idle') return;
    if (this.waitingGroups.length === 0) return;

    const party = this.waitingGroups[0];
    const table = this.findFreeTableForGroup(party.length);
    if (!table) return;   // full house — try again next tick

    this.waitingGroups.shift();
    h.state = 'fetching';
    h.party = party;
    h.table = table;
    for (const g of party) g.state = 'being_escorted';

    // Walk to the head of the party, then lead them to their table.
    const lead = party[0];
    const meet = lead.waitSpot || h.post;
    this.walkActorTo(h, meet.x, meet.y, () => this.hostEscortToTable());
  }

  /** Host leads the party to the table, guests trailing one tile behind. */
  hostEscortToTable() {
    const h = this.host;
    if (!h.party) { h.state = 'idle'; return; }
    h.state = 'escorting';

    const seats = this.findFreeSeatsForTable(h.table, h.party.length);
    // Host stands at the first seat tile so the walk ends at the table.
    const dest = seats[0] || this.tilesNear(this.tableCenter(h.table), 1)[0];
    if (!dest) { this.releaseParty(); return; }

    let arrived = 0;
    const done = () => {
      if (++arrived < h.party.length + 1) return;
      this.hostReturnToPost();
    };

    this.walkActorTo(h, dest.x, dest.y, done);
    // Guests peel off to their own seats as the host leads the way.
    h.party.forEach((g, i) => {
      const seat = seats[i];
      if (!seat) { done(); return; }
      g.seat = seat;
      g.table = h.table;
      g.state = 'walking_to_seat';
      if (g.patienceBar) {
        g.patienceBar.destroy(); g.patienceFill.destroy();
        g.patienceBar = null; g.patienceFill = null;
      }
      // Stagger departures slightly so the party reads as a group in motion.
      this.time.delayedCall(120 * i, () => {
        this.walkGuestTo(g, seat.x, seat.y, () => { this.onGuestSeated(g); done(); });
      });
    });
    this.hint(`Host is seating a party of ${h.party.length}.`);
  }

  hostReturnToPost() {
    const h = this.host;
    h.party = null;
    h.table = null;
    h.state = 'returning';
    this.walkActorTo(h, h.post.x, h.post.y, () => { h.state = 'idle'; });
  }

  /** Puts a party back at the front of the queue if an escort falls through. */
  releaseParty() {
    const h = this.host;
    if (h.party) {
      for (const g of h.party) g.state = 'waiting';
      this.waitingGroups.unshift(h.party);
      this.reflowWaitingQueue();
    }
    h.party = null;
    h.table = null;
    h.state = 'idle';
  }

  /**
   * Tween any actor with a `sprite` along a BFS path. Shared by the host and
   * guests; the waiter uses its own input-driven movement instead.
   *
   * Re-targeting an actor mid-walk is normal here (the queue re-flows, the host
   * grabs a party), so each call takes a ticket. The previous chain sees a
   * stale ticket on its next hop and stops instead of dragging the sprite back
   * along its old path.
   */
  walkActorTo(actor, tx, ty, onArrive, duration = 110) {
    const ticket = (actor._walkTicket || 0) + 1;
    actor._walkTicket = ticket;
    this.tweens.killTweensOf(actor.sprite);

    const from = {
      x: Math.round((actor.sprite.x - TILE / 2) / TILE),
      y: Math.round((actor.sprite.y - TILE / 2) / TILE)
    };
    const path = this.findPath(from, { x: tx, y: ty });
    if (!path || path.length === 0) {
      actor.sprite.setPosition(tx * TILE + TILE / 2, ty * TILE + TILE / 2);
      this.syncHostBadge();
      onArrive?.();
      return;
    }
    let step = 0;
    const next = () => {
      if (actor._walkTicket !== ticket) return;   // superseded by a newer walk
      if (step >= path.length) { onArrive?.(); return; }
      const node = path[step++];
      const targetX = node.x * TILE + TILE / 2;
      const targetY = node.y * TILE + TILE / 2;
      if (actor.idleKey) {
        if (targetX < actor.sprite.x - 1) actor.sprite.setTexture(actor.idleKey, IDLE_FRAMES.left);
        else if (targetX > actor.sprite.x + 1) actor.sprite.setTexture(actor.idleKey, IDLE_FRAMES.right);
        else if (targetY < actor.sprite.y - 1) actor.sprite.setTexture(actor.idleKey, IDLE_FRAMES.up);
        else if (targetY > actor.sprite.y + 1) actor.sprite.setTexture(actor.idleKey, IDLE_FRAMES.down);
        actor.sprite.flipX = false;
      }
      this.tweens.add({
        targets: actor.sprite,
        x: targetX,
        y: targetY,
        duration,
        onUpdate: () => this.syncHostBadge(),
        onComplete: next
      });
    };
    next();
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
    if (this.host?.party) parts.push(`Seating ${this.host.party.length}`);
    this.scoreText.setText(parts.join('  •  '));
    this.timeText.setText(this.shiftActive ? `Time ${Math.max(0, Math.ceil(this.shiftTime))}s` : 'Shift over');
    this.carryText.setText(this.carrying ? `Carrying: ${MENU_LABELS[this.carrying] || this.carrying}` : 'Hands free');
  }

  update() {
    if (!this.shiftActive) return;
    const dt = Phaser.Math.Clamp(this.game.loop.delta / 1000, 0, 0.1);
    this.handleMovement();
    this.updateGuests(dt);
    this.handleSpawning(dt);
    this.updateHost();
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

  // ------------------------------------------------------------ waiting area

  /**
   * Send a newly arrived party to the waiting area, then re-flow the whole
   * queue so parties stack up in arrival order behind the host stand.
   */
  assignWaitingSpots(group) {
    this.waitingGroups.push(group);
    for (const g of group) g.state = 'walking_to_wait';
    this.reflowWaitingQueue();
  }

  /**
   * Walk every waiting guest to their current queue position. Called when a
   * party arrives or leaves so the line closes up behind them. Guests near the
   * front stand in line; the overflow sits on benches.
   */
  reflowWaitingQueue() {
    const spots = this.waitingSpots();
    let i = 0;
    for (const group of this.waitingGroups) {
      for (const g of group) {
        const spot = spots[i++] || spots[spots.length - 1] || this.plan.host;
        if (!spot) continue;
        // Already standing where we want them — nothing to do.
        if (g.waitSpot && g.waitSpot.x === spot.x && g.waitSpot.y === spot.y &&
            g.state === 'waiting') continue;
        g.waitSpot = spot;
        this.walkGuestTo(g, spot.x, spot.y, () => this.onGuestWaiting(g, spot));
      }
    }
  }

  onGuestWaiting(g, spot) {
    // A party may have been seated while its members were still walking.
    if (g.state !== 'walking_to_wait' && g.state !== 'waiting') return;
    g.state = 'waiting';
    if (spot.bench) {
      // Sitting on a bench: use the sit pose facing the bench.
      g.sprite.setTexture(g.sitKey, SIT_FRAMES[spot.bench.x < spot.x ? 'left' : 'right']);
      g.sprite.setOrigin(0.5, CHAR_ORIGIN_Y);
    } else {
      g.sprite.setTexture(g.idleKey, IDLE_FRAME_DOWN);
      g.sprite.setOrigin(0.5, CHAR_ORIGIN_Y);
    }
    if (!g.patienceBar) {
      g.patienceBar = this.add.rectangle(g.sprite.x, g.sprite.y - 80, 36, 5, 0x000000, 0.5).setDepth(50);
      g.patienceFill = this.add.rectangle(g.sprite.x - 18, g.sprite.y - 80, 36, 5, 0x8fb6ff).setOrigin(0, 0.5).setDepth(51);
      this.worldOnly(g.patienceBar, g.patienceFill);
    } else {
      g.patienceBar.setPosition(g.sprite.x, g.sprite.y - 80);
      g.patienceFill.setPosition(g.sprite.x - 18, g.sprite.y - 80);
    }
  }

  /**
   * Ordered list of places to wait: first the queue line snaking away from the
   * host stand, then the tiles in front of each bench. Cached because the map
   * does not change during a shift.
   */
  waitingSpots() {
    if (this._waitingSpots) return this._waitingSpots;
    const host = this.plan.host;
    const spots = [];
    if (!host) return (this._waitingSpots = spots);

    // Queue line: walk outward from the host stand along the longest open run.
    // Runs that pass through a chokepoint are rejected, otherwise the line
    // would form across the doorway the host has to lead parties through.
    const runs = [[0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => {
      const run = [];
      let x = host.x + dx, y = host.y + dy;
      while (x >= 0 && y >= 0 && x < this.cols && y < this.rows &&
             !this.solids[this.idx(x, y)] && !this.isChokepoint(x, y)) {
        run.push({ x, y });
        x += dx; y += dy;
      }
      return run;
    });
    runs.sort((a, b) => b.length - a.length);
    for (const s of runs[0] || []) spots.push(s);

    // Bench seats: the walkable tile in front of each bench.
    for (const b of (this.plan.benches || [])) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = b.x + dx, y = b.y + dy;
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
        if (this.solids[this.idx(x, y)]) continue;
        if (spots.some(s => s.x === x && s.y === y)) continue;
        spots.push({ x, y, bench: b });
        break;
      }
    }

    // Last resort: any walkable tile near the host stand.
    if (spots.length === 0) spots.push(...this.tilesNear(host, 8));
    return (this._waitingSpots = spots);
  }

  /**
   * True when blocking this tile would cut the floor in two — a doorway or
   * corridor. Used to keep the waiting queue out of the restaurant's passages.
   * Results are memoised; the map does not change during a shift.
   */
  isChokepoint(x, y) {
    this._chokepoints = this._chokepoints || new Map();
    const key = this.idx(x, y);
    if (this._chokepoints.has(key)) return this._chokepoints.get(key);

    // Reachable floor from a neighbour, with (x,y) treated as a wall. If any
    // other neighbour cannot be reached that way, this tile is a chokepoint.
    const open = [];
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      if (!this.solids[this.idx(nx, ny)]) open.push({ x: nx, y: ny });
    }
    let result = false;
    if (open.length > 1) {
      const seen = new Set([key, this.idx(open[0].x, open[0].y)]);
      const stack = [open[0]];
      while (stack.length) {
        const cur = stack.pop();
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          const k = this.idx(nx, ny);
          if (seen.has(k) || this.solids[k]) continue;
          seen.add(k);
          stack.push({ x: nx, y: ny });
        }
      }
      result = open.some(o => !seen.has(this.idx(o.x, o.y)));
    }
    this._chokepoints.set(key, result);
    return result;
  }

  /** BFS out from a tile, returning up to `count` walkable tiles. */
  tilesNear(origin, count) {
    const out = [];
    const seen = new Set([this.idx(origin.x, origin.y)]);
    const queue = [origin];
    while (out.length < count && queue.length) {
      const cur = queue.shift();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const x = cur.x + dx, y = cur.y + dy;
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
        const k = this.idx(x, y);
        if (seen.has(k)) continue;
        seen.add(k);
        if (this.solids[k]) continue;
        out.push({ x, y });
        queue.push({ x, y });
      }
    }
    return out;
  }

  /**
   * The host seats parties on their own, so interacting with the stand just
   * reports the state of the front of house.
   */
  seatNextGroup() {
    if (!this.host) { this.hint('No host on duty.'); return; }
    if (this.host.state !== 'idle') {
      this.hint(`Host is seating a party of ${this.host.party?.length ?? 0}.`);
      return;
    }
    const waiting = this.waitingGroups.reduce((n, g) => n + g.length, 0);
    if (waiting === 0) { this.hint('Nobody waiting to be seated.'); return; }
    const next = this.waitingGroups[0];
    if (!this.findFreeTableForGroup(next.length)) {
      this.hint(`No table free for the next party of ${next.length}.`);
      return;
    }
    this.hint(`${waiting} guest(s) waiting — host is on it.`);
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
  // Multi-tile tables use their center so side seats still face inward.
  sitFacing(seat, table) {
    const c = this.tableCenter(table);
    if (c.x < seat.x) return 'left';
    if (c.x > seat.x) return 'right';
    // Table is directly above/below — use left pose as default.
    return 'left';
  }

  // --------------------------------------------------------- tables & seating

  /** Every tile covered by a table's footprint. w/h default to 1. */
  tableCells(t) {
    const cells = [];
    const w = t.w || 1, h = t.h || 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) cells.push({ x: t.x + dx, y: t.y + dy });
    }
    return cells;
  }

  /** Center of a table footprint, in tile coordinates (may be fractional). */
  tableCenter(t) {
    return { x: t.x + ((t.w || 1) - 1) / 2, y: t.y + ((t.h || 1) - 1) / 2 };
  }

  /**
   * Seats are the walkable tiles orthogonally adjacent to the footprint —
   * the ring around the table minus its corners. A 1×1 table gives 4 seats,
   * 2×1 gives 6, 2×2 gives 8.
   */
  seatsForTable(t) {
    const w = t.w || 1, h = t.h || 1;
    const seats = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
      if (this.solids[this.idx(x, y)]) return;
      seats.push({ x, y, table: t });
    };
    for (let dx = 0; dx < w; dx++) { push(t.x + dx, t.y - 1); push(t.x + dx, t.y + h); }
    for (let dy = 0; dy < h; dy++) { push(t.x - 1, t.y + dy); push(t.x + w, t.y + dy); }
    return seats;
  }

  seatTaken(x, y) {
    return this.guests.some(g => g.seat && g.seat.x === x && g.seat.y === y);
  }

  freeSeatsForTable(t) {
    return this.seatsForTable(t).filter(s => !this.seatTaken(s.x, s.y));
  }

  /** True when no guest is seated at (or heading to) any seat of this table. */
  tableIsEmpty(t) {
    return this.freeSeatsForTable(t).length === this.seatsForTable(t).length;
  }

  findFreeSeat() {
    for (const t of this.plan.tables) {
      const free = this.freeSeatsForTable(t);
      if (free.length) return free[0];
    }
    return null;
  }

  /**
   * Pick a table for a party of `count`. Prefers a still-empty table whose
   * capacity fits the party most snugly, so a couple does not occupy the
   * eight-top while a large party waits. Falls back to any table with enough
   * free seats, then to the table with the most free seats.
   */
  findFreeTableForGroup(count) {
    let best = null, bestWaste = Infinity;
    for (const t of this.plan.tables) {
      const free = this.freeSeatsForTable(t).length;
      if (free < count) continue;
      // Prefer empty tables so parties are not split across strangers.
      const waste = free - count + (this.tableIsEmpty(t) ? 0 : 100);
      if (waste < bestWaste) { best = t; bestWaste = waste; }
    }
    if (best) return best;

    let most = null, mostFree = 0;
    for (const t of this.plan.tables) {
      const free = this.freeSeatsForTable(t).length;
      if (free > mostFree) { most = t; mostFree = free; }
    }
    return mostFree > 0 ? most : null;
  }

  /** Get up to `count` free seats around a table. */
  findFreeSeatsForTable(t, count) {
    return this.freeSeatsForTable(t).slice(0, count);
  }

  walkGuestTo(g, tx, ty, onArrive) {
    this.walkActorTo(g, tx, ty, onArrive, 120);
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

    // Host stand: report on the front of house (the host seats parties itself)
    const hs = this.plan.host;
    if (hs && hs.x === fx && hs.y === fy) {
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
    // Note the old state before overwriting it — a guest who gives up while
    // still queueing has to be pulled out of the waiting line.
    const wasWaiting = g.state === 'waiting' || g.state === 'walking_to_wait';
    g.state = 'angry';
    if (g.orderBubble) { g.orderBubble.destroy(); g.orderBubble = null; }
    if (g.patienceBar) { g.patienceBar.destroy(); g.patienceFill.destroy(); g.patienceBar = null; g.patienceFill = null; }
    if (wasWaiting && g.group) {
      const i = g.group.indexOf(g);
      if (i >= 0) g.group.splice(i, 1);
      if (g.group.length === 0) {
        this.waitingGroups = this.waitingGroups.filter(grp => grp !== g.group);
      }
      this.reflowWaitingQueue();
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
    if (this.queue.length === 0 && this.guests.length === 0 &&
        this.waitingGroups.length === 0 && !this.host?.party) this.endShift();
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
