import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { TILE, SHEETS, STATION_KEYS } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { Palette } from '../core/Palette.js';
import { DEFAULT_FLOOR_PLAN } from '../data/defaults.js';
import {
  loadAssetIndex, loadSheetDetail, ensureSheetTexture, nonEmptyFrames, describeFrame
} from '../data/assetIndex.js';

const PALETTE_W = 208;
const NARROW_BREAKPOINT = 700;
// Wide layout: everything fits on two toolbar rows + a status line.
const WIDE_TOOLBAR_H = 96;
// Narrow layout: sheet+actions, tools strip, and the layers/size/table/station
// strip each get their own full-width row so nothing has to shrink illegibly.
const NARROW_TOOLBAR_H = 154;

const MIN_COLS = 4, MAX_COLS = 60;
const MIN_ROWS = 4, MAX_ROWS = 40;

const TOOLS = [
  { id: 'ground',  label: 'Ground' },
  { id: 'object',  label: 'Object' },
  { id: 'erase',   label: 'Erase' },
  { id: 'solid',   label: 'Solid' },
  { id: 'pick',    label: 'Pick' },
  { id: 'copy',    label: 'Copy' },
  { id: 'paste',   label: 'Paste' },
  { id: 'spawn',   label: 'Spawn' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'bar',     label: 'Bar' },
  { id: 'door',    label: 'Door' },
  { id: 'host',    label: 'Host' },
  { id: 'bench',   label: 'Bench' },
  { id: 'table',   label: 'Table' },
  { id: 'station', label: 'Station' },
  { id: 'dish',    label: 'Dish' },
  { id: 'runner',  label: 'Runner' }
];

