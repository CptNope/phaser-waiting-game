import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { TILE, SHEETS } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { Palette } from '../core/Palette.js';
import { DEFAULT_FLOOR_PLAN } from '../data/defaults.js';
import {
  loadAssetIndex, loadSheetDetail, ensureSheetTexture, nonEmptyFrames, describeFrame
} from '../data/assetIndex.js';

const PALETTE_W = 208;
const TOOLBAR_H = 96; // two rows: tools on top, layers/size below

const MIN_COLS = 4, MAX_COLS = 60;
const MIN_ROWS = 4, MAX_ROWS = 40;

// `short` is used when the viewport is too narrow for full labels.
const TOOLS = [
  { id: 'ground',  label: 'Ground',  short: 'Grnd' },
  { id: 'object',  label: 'Object',  short: 'Obj' },
  { id: 'erase',   label: 'Erase',   short: 'Ers' },
  { id: 'solid',   label: 'Solid',   short: 'Sld' },
  { id: 'pick',    label: 'Pick',    short: 'Pick' },
  { id: 'copy',    label: 'Copy',    short: 'Copy' },
  { id: 'paste',   label: 'Paste',   short: 'Paste' },
  { id: 'spawn',   label: 'Spawn',   short: 'Spwn' },
  { id: 'kitchen', label: 'Kitchen', short: 'Ktch' },
  { id: 'bar',     label: 'Bar',     short: 'Bar' },
  { id: 'door',    label: 'Door',    short: 'Door' },
  { id: 'host',    label: 'Host',    short: 'Host' },
  { id: 'bench',   label: 'Bench',   short: 'Bnch' },
  { id: 'table',   label: 'Table',   short: 'Tbl' }
];

// Marker tools that auto-paint the selected object tile when placed.
const MARKER_TOOLS = ['spawn', 'kitchen', 'bar', 'door', 'host', 'bench', 'table'];

// Selectable footprints for the Table tool, in tiles. Seats are the walkable
// tiles around the footprint, so bigger tables seat bigger parties.
const TABLE_SIZES = [
  { w: 1, h: 1, label: '1x1' },
  { w: 2, h: 1, label: '2x1' },
  { w: 1, h: 2, label: '1x2' },
  { w: 2, h: 2, label: '2x2' }
];

const LAYERS = [
  { id: 'ground',  label: 'Ground' },
  { id: 'objects', label: 'Objects' },
  { id: 'markers', label: 'Markers' }
];

export class FloorPlanEditorScene extends Phaser.Scene {
  constructor() { super('FloorPlanEditor'); }