// Marker tools that auto-paint the selected object tile when placed.
const MARKER_TOOLS = ['spawn', 'kitchen', 'bar', 'door', 'host', 'bench', 'table', 'station', 'dish', 'runner'];

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
    // Which station key the Station tool stamps; index into STATION_KEYS.
    this.stationKeyIdx = 0;
    // Benches are a newer feature — older saved plans do not have the array.
    this.plan.benches = this.plan.benches || [];
    // Kitchen stations/dish area/runner posts — newer feature, same fallback.
    this.plan.stations = this.plan.stations || {};
    this.plan.runnerPosts = this.plan.runnerPosts || [];

    // Until the generated index loads, fall back to the sheets Boot preloaded.
    this.sheetList = SHEETS.map(s => ({
      key: s.key, path: s.path, tile: s.frameW, kind: 'objects'
    }));
    this.sheetKey = 'generic';

    // Narrow screens don't have room for the palette and grid side by side,
    // so only one is shown at a time there.
    this.panelTab = 'grid';

    this.cols = this.plan.cols;
    this.rows = this.plan.rows;
    this.pendingCols = this.cols;
    this.pendingRows = this.rows;

    this.build();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));

    // Enable right-click detection for marker tile assignment.
    this.input.mouse.disableContextMenu();

    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.onResize, this);
      if (this._resizeTimer) this._resizeTimer.remove(false);
    });

    this.initIndex();
  }

  onResize() {
    if (this._resizeTimer) this._resizeTimer.remove(false);
    this._resizeTimer = this.time.delayedCall(150, () => { this._resizeTimer = null; this.build(); });
  }

  // ---------------------------------------------------------------- layout

  computeLayout() {
    const { width, height } = this.scale;
    const narrow = width < NARROW_BREAKPOINT;
    const toolbarH = narrow ? NARROW_TOOLBAR_H : WIDE_TOOLBAR_H;
    const paletteW = narrow ? width - 16 : PALETTE_W - 16;
    const gridX = narrow ? 12 : PALETTE_W + 12;
    const gridY = toolbarH + 12;
    return { width, height, narrow, toolbarH, paletteW, gridX, gridY };
  }

  /** Destroys every display object + input listener from the previous build so a full rebuild never leaks or duplicates. */
  teardown() {
    this.clearSelection();
    this.teardownHScroll('tools');
    this.teardownHScroll('row2');
    if (this.paletteWheel) { this.input.off('wheel', this.paletteWheel); this.paletteWheel = null; }
    if (this._palettePointerDown) { this.input.off('pointerdown', this._palettePointerDown); this._palettePointerDown = null; }
    if (this._palettePointerMove) { this.input.off('pointermove', this._palettePointerMove); this._palettePointerMove = null; }
    if (this._palettePointerUp) {
      this.input.off('pointerup', this._palettePointerUp);
      this.input.off('pointerupoutside', this._palettePointerUp);
      this._palettePointerUp = null;
    }
    if (this._paletteMaskShape) { this._paletteMaskShape.destroy(); this._paletteMaskShape = null; }
    if (this._pointerUpCb) { this.input.off('pointerup', this._pointerUpCb); this._pointerUpCb = null; }
    this._paletteDrag = null;
    this.palette = null;
    this.gridContainer = null;
    this.paletteInfo = null;
    this.children.removeAll(true);
  }

  build() {
    this.teardown();
    this.layout = this.computeLayout();
    this.gridX = this.layout.gridX;
    this.gridY = this.layout.gridY;
    this.buildToolbar(this.layout);
    this.panelTabBtns = null;
    if (this.layout.narrow) this.buildPanelTabs(this.layout);
    this.buildPalette();
    this.buildGrid();
    this.buildHelp(this.layout);
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
    parts.push('wheel/drag to scroll');
    this.paletteInfo.setText(parts.join(' · '));
  }

  // ------------------------------------------------------------------- toolbar

  buildToolbar(layout) {
    const { width, narrow, toolbarH } = layout;
    this.add.rectangle(0, 0, width, toolbarH, 0x1b1b22).setOrigin(0, 0).setDepth(100);

    if (narrow) this.buildNarrowToolbarRows(layout);
    else this.buildWideToolbarRows(layout);
  }

  /** Wide: sheet selector + tools + actions share one row; layers/size/table/station share a second. */
  buildWideToolbarRows(layout) {
    const actionW = 68, actionGap = 6;
    const actionsW = actionW * 4 + actionGap * 3;
    const actionsX = Math.max(12, layout.width - 12 - actionsW);
    const toolsX = 200;

    this.buildSheetSelector(12, 6, false);
    const toolsW = Math.max(40, actionsX - 8 - toolsX);
    this.buildToolsStrip(toolsX, 20, toolsW, 22);
    this.buildActions(actionsX, 20, actionW, actionGap);
    this.buildRow2Strip(8, 52, layout.width - 16, 22);
    this.statusText = this.add.text(12, 78, '', {
      fontFamily: 'system-ui', fontSize: '12px', color: '#8fb6ff'
    }).setDepth(101);
  }

  /** Narrow: sheet+actions, then the tools strip, then the row-2 strip each get a full-width row. */
  buildNarrowToolbarRows(layout) {
    this.buildSheetSelector(8, 8, true);
    this.buildActions(layout.width - 8 - (50 * 4 + 4 * 3), 8, 50, 4);
    this.buildToolsStrip(8, 40, layout.width - 16, 26);
    this.buildRow2Strip(8, 72, layout.width - 16, 26);
    this.statusText = this.add.text(12, 104, '', {
      fontFamily: 'system-ui', fontSize: '11px', color: '#8fb6ff', wordWrap: { width: layout.width - 24 }
    }).setDepth(101);
  }

  buildSheetSelector(x, y, narrow) {
    this.add.text(x, y, 'Sheet', { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a' }).setDepth(101);
    this.makeBtn(x, y + 14, 24, 22, '◀', () => this.selectSheet(this.sheetIdx - 1));
    this.makeBtn(x + 26, y + 14, 24, 22, '▶', () => this.selectSheet(this.sheetIdx + 1));
    this.sheetLabel = this.add.text(x + 56, y + 19, this.sheetKey, {
      fontFamily: 'system-ui', fontSize: narrow ? '11px' : '13px', color: '#ffe9a8'
    }).setDepth(101);
  }

  buildActions(actionsX, y, actionW, actionGap) {
    const actions = [
      ['Menu', () => this.scene.start('Menu')],
      ['Import', () => this.importPlan()],
      ['Export', () => Storage.downloadJSON(this.plan, 'floor-plan.json')],
      ['Save', () => this.save()]
    ];
    actions.forEach(([label, fn], i) => {
      this.makeBtn(actionsX + i * (actionW + actionGap), y, actionW, 22, label, fn, actionW < 60 ? 10 : undefined);
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

  /** Same as makeBtn but adds into a container instead of the scene root, for horizontally-scrollable strips. */
  makeStripBtn(container, x, y, w, h, label, onClick, fontSize) {
    const bg = this.add.rectangle(x, y, w, h, 0x2b2b39).setOrigin(0, 0)
      .setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
    const size = fontSize ?? Math.min(13, Math.max(10, h - 8));
    const txt = this.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'system-ui', fontSize: size + 'px', color: '#e6e6f0'
    }).setOrigin(0.5);
    bg.on('pointerover', () => bg.setFillStyle(0x3a3a4d));
    bg.on('pointerout', () => bg.setFillStyle(0x2b2b39));
    bg.on('pointerdown', onClick);
    container.add([bg, txt]);
    return { bg, txt };
  }

  /**
   * Generic horizontally-scrollable strip: a masked container with wheel +
   * drag scrolling (drag covers touch devices, which never fire 'wheel').
   * `key` must be unique per strip — it names the instance fields used to
   * track and clean up this strip's mask/listeners across rebuilds.
   */
  buildHScroll(key, x, y, w, h) {
    const container = this.add.container(x, y).setDepth(101);
    const maskKey = '_' + key + 'MaskShape';
    if (this[maskKey]) this[maskKey].destroy();
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(x, y, w, h);
    container.setMask(maskShape.createGeometryMask());
    this[maskKey] = maskShape;

    const wheelKey = '_' + key + 'Wheel';
    if (this[wheelKey]) this.input.off('wheel', this[wheelKey]);
    this[wheelKey] = (pointer) => {
      if (pointer.x < x || pointer.x > x + w || pointer.y < y || pointer.y > y + h) return;
      const ev = pointer.event;
      const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      const contentW = this[key + 'ContentWidth'] || 0;
      const minX = x + Math.min(0, w - contentW);
      container.x = Phaser.Math.Clamp(container.x - Math.sign(delta) * 60, minX, x);
    };
    this.input.on('wheel', this[wheelKey]);

    const downKey = '_' + key + 'PointerDown', moveKey = '_' + key + 'PointerMove', upKey = '_' + key + 'PointerUp', dragKey = '_' + key + 'Drag';
    if (this[downKey]) this.input.off('pointerdown', this[downKey]);
    if (this[moveKey]) this.input.off('pointermove', this[moveKey]);
    if (this[upKey]) { this.input.off('pointerup', this[upKey]); this.input.off('pointerupoutside', this[upKey]); }
    this[downKey] = (pointer) => {
      if (pointer.x < x || pointer.x > x + w || pointer.y < y || pointer.y > y + h) return;
      this[dragKey] = { startX: pointer.x, startContainerX: container.x };
    };
    this[moveKey] = (pointer) => {
      const drag = this[dragKey];
      if (!drag || !pointer.isDown) return;
      const dx = pointer.x - drag.startX;
      const contentW = this[key + 'ContentWidth'] || 0;
      const minX = x + Math.min(0, w - contentW);
      container.x = Phaser.Math.Clamp(drag.startContainerX + dx, minX, x);
    };
    this[upKey] = () => { this[dragKey] = null; };
    this.input.on('pointerdown', this[downKey]);
    this.input.on('pointermove', this[moveKey]);
    this.input.on('pointerup', this[upKey]);
    this.input.on('pointerupoutside', this[upKey]);

    return container;
  }

  teardownHScroll(key) {
    const wheelKey = '_' + key + 'Wheel', downKey = '_' + key + 'PointerDown', moveKey = '_' + key + 'PointerMove',
      upKey = '_' + key + 'PointerUp', maskKey = '_' + key + 'MaskShape';
    if (this[wheelKey]) { this.input.off('wheel', this[wheelKey]); this[wheelKey] = null; }
    if (this[downKey]) { this.input.off('pointerdown', this[downKey]); this[downKey] = null; }
    if (this[moveKey]) { this.input.off('pointermove', this[moveKey]); this[moveKey] = null; }
    if (this[upKey]) {
      this.input.off('pointerup', this[upKey]);
      this.input.off('pointerupoutside', this[upKey]);
      this[upKey] = null;
    }
    if (this[maskKey]) { this[maskKey].destroy(); this[maskKey] = null; }
    this['_' + key + 'Drag'] = null;
  }

  /** Tools row: fixed-size, comfortably tappable buttons — overflow scrolls instead of shrinking illegibly. */
  buildToolsStrip(x, y, w, h) {
    const container = this.buildHScroll('tools', x, y, w, h);
    const btnW = 62, gap = 4;

    this.toolBtns = {};
    this.markerPreviews = {};
    TOOLS.forEach((t, i) => {
      const bx = i * (btnW + gap);
      const btn = this.makeStripBtn(container, bx, 0, btnW, h, t.label, () => this.setTool(t.id));
      this.toolBtns[t.id] = btn;
      // Per-marker tile preview: small icon on top of marker tool buttons.
      // Right-click to assign the current palette selection to this marker.
      if (MARKER_TOOLS.includes(t.id)) {
        const pv = this.add.image(bx + btnW - 6, h - 2, '__pixel')
          .setOrigin(0.5).setDisplaySize(12, 12).setTint(0x4a4a5e);
        pv.setInteractive({ useHandCursor: true });
        pv.on('pointerdown', (pointer) => {
          if (pointer.rightButtonDown()) this.assignMarkerTile(t.id);
          else this.setTool(t.id);
        });
        pv.on('pointerover', () => {
          const mt = this.markerTiles[t.id];
          this.setStatus(mt ? `${t.id} tile: ${mt.s}#${mt.f}` : `${t.id}: click to use, right-click preview to assign tile`);
        });
        pv.on('contextmenu', (e) => { e.event?.preventDefault?.(); });
        container.add(pv);
        this.markerPreviews[t.id] = pv;
      }
    });
    this.toolsContentWidth = TOOLS.length * (btnW + gap);
    this.refreshToolBtns();
    this.refreshMarkerPreviews();
  }

  /** Layers / size / table footprint / station picker, as one scrollable strip. */
  buildRow2Strip(x, y, w, h) {
    const container = this.buildHScroll('row2', x, y, w, h);
    let x2 = 0;
    const addLabel = (text) => container.add(this.add.text(x2, 2, text, { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a' }));

    addLabel('Layers');
    x2 += 48;
    this.layerBtns = {};
    LAYERS.forEach((l) => {
      this.layerBtns[l.id] = this.makeStripBtn(container, x2, 0, 66, h, l.label, () => this.toggleLayer(l.id));
      x2 += 70;
    });
    this.refreshLayerBtns();
    x2 += 16;

    addLabel('Size');
    x2 += 34;
    this.makeStripBtn(container, x2, 0, 22, h, '-', () => this.nudgeSize(-1, 0));
    this.makeStripBtn(container, x2 + 24, 0, 22, h, '+', () => this.nudgeSize(1, 0));
    this.makeStripBtn(container, x2 + 52, 0, 22, h, '-', () => this.nudgeSize(0, -1));
    this.makeStripBtn(container, x2 + 76, 0, 22, h, '+', () => this.nudgeSize(0, 1));
    this.sizeLabel = this.add.text(x2 + 104, 5, '', {
      fontFamily: 'system-ui', fontSize: '12px', color: '#e6e6f0'
    });
    container.add(this.sizeLabel);
    this.applyBtn = this.makeStripBtn(container, x2 + 186, 0, 60, h, 'Apply', () => this.applyResize());
    this.refreshSizeLabel();
    x2 += 258;

    addLabel('Table');
    x2 += 40;
    this.tableSizeBtns = TABLE_SIZES.map((s, i) => this.makeStripBtn(container, x2 + i * 40, 0, 36, h, s.label, () => this.setTableSize(i)));
    this.refreshTableSizeBtns();
    x2 += TABLE_SIZES.length * 40 + 12;

    this.barTableBtn = this.makeStripBtn(container, x2, 0, 62, h, 'Bar Tbl', () => this.toggleTableIsBar());
    this.refreshBarTableBtn();
    x2 += 62 + 12;

    addLabel('Station');
    x2 += 46;
    this.stationKeyBtns = STATION_KEYS.map((s, i) => this.makeStripBtn(container, x2 + i * 44, 0, 40, h, s.label, () => this.setStationKey(i), 10));
    this.refreshStationKeyBtns();
    x2 += STATION_KEYS.length * 44 + 12;

    this.row2ContentWidth = x2;
  }

  // ----------------------------------------------- narrow-screen panel tabs

  buildPanelTabs(layout) {
    const y = NARROW_TOOLBAR_H - 32;
    const w = (layout.width - 16 - 8) / 2;
    this.paletteTabBtn = this.makeBtn(8, y, w, 26, 'Palette', () => this.setPanelTab('palette'));
    this.gridTabBtn = this.makeBtn(8 + w + 8, y, w, 26, 'Grid', () => this.setPanelTab('grid'));
    this.refreshPanelTabButtons();
  }

  refreshPanelTabButtons() {
    if (!this.paletteTabBtn) return;
    this.paletteTabBtn.bg.setFillStyle(this.panelTab === 'palette' ? 0x4a4a5e : 0x2b2b39);
    this.gridTabBtn.bg.setFillStyle(this.panelTab === 'grid' ? 0x4a4a5e : 0x2b2b39);
  }

  setPanelTab(name) {
    if (this.panelTab === name) return;
    this.panelTab = name;
    this.refreshPanelTabButtons();
    this.palette?.setVisible(!this.layout.narrow || this.panelTab === 'palette');
    this.gridContainer?.setVisible(!this.layout.narrow || this.panelTab === 'grid');
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

  /** Choose which station key the Station tool stamps, and switch to that tool. */
  setStationKey(i) {
    this.stationKeyIdx = i;
    this.refreshStationKeyBtns();
    this.setTool('station');
    this.setStatus(`placing ${STATION_KEYS[i].label} station`);
  }

  refreshStationKeyBtns() {
    this.stationKeyBtns?.forEach((b, i) => {
      const on = i === this.stationKeyIdx;
      b.bg.setFillStyle(on ? 0x4a4a5e : 0x2b2b39);
      b.txt.setColor(on ? '#ffe9a8' : '#e6e6f0');
    });
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
    this.plan.runnerPosts = (this.plan.runnerPosts || []).filter(p => p.x < nc && p.y < nr);
    for (const key of ['spawn', 'kitchen', 'bar', 'door', 'host', 'dish']) {
      const p = this.plan[key];
      if (p) {
        p.x = Phaser.Math.Clamp(p.x, 0, nc - 1);
        p.y = Phaser.Math.Clamp(p.y, 0, nr - 1);
      }
    }
    for (const key of Object.keys(this.plan.stations || {})) {
      const p = this.plan.stations[key];
      p.x = Phaser.Math.Clamp(p.x, 0, nc - 1);
      p.y = Phaser.Math.Clamp(p.y, 0, nr - 1);
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
    const panelY = this.gridY;
    const panelW = this.layout.paletteW;
    const panelH = this.layout.height - panelY - 40;
    this.palette.container.setPosition(panelX, panelY);
    this.palette.container.setDepth(50);
    this.palette.setVisible(!this.layout.narrow || this.panelTab === 'palette');

    if (this._paletteMaskShape) this._paletteMaskShape.destroy();
    const maskShape = this.make.graphics({ x: 0, y: 0 });
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, panelY, panelW, panelH);
    this.palette.container.setMask(maskShape.createGeometryMask());
    this._paletteMaskShape = maskShape;

    if (this.paletteWheel) this.input.off('wheel', this.paletteWheel);
    this.paletteWheel = (pointer, over, dx, dy) => {
      if (this.layout.narrow && this.panelTab !== 'palette') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = Math.min(panelY, panelY + panelH - this.palette.contentHeight - 8);
      this.palette.container.y =
        Phaser.Math.Clamp(this.palette.container.y - Math.sign(dy) * 60, minY, panelY);
    };
    this.input.on('wheel', this.paletteWheel);

    // Drag-to-scroll so the palette is reachable on touch devices, which never fire 'wheel'.
    if (this._palettePointerDown) this.input.off('pointerdown', this._palettePointerDown);
    if (this._palettePointerMove) this.input.off('pointermove', this._palettePointerMove);
    if (this._palettePointerUp) { this.input.off('pointerup', this._palettePointerUp); this.input.off('pointerupoutside', this._palettePointerUp); }
    this._palettePointerDown = (pointer) => {
      if (this.layout.narrow && this.panelTab !== 'palette') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW || pointer.y < panelY || pointer.y > panelY + panelH) return;
      this._paletteDrag = { startY: pointer.y, startContainerY: this.palette.container.y };
    };
    this._palettePointerMove = (pointer) => {
      if (!this._paletteDrag || !pointer.isDown) return;
      const dy = pointer.y - this._paletteDrag.startY;
      const minY = Math.min(panelY, panelY + panelH - this.palette.contentHeight - 8);
      this.palette.container.y = Phaser.Math.Clamp(this._paletteDrag.startContainerY + dy, minY, panelY);
    };
    this._palettePointerUp = () => { this._paletteDrag = null; };
    this.input.on('pointerdown', this._palettePointerDown);
    this.input.on('pointermove', this._palettePointerMove);
    this.input.on('pointerup', this._palettePointerUp);
    this.input.on('pointerupoutside', this._palettePointerUp);

    if (!this.paletteInfo) {
      this.paletteInfo = this.add.text(panelX + 4, this.layout.height - 34, '', {
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
    this.gridContainer.setVisible(!this.layout.narrow || this.panelTab === 'grid');

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
    else if (this.plan.dish?.x === x && this.plan.dish?.y === y) mark('DSH', 0xc9c9d6);
    else if (this.plan.runnerPosts?.some(p => p.x === x && p.y === y)) mark('RUN', 0xc9f2a0);
    else if (this.stationKeyAt(x, y)) mark(this.stationKeyAt(x, y).code, 0xffcf9e);
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
    } else if (t === 'station') {
      const key = STATION_KEYS[this.stationKeyIdx].key;
      this.plan.stations[key] = { x, y };
      this.autoPaintMarker('station', x, y);
    } else if (t === 'dish') {
      this.plan.dish = { x, y };
      this.autoPaintMarker('dish', x, y);
    } else if (t === 'runner') {
      const ex = this.plan.runnerPosts.findIndex(p => p.x === x && p.y === y);
      if (ex >= 0) this.plan.runnerPosts.splice(ex, 1);
      else {
        this.plan.runnerPosts.push({ x, y });
        this.autoPaintMarker('runner', x, y);
      }
    }
    this.renderCell(x, y);
  }

  /** The station key (if any) whose position is (x,y). */
  stationKeyAt(x, y) {
    for (const s of STATION_KEYS) {
      const p = this.plan.stations[s.key];
      if (p && p.x === x && p.y === y) return s;
    }
    return null;
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

  buildHelp(layout) {
    if (layout.narrow) return; // no room on narrow screens; the toolbar already reads as self-explanatory buttons
    const lines = [
      'Pick a frame in the left palette, choose a tool, then click/drag on the grid.',
      'Ground/Object: paint tile.  Erase: clear cell.  Solid: toggle collision.',
      'Pick: eyedropper — copies a tile from the grid into the palette selection.',
      'Copy: drag to select a region.  Paste: click to stamp the copied region.',
      'Spawn/Kitchen/Bar/Door/Host/Bench/Table/Station/Dish/Runner: places marker AND auto-paints the tile.',
      'Host = host stand (the host NPC seats parties). Bench = waiting-area seat.',
      'Bar = bartender station/drink pickup (like Kitchen, but for drinks).',
      'Table 1x1/2x1/1x2/2x2 sets the footprint; seats are the tiles around it.',
      'Bar Tbl toggles whether new tables are flagged isBar (bar seating pool).',
      'Station places a cook post; the Station picker (Grill/Fry/Saute/Salad/Dsrt) chooses which.',
      'Dish = bussing drop-off point. Runner = a food-runner post (click again to remove).',
      'Right-click a marker preview icon to assign a tile to that marker type.',
      'Sheet ◀ ▶ browses all indexed sheets. Layers hide artwork. Size +/- resizes.'
    ];
    // Sits in the band fitGrid() reserves at the bottom; depth keeps it above
    // the grid container, which would otherwise cover it on tall layouts.
    this.add.text(PALETTE_W + 16, layout.height - 6, lines.join('\n'), {
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