  create() {
    this.cameras.main.setBackgroundColor('#23232c');
    this.plan = Storage.loadPlan() || JSON.parse(JSON.stringify(DEFAULT_FLOOR_PLAN));
    this.tool = 'ground';
    this.selectedFrame = 0;
    this.layers = { ground: true, objects: true, markers: true };
    this.sheetDetail = null;
    // Clipboard for box copy/paste: { w, h, ground: [], objects: [], solids: [] }
    this.clipboard = null;
    // Selection box for copy tool
    this.selection = null;
    // Per-marker tile assignments. When set, placing a marker also paints
    // this tile as an object. null = use current palette selection.
    this.markerTiles = this.plan.markerTiles || {};
    // Footprint used by the Table tool; index into TABLE_SIZES.
    this.tableSizeIdx = 0;
    // When true, newly placed tables are flagged isBar (bar counter/tables).
    this.tableIsBar = false;
    // Benches are a newer feature — older saved plans do not have the array.
    this.plan.benches = this.plan.benches || [];

    // Until the generated index loads, fall back to the sheets Boot preloaded.
    this.sheetList = SHEETS.map(s => ({
      key: s.key, path: s.path, tile: s.frameW, kind: 'objects'
    }));
    this.sheetKey = 'generic';

    const { width, height } = this.scale;
    this.gridX = PALETTE_W + 12;
    this.gridY = TOOLBAR_H + 12;
    this.cols = this.plan.cols;
    this.rows = this.plan.rows;
    this.pendingCols = this.cols;
    this.pendingRows = this.rows;

    this.buildToolbar(width);
    this.buildPalette();
    this.buildGrid();
    this.buildHelp(height);

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));

    // Enable right-click detection for marker tile assignment.
    this.input.mouse.disableContextMenu();

    this.initIndex();
  }

  // ---------------------------------------------------------------- asset index

  async initIndex() {
    const index = await loadAssetIndex();
    if (!index?.sheets?.length) {
      this.setStatus('asset index unavailable — using preloaded sheets');
      return;
    }
    this.sheetList = index.sheets;
    const cur = this.sheetList.findIndex(s => s.key === this.sheetKey);
    this.sheetIdx = cur >= 0 ? cur : 0;
    await this.selectSheet(this.sheetIdx);
  }

  currentSheet() {
    return this.sheetList.find(s => s.key === this.sheetKey) || this.sheetList[0];
  }

  /** Loads a sheet's PNG + detail on demand, then rebuilds the palette. */
  async selectSheet(i) {
    const sheet = this.sheetList[(i + this.sheetList.length) % this.sheetList.length];
    if (!sheet) return;
    this.sheetIdx = this.sheetList.indexOf(sheet);
    this.sheetKey = sheet.key;
    this.refreshSheetLabel('loading…');

    try {
      await ensureSheetTexture(this, sheet);
    } catch (e) {
      this.refreshSheetLabel('load failed');
      this.setStatus(`could not load ${sheet.key}`);
      return;
    }
    this.sheetDetail = await loadSheetDetail(sheet);

    this.selectedFrame = nonEmptyFrames(this.sheetDetail)[0] ?? 0;
    this.palette?.destroy();
    this.buildPalette();
    this.refreshSheetLabel();
    this.refreshMarkerPreviews();
    this.setStatus(describeFrame(this.sheetDetail, this.selectedFrame));
  }

  /** Row 1 stays short; per-sheet counts go in the palette footer instead. */
  refreshSheetLabel(suffix) {
    const n = this.sheetList.length;
    const pos = this.sheetIdx != null ? `${this.sheetIdx + 1}/${n} ` : '';
    this.sheetLabel.setText(`${pos}${this.sheetKey}${suffix ? ` (${suffix})` : ''}`);
    this.refreshPaletteInfo();
  }

  refreshPaletteInfo() {
    if (!this.paletteInfo) return;
    const s = this.currentSheet();
    const parts = [];
    if (s?.theme) parts.push(s.theme.replace(/_/g, ' '));
    if (s?.nonEmptyCount != null) parts.push(`${s.nonEmptyCount} tiles`);
    if (s?.objectCount) parts.push(`${s.objectCount} objects`);
    parts.push('wheel to scroll');
    this.paletteInfo.setText(parts.join(' · '));
  }

  // ------------------------------------------------------------------- toolbar

  buildToolbar(width) {
    this.add.rectangle(0, 0, width, TOOLBAR_H, 0x1b1b22).setOrigin(0, 0).setDepth(100);

    // Right-side actions are laid out first so the tool row knows its budget.
    // Everything on this row shrinks with the viewport: there are 13 tools to
    // fit, so the sheet selector and the action buttons give ground first.
    const narrow = width < 900;
    const actionW = narrow ? 50 : 68, actionGap = narrow ? 4 : 6;
    const actionsW = actionW * 4 + actionGap * 3;
    const actionsX = Math.max(12, width - 12 - actionsW);
    const toolsX = narrow ? 148 : 200;

    // Row 1: sheet selector + tools, sized to whatever space is left.
    this.add.text(12, 6, 'Sheet', { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a' })
      .setDepth(101);
    this.makeBtn(12, 20, 24, 22, '◀', () => this.selectSheet(this.sheetIdx - 1));
    this.makeBtn(38, 20, 24, 22, '▶', () => this.selectSheet(this.sheetIdx + 1));
    this.sheetLabel = this.add.text(68, 25, this.sheetKey, {
      fontFamily: 'system-ui', fontSize: narrow ? '11px' : '13px', color: '#ffe9a8'
    }).setDepth(101);

    // The tool row must never run under the action buttons, so the width is
    // whatever divides the remaining budget; the label drops to its short form
    // and then to a smaller font as the row tightens.
    const gap = 3;
    const budget = Math.max(0, actionsX - 8 - toolsX);
    const btnW = Math.max(14, Math.min(72, Math.floor(budget / TOOLS.length) - gap));
    const useShort = btnW < 58;
    const toolFont = btnW < 30 ? 8 : (btnW < 38 ? 10 : (btnW < 46 ? 11 : 13));

    this.toolBtns = {};
    this.markerPreviews = {};
    TOOLS.forEach((t, i) => {
      const bx = toolsX + i * (btnW + gap);
      const btn = this.makeBtn(bx, 20, btnW, 22,
        useShort ? t.short : t.label, () => this.setTool(t.id), toolFont);
      this.toolBtns[t.id] = btn;
      // Per-marker tile preview: small icon below marker tool buttons.
      // Right-click to assign current palette selection to this marker.
      if (MARKER_TOOLS.includes(t.id)) {
        const pv = this.add.image(bx + btnW - 6, 20 + 22 - 2, '__pixel')
          .setOrigin(0.5).setDisplaySize(12, 12).setDepth(103)
          .setTint(0x4a4a5e);
        pv.setInteractive({ useHandCursor: true });
        pv.on('pointerdown', (pointer) => {
          if (pointer.rightButtonDown()) {
            this.assignMarkerTile(t.id);
          } else {
            this.setTool(t.id);
          }
        });
        pv.on('pointerover', () => {
          const mt = this.markerTiles[t.id];
          this.setStatus(mt ? `${t.id} tile: ${mt.s}#${mt.f}` : `${t.id}: click to use, right-click preview to assign tile`);
        });
        // Prevent context menu on right-click
        pv.on('contextmenu', (e) => { e.event?.preventDefault?.(); });
        this.markerPreviews[t.id] = pv;
      }
    });
    this.refreshToolBtns();
    this.refreshMarkerPreviews();

    // Row 2: layer toggles + grid size.
    let x2 = 12;
    this.add.text(x2, 54, 'Layers', { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a' })
      .setDepth(101);
    x2 += 48;
    this.layerBtns = {};
    LAYERS.forEach((l) => {
      this.layerBtns[l.id] = this.makeBtn(x2, 52, 66, 22, l.label, () => this.toggleLayer(l.id));
      x2 += 70;
    });
    this.refreshLayerBtns();
    x2 += 16;

    this.add.text(x2, 54, 'Size', { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a' })
      .setDepth(101);
    x2 += 34;
    this.makeBtn(x2, 52, 22, 22, '-', () => this.nudgeSize(-1, 0));
    this.makeBtn(x2 + 24, 52, 22, 22, '+', () => this.nudgeSize(1, 0));
    this.makeBtn(x2 + 52, 52, 22, 22, '-', () => this.nudgeSize(0, -1));
    this.makeBtn(x2 + 76, 52, 22, 22, '+', () => this.nudgeSize(0, 1));
    this.sizeLabel = this.add.text(x2 + 104, 57, '', {
      fontFamily: 'system-ui', fontSize: '12px', color: '#e6e6f0'
    }).setDepth(101);
    this.applyBtn = this.makeBtn(x2 + 186, 52, 60, 22, 'Apply', () => this.applyResize());
    this.refreshSizeLabel();
    x2 += 258;

    // Table footprint picker — only meaningful for the Table tool.
    this.add.text(x2, 54, 'Table', { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a' })
      .setDepth(101);
    x2 += 40;
    this.tableSizeBtns = TABLE_SIZES.map((s, i) => {
      const btn = this.makeBtn(x2 + i * 40, 52, 36, 22, s.label, () => this.setTableSize(i));
      return btn;
    });
    this.refreshTableSizeBtns();
    x2 += TABLE_SIZES.length * 40 + 12;

    // Toggle: newly placed tables are flagged isBar (bar counter/tables).
    this.barTableBtn = this.makeBtn(x2, 52, 62, 22, 'Bar Tbl', () => this.toggleTableIsBar());
    this.refreshBarTableBtn();
    x2 += 62 + 12;

    this.statusText = this.add.text(x2, 57, '', {
      fontFamily: 'system-ui', fontSize: '12px', color: '#8fb6ff'
    }).setDepth(101);

    const actions = [
      ['Menu', () => this.scene.start('Menu')],
      ['Import', () => this.importPlan()],
      ['Export', () => Storage.downloadJSON(this.plan, 'floor-plan.json')],
      ['Save', () => this.save()]
    ];
    actions.forEach(([label, fn], i) => {
      this.makeBtn(actionsX + i * (actionW + actionGap), 20, actionW, 22, label, fn);
    });
  }

  makeBtn(x, y, w, h, label, onClick, fontSize) {
    const bg = this.add.rectangle(x, y, w, h, 0x2b2b39).setOrigin(0, 0)
      .setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true }).setDepth(101);
    const size = fontSize ?? Math.min(13, Math.max(10, h - 8));
    const txt = this.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'system-ui', fontSize: size + 'px', color: '#e6e6f0'
    }).setOrigin(0.5).setDepth(102);
    bg.on('pointerover', () => bg.setFillStyle(0x3a3a4d));
    bg.on('pointerout', () => bg.setFillStyle(0x2b2b39));
    bg.on('pointerdown', onClick);
    return { bg, txt };
  }

  setStatus(msg) { this.statusText?.setText(msg || ''); }

  setTool(id) { this.tool = id; this.refreshToolBtns(); }

  /** Choose the footprint the Table tool stamps, and switch to that tool. */
  setTableSize(i) {
    this.tableSizeIdx = i;
    this.refreshTableSizeBtns();
    this.setTool('table');
    const s = TABLE_SIZES[i];
    this.setStatus(`table footprint ${s.label}`);
  }

  refreshTableSizeBtns() {
    this.tableSizeBtns?.forEach((b, i) => {
      const on = i === this.tableSizeIdx;
      b.bg.setFillStyle(on ? 0x4a4a5e : 0x2b2b39);
      b.txt.setColor(on ? '#ffe9a8' : '#e6e6f0');
    });
  }

  /** Toggles whether the Table tool stamps isBar tables (bar counter/tables). */
  toggleTableIsBar() {
    this.tableIsBar = !this.tableIsBar;
    this.refreshBarTableBtn();
    this.setTool('table');
    this.setStatus(this.tableIsBar ? 'placing bar tables' : 'placing regular tables');
  }

  refreshBarTableBtn() {
    if (!this.barTableBtn) return;
    this.barTableBtn.bg.setFillStyle(this.tableIsBar ? 0x5a4a2b : 0x2b2b39);
    this.barTableBtn.txt.setColor(this.tableIsBar ? '#ffb86c' : '#e6e6f0');
  }

  /** Assign the current palette selection as the tile for a marker type. */
  assignMarkerTile(markerType) {
    this.markerTiles[markerType] = { s: this.sheetKey, f: this.selectedFrame };
    this.refreshMarkerPreviews();
    this.setStatus(`${markerType} tile set to ${this.sheetKey}#${this.selectedFrame}`);
  }

  /** Update the small preview icons next to marker tool buttons. */
  refreshMarkerPreviews() {
    for (const id of MARKER_TOOLS) {
      const pv = this.markerPreviews[id];
      if (!pv) continue;
      const tile = this.markerTiles[id];
      if (tile && this.textures.exists(tile.s)) {
        pv.setTexture(tile.s, tile.f).clearTint().setDisplaySize(14, 14);
      } else {
        pv.setTexture('__pixel').setTint(0x4a4a5e).setDisplaySize(12, 12);
      }
    }
  }

  refreshToolBtns() {
    for (const t of TOOLS) {
      const b = this.toolBtns[t.id];
      b.bg.setFillStyle(t.id === this.tool ? 0x4a4a5e : 0x2b2b39);
      b.txt.setColor(t.id === this.tool ? '#ffe9a8' : '#e6e6f0');
    }
  }

  // -------------------------------------------------------------------- layers

  toggleLayer(id) {
    this.layers[id] = !this.layers[id];
    this.refreshLayerBtns();
    this.applyLayerVisibility();
  }

  refreshLayerBtns() {
    for (const l of LAYERS) {
      const b = this.layerBtns[l.id];
      const on = this.layers[l.id];
      b.bg.setFillStyle(on ? 0x3c5a3c : 0x2b2b39);
      b.txt.setColor(on ? '#9aff9a' : '#7a7a8a');
    }
  }

  /** Layer flags only affect display; plan data is untouched. */
  applyLayerVisibility() {
    for (let i = 0; i < this.cols * this.rows; i++) {
      const g = this.cellGround[i], o = this.cellObject[i], m = this.cellMarker[i];
      if (g) g.setVisible(this.layers.ground && !!this.plan.ground[i]);
      if (o) o.setVisible(this.layers.objects && !!this.plan.objects[i]);
      if (m) {
        m.setAlpha(this.layers.markers ? 1 : 0);
        if (m.label) m.label.setVisible(this.layers.markers);
      }
    }
  }

  // --------------------------------------------------------------- grid resize

  nudgeSize(dc, dr) {
    this.pendingCols = Phaser.Math.Clamp(this.pendingCols + dc, MIN_COLS, MAX_COLS);
    this.pendingRows = Phaser.Math.Clamp(this.pendingRows + dr, MIN_ROWS, MAX_ROWS);
    this.refreshSizeLabel();
  }

  refreshSizeLabel() {
    const dirty = this.pendingCols !== this.cols || this.pendingRows !== this.rows;
    this.sizeLabel.setText(`${this.pendingCols}x${this.pendingRows}`);
    this.sizeLabel.setColor(dirty ? '#ffe9a8' : '#e6e6f0');
    this.applyBtn?.txt.setColor(dirty ? '#ffe9a8' : '#7a7a8a');
  }

  applyResize() {
    const nc = this.pendingCols, nr = this.pendingRows;
    if (nc === this.cols && nr === this.rows) return;
    this.resizePlan(nc, nr);
    this.cols = nc;
    this.rows = nr;
    this.gridContainer.destroy();
    this.buildGrid();
    this.refreshSizeLabel();
    this.setStatus(`resized to ${nc}x${nr}`);
  }

  /**
   * Re-lays out the plan arrays for a new grid size. Overlapping cells keep
   * their content; growing pads with empties, shrinking crops. Markers are
   * clamped inside the new bounds and out-of-range tables are dropped.
   */
  resizePlan(nc, nr) {
    const oc = this.cols, or = this.rows;
    const size = nc * nr;
    const ground = new Array(size).fill(null);
    const objects = new Array(size).fill(null);
    const solids = new Array(size).fill(false);

    const copyCols = Math.min(oc, nc);
    const copyRows = Math.min(or, nr);
    for (let y = 0; y < copyRows; y++) {
      for (let x = 0; x < copyCols; x++) {
        const from = y * oc + x;
        const to = y * nc + x;
        ground[to] = this.plan.ground[from] ?? null;
        objects[to] = this.plan.objects[from] ?? null;
        solids[to] = !!this.plan.solids[from];
      }
    }

    this.plan.ground = ground;
    this.plan.objects = objects;
    this.plan.solids = solids;
    this.plan.cols = nc;
    this.plan.rows = nr;
    // Drop tables whose footprint would hang off the resized grid.
    this.plan.tables = (this.plan.tables || [])
      .filter(t => t.x + (t.w || 1) <= nc && t.y + (t.h || 1) <= nr);
    this.plan.benches = (this.plan.benches || []).filter(b => b.x < nc && b.y < nr);
    for (const key of ['spawn', 'kitchen', 'bar', 'door', 'host']) {
      const p = this.plan[key];
      if (p) {
        p.x = Phaser.Math.Clamp(p.x, 0, nc - 1);
        p.y = Phaser.Math.Clamp(p.y, 0, nr - 1);
      }
    }
  }

  // ------------------------------------------------------------------- palette

  buildPalette() {
    const sheet = this.currentSheet();
    if (!sheet || !this.textures.exists(sheet.key)) return;
    const tile = sheet.tile || TILE;

    // Skip blank frames when the index tells us which ones are empty — some
    // sheets are 8500+ frames and rendering every one is far too slow.
    const only = nonEmptyFrames(this.sheetDetail);

    this.palette = new Palette(this, sheet.key, tile, tile,
      (frameIdx) => {
        this.selectedFrame = frameIdx;
        this.setStatus(describeFrame(this.sheetDetail, frameIdx));
      },
      { cols: 4, only });

    const panelX = 8;
    const panelY = TOOLBAR_H + 12;
    const panelW = PALETTE_W - 16;
    const panelH = this.scale.height - panelY - 40;
    this.palette.container.setPosition(panelX, panelY);
    this.palette.container.setDepth(50);

    const maskShape = this.make.graphics({ x: 0, y: 0 });
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, panelY, panelW, panelH);
    this.palette.container.setMask(maskShape.createGeometryMask());

    if (this.paletteWheel) this.input.off('wheel', this.paletteWheel);
    this.paletteWheel = (pointer, over, dx, dy) => {
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = Math.min(panelY, panelY + panelH - this.palette.contentHeight - 8);
      this.palette.container.y =
        Phaser.Math.Clamp(this.palette.container.y - Math.sign(dy) * 60, minY, panelY);
    };
    this.input.on('wheel', this.paletteWheel);

    if (!this.paletteInfo) {
      this.paletteInfo = this.add.text(panelX + 4, this.scale.height - 34, '', {
        fontFamily: 'system-ui', fontSize: '11px', color: '#6b6b7a',
        wordWrap: { width: panelW }
      }).setDepth(60);
    }
    this.refreshPaletteInfo();
  }

  // ---------------------------------------------------------------------- grid

  buildGrid() {
    this.gridContainer = this.add.container(this.gridX, this.gridY).setDepth(10);
    this.cellGround = [];
    this.cellObject = [];
    this.cellMarker = [];

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const cell = this.add.rectangle(x * TILE, y * TILE, TILE, TILE,
          (x + y) % 2 ? 0x2a2a35 : 0x262630).setOrigin(0, 0);
        cell.setInteractive({
          hitArea: new Phaser.Geom.Rectangle(0, 0, TILE, TILE),
          useHandCursor: true
        });
        cell.on('pointerdown', () => {
          if (this.tool === 'copy') this.startSelection(x, y);
          else this.applyTool(x, y);
        });
        cell.on('pointerover', (p) => {
          if (!p.isDown) return;
          if (this.tool === 'copy') this.updateSelection(x, y);
          else this.applyTool(x, y);
        });
        this.gridContainer.add(cell);

        const g = this.add.image(x * TILE, y * TILE, '__pixel').setOrigin(0, 0).setVisible(false);
        const o = this.add.image(x * TILE, y * TILE, '__pixel').setOrigin(0, 0).setVisible(false);
        const m = this.add.rectangle(x * TILE + TILE / 2, y * TILE + TILE / 2,
          TILE - 6, TILE - 6, 0x000000, 0.001).setOrigin(0.5);
        this.gridContainer.add([g, o, m]);
        this.cellGround.push(g);
        this.cellObject.push(o);
        this.cellMarker.push(m);
      }
    }

    const gfx = this.add.graphics().lineStyle(1, 0x3a3a4d, 0.5);
    for (let x = 0; x <= this.cols; x++) gfx.lineBetween(x * TILE, 0, x * TILE, this.rows * TILE);
    for (let y = 0; y <= this.rows; y++) gfx.lineBetween(0, y * TILE, this.cols * TILE, y * TILE);
    this.gridContainer.add(gfx);

    this.fitGrid();
    this.renderAll();

    // Finish copy selection on pointer up (anywhere on the grid)
    this.input.off('pointerup', this._pointerUpCb);
    this._pointerUpCb = () => {
      if (this.tool === 'copy' && this.selection) this.finishSelection();
    };
    this.input.on('pointerup', this._pointerUpCb);
  }

  /** Scales the grid so any size stays fully visible in the available area. */
  fitGrid() {
    const availW = this.scale.width - this.gridX - 12;
    const availH = this.scale.height - this.gridY - 84;
    const scale = Math.min(1, availW / (this.cols * TILE), availH / (this.rows * TILE));
    this.gridScale = scale;
    this.gridContainer.setScale(scale);
  }

  renderAll() {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) this.renderCell(x, y);
    }
  }

  renderCell(x, y) {
    const i = y * this.cols + x;
    const g = this.cellGround[i], o = this.cellObject[i], m = this.cellMarker[i];

    const gv = this.plan.ground[i];
    if (gv && this.textures.exists(gv.s)) {
      g.setTexture(gv.s, gv.f).setVisible(this.layers.ground);
      g.clearTint();
    } else g.setVisible(false);

    const ov = this.plan.objects[i];
    if (ov && this.textures.exists(ov.s)) {
      o.setTexture(ov.s, ov.f).setVisible(this.layers.objects);
      o.clearTint();
    } else o.setVisible(false);

    m.setFillStyle(0x000000, 0.001);
    // `tinted` is separate from `label` so the non-anchor cells of a
    // multi-tile table still get highlighted without repeating the letter.
    let label = null, color = 0xffffff, tinted = false;
    const mark = (text, c) => { label = text; color = c; tinted = true; };

    if (this.plan.spawn?.x === x && this.plan.spawn?.y === y) mark('S', 0x6cff6c);
    else if (this.plan.kitchen?.x === x && this.plan.kitchen?.y === y) mark('K', 0xff8a8a);
    else if (this.plan.bar?.x === x && this.plan.bar?.y === y) mark('BAR', 0xffb86c);
    else if (this.plan.door?.x === x && this.plan.door?.y === y) mark('D', 0x8fb6ff);
    else if (this.plan.host?.x === x && this.plan.host?.y === y) mark('H', 0xff9aff);
    else if (this.plan.benches?.some(b => b.x === x && b.y === y)) mark('B', 0x9ad9ff);
    else {
      const tbl = this.plan.tables?.find(t => this.tableCovers(t, x, y));
      if (tbl) {
        const w = tbl.w || 1, h = tbl.h || 1;
        const anchor = tbl.x === x && tbl.y === y;
        mark(anchor ? (w > 1 || h > 1 ? `${w}x${h}` : 'T') : null, 0xffe9a8);
      }
    }

    if (tinted) m.setFillStyle(color, 0.45);
    if (m.label) { m.label.destroy(); m.label = null; }
    if (label) {
      m.label = this.add.text(m.x, m.y, label, {
        fontFamily: 'system-ui', fontSize: label.length > 1 ? '14px' : '20px',
        fontStyle: 'bold', color: '#111'
      }).setOrigin(0.5).setDepth(20);
      this.gridContainer.add(m.label);
      m.label.setVisible(this.layers.markers);
    }

    if (this.plan.solids[i]) m.setFillStyle(0xff4d4d, 0.25);
    m.setAlpha(this.layers.markers ? 1 : 0);
  }

  applyTool(x, y) {
    const i = y * this.cols + x;
    const t = this.tool;
    if (t === 'ground') this.plan.ground[i] = { s: this.sheetKey, f: this.selectedFrame };
    else if (t === 'object') {
      this.plan.objects[i] = { s: this.sheetKey, f: this.selectedFrame };
      this.plan.solids[i] = false;
    } else if (t === 'erase') {
      this.plan.ground[i] = null;
      this.plan.objects[i] = null;
      this.plan.solids[i] = false;
      // Erasing anywhere inside a table's footprint removes the whole table.
      this.plan.tables = this.plan.tables.filter(p => !this.tableCovers(p, x, y));
      this.plan.benches = this.plan.benches.filter(b => !(b.x === x && b.y === y));
    } else if (t === 'solid') {
      this.plan.solids[i] = !this.plan.solids[i];
    } else if (t === 'pick') {
      this.pickTile(x, y);
      return;
    } else if (t === 'copy') {
      // Handled by drag selection in applyToolStart/applyToolDrag/applyToolEnd
      return;
    } else if (t === 'paste') {
      this.pasteRegion(x, y);
      return;
    } else if (t === 'spawn') {
      this.plan.spawn = { x, y };
      this.autoPaintMarker('spawn', x, y);
    } else if (t === 'kitchen') {
      this.plan.kitchen = { x, y };
      this.autoPaintMarker('kitchen', x, y);
    } else if (t === 'bar') {
      this.plan.bar = { x, y };
      this.autoPaintMarker('bar', x, y);
    } else if (t === 'door') {
      this.plan.door = { x, y };
      this.autoPaintMarker('door', x, y);
    } else if (t === 'host') {
      this.plan.host = { x, y };
      this.autoPaintMarker('host', x, y);
    } else if (t === 'bench') {
      const ex = this.plan.benches.findIndex(b => b.x === x && b.y === y);
      if (ex >= 0) this.plan.benches.splice(ex, 1);
      else {
        this.plan.benches.push({ x, y });
        this.autoPaintMarker('bench', x, y);
      }
    } else if (t === 'table') {
      this.placeTable(x, y);
      return;
    }
    this.renderCell(x, y);
  }

  /** True when (x,y) falls inside a table's footprint. */
  tableCovers(t, x, y) {
    const w = t.w || 1, h = t.h || 1;
    return x >= t.x && x < t.x + w && y >= t.y && y < t.y + h;
  }

  /**
   * Place (or remove) a table using the currently selected footprint. Clicking
   * an existing table removes it; otherwise the footprint is stamped with the
   * table tile as long as it fits inside the grid.
   */
  placeTable(x, y) {
    const ex = this.plan.tables.findIndex(t => this.tableCovers(t, x, y));
    if (ex >= 0) {
      const old = this.plan.tables[ex];
      this.plan.tables.splice(ex, 1);
      this.renderTableCells(old);
      this.setStatus(`removed ${old.w || 1}x${old.h || 1} table`);
      return;
    }
    const { w, h } = TABLE_SIZES[this.tableSizeIdx];
    if (x + w > this.cols || y + h > this.rows) {
      this.setStatus(`${w}x${h} table does not fit here`);
      return;
    }
    // Refuse to overlap an existing table — footprints must stay disjoint.
    for (const t of this.plan.tables) {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          if (this.tableCovers(t, x + dx, y + dy)) {
            this.setStatus('overlaps an existing table');
            return;
          }
        }
      }
    }
    const table = { x, y, w, h, isBar: this.tableIsBar };
    this.plan.tables.push(table);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) this.autoPaintMarker('table', x + dx, y + dy);
    }
    this.renderTableCells(table);
    this.setStatus(`placed ${w}x${h}${this.tableIsBar ? ' bar' : ''} table (${this.seatCountFor(table)} seats)`);
  }

  renderTableCells(t) {
    const w = t.w || 1, h = t.h || 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) this.renderCell(t.x + dx, t.y + dy);
    }
  }

  /** Seats a table would provide: walkable tiles orthogonally around it. */
  seatCountFor(t) {
    const w = t.w || 1, h = t.h || 1;
    let n = 0;
    const check = (x, y) => {
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
      if (this.plan.solids[y * this.cols + x]) return;
      if (this.plan.tables.some(o => this.tableCovers(o, x, y))) return;
      n++;
    };
    for (let dx = 0; dx < w; dx++) { check(t.x + dx, t.y - 1); check(t.x + dx, t.y + h); }
    for (let dy = 0; dy < h; dy++) { check(t.x - 1, t.y + dy); check(t.x + w, t.y + dy); }
    return n;
  }

  /** Eyedropper: copy the tile at (x,y) into the palette selection. */
  pickTile(x, y) {
    const i = y * this.cols + x;
    const obj = this.plan.objects[i];
    const grd = this.plan.ground[i];
    const tile = obj || grd;
    if (!tile) { this.setStatus('nothing to pick here'); return; }
    const layer = obj ? 'object' : 'ground';
    const msg = `picked ${tile.s}#${tile.f} (${layer} layer)`;
    // Switch to the sheet that this tile came from
    const sheetIdx = this.sheetList.findIndex(s => s.key === tile.s);
    if (sheetIdx >= 0 && sheetIdx !== this.sheetIdx) {
      this.selectSheet(sheetIdx).then(() => {
        this.selectedFrame = tile.f;
        this.setStatus(msg);
      });
    } else {
      this.selectedFrame = tile.f;
      this.setStatus(msg);
    }
  }

  /**
   * When placing a marker, auto-paint the assigned tile (or the current
   * palette selection if no per-marker tile is set) as an object on that cell.
   */
  autoPaintMarker(markerType, x, y) {
    const i = y * this.cols + x;
    const tile = this.markerTiles[markerType] || { s: this.sheetKey, f: this.selectedFrame };
    if (tile && this.textures.exists(tile.s)) {
      this.plan.objects[i] = { s: tile.s, f: tile.f };
      this.plan.solids[i] = true;
      this.renderCell(x, y);
    }
  }

  // ------------------------------------------------------------- box copy/paste

  /** Start a drag selection for the copy tool. */
  startSelection(x, y) {
    this.selection = { x0: x, y0: y, x1: x, y1: y };
    this.drawSelectionBox();
  }

  /** Update selection end point during drag. */
  updateSelection(x, y) {
    if (!this.selection) return;
    this.selection.x1 = x;
    this.selection.y1 = y;
    this.drawSelectionBox();
  }

  /** Finalize selection and copy region to clipboard. */
  finishSelection() {
    if (!this.selection) return;
    const { x0, y0, x1, y1 } = this.selection;
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w < 1 || h < 1) { this.clearSelection(); return; }
    const ground = [], objects = [], solids = [];
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const si = (minY + dy) * this.cols + (minX + dx);
        ground.push(this.plan.ground[si] ?? null);
        objects.push(this.plan.objects[si] ?? null);
        solids.push(!!this.plan.solids[si]);
      }
    }
    this.clipboard = { w, h, ground, objects, solids };
    this.clearSelection();
    this.setStatus(`copied ${w}x${h} region — switch to Paste and click to place`);
  }

  clearSelection() {
    this.selection = null;
    this.selectionBox?.destroy();
    this.selectionBox = null;
  }

  drawSelectionBox() {
    this.selectionBox?.destroy();
    if (!this.selection) return;
    const { x0, y0, x1, y1 } = this.selection;
    const minX = Math.min(x0, x1), minY = Math.min(y0, y1);
    const maxX = Math.max(x0, x1), maxY = Math.max(y0, y1);
    const gfx = this.add.graphics()
      .lineStyle(2, 0xffe9a8, 1)
      .strokeRect(minX * TILE, minY * TILE, (maxX - minX + 1) * TILE, (maxY - minY + 1) * TILE);
    gfx.setDepth(30);
    this.gridContainer.add(gfx);
    this.selectionBox = gfx;
  }

  /** Paste the clipboard region with its top-left at (x,y). */
  pasteRegion(x, y) {
    if (!this.clipboard) { this.setStatus('nothing to paste — use Copy first'); return; }
    const { w, h, ground, objects, solids } = this.clipboard;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) continue;
        const ti = ty * this.cols + tx;
        const ci = dy * w + dx;
        if (ground[ci]) this.plan.ground[ti] = { ...ground[ci] };
        if (objects[ci]) this.plan.objects[ti] = { ...objects[ci] };
        this.plan.solids[ti] = solids[ci];
        this.renderCell(tx, ty);
      }
    }
    this.setStatus(`pasted ${w}x${h} region at (${x},${y})`);
  }

  buildHelp(height) {
    const lines = [
      'Pick a frame in the left palette, choose a tool, then click/drag on the grid.',
      'Ground/Object: paint tile.  Erase: clear cell.  Solid: toggle collision.',
      'Pick: eyedropper — copies a tile from the grid into the palette selection.',
      'Copy: drag to select a region.  Paste: click to stamp the copied region.',
      'Spawn/Kitchen/Bar/Door/Host/Bench/Table: places marker AND auto-paints the tile.',
      'Host = host stand (the host NPC seats parties). Bench = waiting-area seat.',
      'Bar = bartender station/drink pickup (like Kitchen, but for drinks).',
      'Table 1x1/2x1/1x2/2x2 sets the footprint; seats are the tiles around it.',
      'Bar Tbl toggles whether new tables are flagged isBar (bar seating pool).',
      'Right-click a marker preview icon to assign a tile to that marker type.',
      'Sheet ◀ ▶ browses all indexed sheets. Layers hide artwork. Size +/- resizes.'
    ];
    // Sits in the band fitGrid() reserves at the bottom; depth keeps it above
    // the grid container, which would otherwise cover it on tall layouts.
    this.add.text(PALETTE_W + 16, height - 6, lines.join('\n'), {
      fontFamily: 'system-ui', fontSize: '12px', color: '#7a7a8a', lineSpacing: 2
    }).setOrigin(0, 1).setDepth(60);
  }

  save() {
    this.plan.markerTiles = this.markerTiles;
    Storage.savePlan(this.plan);
    this.flash('Floor plan saved.');
  }

  async importPlan() {
    try {
      const data = await Storage.pickJSON();
      this.plan = data;
      Storage.savePlan(data);
      this.scene.restart();
    } catch (e) {
      if (e && e.message !== 'No file selected') this.flash('Import failed: ' + e.message);
    }
  }

  flash(msg) {
    if (this.flashText) this.flashText.destroy();
    this.flashText = this.add.text(this.scale.width / 2, this.scale.height - 16, msg, {
      fontFamily: 'system-ui', fontSize: '14px', color: '#9aff9a'
    }).setOrigin(0.5).setDepth(200);
    this.time.delayedCall(2000, () => this.flashText?.setText(''));
  }
}
