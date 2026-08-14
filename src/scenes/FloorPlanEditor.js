import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { TILE, SHEETS, STATION_KEYS } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { Palette } from '../core/Palette.js';
import { DEFAULT_FLOOR_PLAN, DEFAULT_COMPONENTS } from '../data/defaults.js';
import {
  loadAssetIndex, loadSheetDetail, ensureSheetTexture, nonEmptyFrames, describeFrame
} from '../data/assetIndex.js';
import { componentTextureRef, registerCustomSprites } from '../core/ComponentSprites.js';

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
  { id: 'runner',  label: 'Runner' },
  { id: 'component', label: 'Component' }
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

    // Component catalog (see the Components editor / ComponentSprites.js):
    // named sprite+attribute presets the Component tool below paints with.
    // Custom sprites' textures load progressively in the background — the
    // tool/picker fall back to a plain swatch for any not registered yet,
    // same tolerance the rest of this editor already has for slow sheets.
    this.componentData = Storage.loadComponents() || { customSprites: [], components: JSON.parse(JSON.stringify(DEFAULT_COMPONENTS)) };
    this.selectedComponentId = this.componentData.components[0]?.id || null;
    registerCustomSprites(this, this.componentData.customSprites);

    // Until the generated index loads, fall back to the sheets Boot preloaded.
    this.sheetList = SHEETS.map(s => ({
      key: s.key, path: s.path, tile: s.frameW, kind: 'objects'
    }));
    this.sheetKey = 'generic';

    // Narrow screens don't have room for the palette and grid side by side,
    // so only one is shown at a time there.
    this.panelTab = 'grid';

    // Grid zoom: null means "not set yet" — setupGridCamera() defaults it to
    // the fit-to-screen zoom on first build, then preserves the user's choice
    // across resizes (only ever clamped up to the current fit zoom, never
    // reset). applyResize() nulls it out again since a new grid size makes
    // any prior pan/zoom position meaningless.
    this._userZoom = null;
    this._zoomMax = 4;

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
    // Wide layout reserves room at the bottom for the help text. Unlike the
    // old single-camera version (where the grid just drew *behind* the text
    // at a lower depth), the grid now renders on its own camera that paints
    // its whole viewport rectangle every frame — any overlap would fully
    // blank the text out, not just sit visually behind it — so this margin
    // must clear the help text's real rendered height (13 lines), not just
    // approximate it. Narrow hides the help text entirely, so it only needs
    // a small margin.
    const gridViewW = Math.max(100, width - gridX - 12);
    const gridViewH = Math.max(100, height - gridY - (narrow ? 12 : 240));
    return { width, height, narrow, toolbarH, paletteW, gridX, gridY, gridViewW, gridViewH };
  }

  /** Destroys every display object + input listener from the previous build so a full rebuild never leaks or duplicates. */
  teardown() {
    this.clearSelection();
    if (this.componentModal) { this.componentModal.destroy(true); this.componentModal = null; }
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
    if (this._gridWheel) { this.input.off('wheel', this._gridWheel); this._gridWheel = null; }
    if (this._gridPointerDown) { this.input.off('pointerdown', this._gridPointerDown); this._gridPointerDown = null; }
    if (this._gridPointerMove) { this.input.off('pointermove', this._gridPointerMove); this._gridPointerMove = null; }
    if (this._gridPointerUp) {
      this.input.off('pointerup', this._gridPointerUp);
      this.input.off('pointerupoutside', this._gridPointerUp);
      this.input.off('pointercancel', this._gridPointerUp);
      this._gridPointerUp = null;
    }
    if (this.gridCam) { this.cameras.remove(this.gridCam); this.gridCam = null; }
    this._paletteDrag = null;
    this._panState = null;
    this._pinchState = null;
    this.palette = null;
    this.gridContainer = null;
    this.paletteInfo = null;
    this.zoomControlObjects = null;
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
    this.buildGridZoomControls(this.layout);
    this.buildHelp(this.layout);
    this.syncCameraOwnership();
  }

  /**
   * The grid renders on its own camera (this.gridCam) so it can zoom/pan
   * independently of the toolbar/palette; each camera must ignore what the
   * other one owns, or both draw the same objects at the wrong transform.
   * Anything created *after* build() runs (sheet-switch rebuilding the
   * palette, the save/import flash message) needs this re-run too, since a
   * fresh top-level object starts out visible on every camera by default.
   */
  syncCameraOwnership() {
    this.gridCam.ignore(this.children.list.filter(o => o !== this.gridContainer));
    this.cameras.main.ignore(this.gridContainer);
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
    if (this.gridCam) this.syncCameraOwnership(); // new palette container defaults to visible on every camera
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

    // Opens a modal grid (buildComponentGrid) rather than inline swatches
    // like Table/Station above — this thin strip can't show a meaningful
    // tile icon, and a sprite catalog needs to show the actual sprite.
    addLabel('Component');
    x2 += 74;
    this.componentBtn = this.makeStripBtn(container, x2, 0, 150, h, this.componentButtonLabel(), () => this.openComponentPicker(), 10);
    x2 += 150 + 12;

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
    const gridActive = !this.layout.narrow || this.panelTab === 'grid';
    this.gridContainer?.setVisible(gridActive);
    this.gridCam?.setVisible(gridActive);
    this.refreshZoomControlsVisibility();
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

  // ---------------------------------------------------------- component tool

  componentButtonLabel() {
    const comp = this.componentData.components.find(c => c.id === this.selectedComponentId);
    return 'Cmpnt: ' + (comp ? comp.label : 'none');
  }

  refreshComponentBtnLabel() {
    this.componentBtn?.txt.setText(this.componentButtonLabel());
  }

  /**
   * Full-screen modal grid of component swatches — the same shape as
   * GuestEditor's appearance-slot picker, adapted here because the row2
   * strip's buttons are only 22-26px tall (fine for text labels like Table/
   * Station use, too short to show a meaningful tile icon).
   */
  openComponentPicker() {
    const { width, height } = this.scale;
    const modal = this.add.container(0, 0).setDepth(300);
    const backdrop = this.add.rectangle(0, 0, width, height, 0x000000, 0.6).setOrigin(0).setInteractive();
    const panel = this.add.rectangle(40, 40, width - 80, height - 80, 0x23232c).setStrokeStyle(2, 0x4a4a5e).setOrigin(0);
    const title = this.add.text(56, 52, 'Choose Component', { fontFamily: 'system-ui', fontSize: '16px', color: '#ffe9a8' });
    const closeBtn = this.makeBtn(width - 110, 48, 54, 26, 'Close', () => this.closeComponentPicker());
    modal.add([backdrop, panel, title, closeBtn.bg, closeBtn.txt]);
    this.componentModal = modal;

    this.buildComponentGrid(modal, 56, 88, width - 112, height - 140);
    this.syncCameraOwnership(); // new top-level modal objects default to visible on every camera
  }

  buildComponentGrid(modal, gx, gy, gw, gh) {
    const cellW = 64, cellH = 84, pad = 6;
    const cols = Math.max(1, Math.floor(gw / (cellW + pad)));
    const grid = this.add.container(gx, gy).setDepth(301);
    const list = this.componentData.components;

    list.forEach((comp, i) => {
      const cx = (i % cols) * (cellW + pad), cy = Math.floor(i / cols) * (cellH + pad);
      const selected = comp.id === this.selectedComponentId;
      const bg = this.add.rectangle(cx, cy, cellW, cellH, selected ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      grid.add(bg);
      try {
        const ref = componentTextureRef(comp);
        if (this.textures.exists(ref.key)) {
          const img = this.add.image(cx + cellW / 2, cy + cellH - 26, ref.key, ref.frame).setDisplaySize(40, 40);
          if (comp.tint != null) img.setTint(comp.tint);
          grid.add(img);
        }
      } catch { /* sprite not loaded yet — swatch just shows its label below */ }
      const label = this.add.text(cx + cellW / 2, cy + cellH - 8, comp.label, {
        fontFamily: 'system-ui', fontSize: '9px', color: '#8fb6ff'
      }).setOrigin(0.5);
      grid.add(label);
      bg.on('pointerdown', () => this.selectComponent(comp.id));
    });

    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(gx, gy, gw, gh);
    grid.setMask(maskShape.createGeometryMask());

    const contentH = Math.ceil(list.length / cols) * (cellH + pad);
    const wheelHandler = (pointer) => {
      if (pointer.x < gx || pointer.x > gx + gw || pointer.y < gy || pointer.y > gy + gh) return;
      const minY = gh - contentH;
      grid.y = Phaser.Math.Clamp(grid.y - Math.sign(pointer.event.deltaY) * 50, gy + Math.min(0, minY), gy);
    };
    this.input.on('wheel', wheelHandler);
    modal.once('destroy', () => { this.input.off('wheel', wheelHandler); maskShape.destroy(); });
    modal.add(grid);
  }

  selectComponent(id) {
    this.selectedComponentId = id;
    this.setTool('component');
    this.closeComponentPicker();
    this.refreshComponentBtnLabel();
  }

  closeComponentPicker() {
    if (!this.componentModal) return;
    this.componentModal.destroy(true);
    this.componentModal = null;
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
    this._userZoom = null; // new dimensions make any prior pan/zoom meaningless — recompute fit
    this.buildGrid();
    this.syncCameraOwnership(); // buildGrid() made a fresh gridCam — redo the ownership split
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
    // World space is just the grid's own pixel size (0,0)-(cols*TILE, rows*TILE);
    // this.gridCam (set up below) handles zoom/pan, not the container itself.
    this.gridContainer = this.add.container(0, 0).setDepth(10);
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
        cell.on('pointerdown', (p) => {
          if (p.rightButtonDown() || this.isMultiTouch()) return; // right-drag pans, two fingers pinch/pan
          if (this.tool === 'copy') this.startSelection(x, y);
          else this.applyTool(x, y);
        });
        cell.on('pointerover', (p) => {
          if (!p.isDown || p.rightButtonDown() || this.isMultiTouch()) return;
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

    this.setupGridCamera();
    this.setupGridZoomPan();
    this.renderAll();
    const gridActive = !this.layout.narrow || this.panelTab === 'grid';
    this.gridContainer.setVisible(gridActive);
    this.gridCam.setVisible(gridActive);

    // Finish copy selection on pointer up (anywhere on the grid)
    this.input.off('pointerup', this._pointerUpCb);
    this._pointerUpCb = () => {
      if (this.tool === 'copy' && this.selection) this.finishSelection();
    };
    this.input.on('pointerup', this._pointerUpCb);
  }

  isMultiTouch() { return this.input.pointer1.isDown && this.input.pointer2.isDown; }

  /** The most the grid can be zoomed out while still fitting the whole plan in the viewport. */
  computeFitZoom() {
    return Math.max(0.05, Math.min(1, this.gridViewW / (this.cols * TILE), this.gridViewH / (this.rows * TILE)));
  }

  /**
   * Creates the camera the grid renders through, independent of the
   * toolbar/palette's default camera so it can zoom/pan on its own.
   * `_userZoom` is preserved across resizes (clamped up to the new fit zoom,
   * never reset) but nulled by applyResize() since a new grid size makes any
   * prior pan/zoom position meaningless.
   */
  setupGridCamera() {
    this.gridViewW = this.layout.gridViewW;
    this.gridViewH = this.layout.gridViewH;
    if (this.gridCam) this.cameras.remove(this.gridCam);
    this.gridCam = this.cameras.add(this.gridX, this.gridY, this.gridViewW, this.gridViewH);
    this.gridCam.setBackgroundColor('#1b1b22').setRoundPixels(true);

    this._fitZoom = this.computeFitZoom();
    this._userZoom = Math.max(this._userZoom ?? this._fitZoom, this._fitZoom);
    this.gridCam.setZoom(this._userZoom);
    this.centerGridView();
  }

  /** Centers the grid in the viewport — used for the initial view and the Fit button. */
  centerGridView() {
    const zoom = this.gridCam.zoom;
    const viewW = this.gridViewW / zoom, viewH = this.gridViewH / zoom;
    this.gridCam.setScroll((this.cols * TILE - viewW) / 2, (this.rows * TILE - viewH) / 2);
  }

  /** Keeps the current scroll valid after a zoom/pan — centers whichever axis has slack instead of pinning to (0,0). */
  clampGridScroll() {
    const zoom = this.gridCam.zoom;
    const viewW = this.gridViewW / zoom, viewH = this.gridViewH / zoom;
    const worldW = this.cols * TILE, worldH = this.rows * TILE;
    const clampAxis = (view, world, current) => {
      if (world <= view) return (world - view) / 2;
      return Phaser.Math.Clamp(current, 0, world - view);
    };
    this.gridCam.scrollX = clampAxis(viewW, worldW, this.gridCam.scrollX);
    this.gridCam.scrollY = clampAxis(viewH, worldH, this.gridCam.scrollY);
  }

  /** Zoom anchored at a screen point (so whatever's under the cursor/pinch-midpoint stays put), then re-clamped. */
  applyGridZoom(newZoom, anchorScreenX, anchorScreenY) {
    const clamped = Phaser.Math.Clamp(newZoom, this._fitZoom, this._zoomMax);
    const cam = this.gridCam;
    const before = cam.getWorldPoint(anchorScreenX, anchorScreenY);
    cam.setZoom(clamped);
    const after = cam.getWorldPoint(anchorScreenX, anchorScreenY);
    cam.scrollX += before.x - after.x;
    cam.scrollY += before.y - after.y;
    this._userZoom = clamped;
    this.clampGridScroll();
    this.refreshZoomLabel();
  }

  zoomGridBy(delta) {
    this.applyGridZoom(this._userZoom + delta, this.gridX + this.gridViewW / 2, this.gridY + this.gridViewH / 2);
  }

  resetGridZoom() {
    this._userZoom = this._fitZoom;
    this.gridCam.setZoom(this._fitZoom);
    this.centerGridView();
    this.refreshZoomLabel();
  }

  refreshZoomLabel() { this.zoomLabel?.setText(Math.round(this._userZoom * 100) + '%'); }

  buildGridZoomControls(layout) {
    const bw = 30, bh = 26, gap = 4;
    const x = layout.width - 8 - bw;
    const y = this.gridY + 8;
    this.zoomInBtn = this.makeBtn(x, y, bw, bh, '+', () => this.zoomGridBy(0.25));
    this.zoomOutBtn = this.makeBtn(x, y + bh + gap, bw, bh, '−', () => this.zoomGridBy(-0.25));
    this.zoomFitBtn = this.makeBtn(x, y + (bh + gap) * 2, bw, bh, '⤢', () => this.resetGridZoom(), 13);
    this.zoomLabel = this.add.text(x + bw / 2, y + (bh + gap) * 3 + 9, '', {
      fontFamily: 'system-ui', fontSize: '10px', color: '#8fb6ff'
    }).setOrigin(0.5).setDepth(101);
    this.zoomControlObjects = [
      this.zoomInBtn.bg, this.zoomInBtn.txt, this.zoomOutBtn.bg, this.zoomOutBtn.txt,
      this.zoomFitBtn.bg, this.zoomFitBtn.txt, this.zoomLabel
    ];
    this.refreshZoomLabel();
    this.refreshZoomControlsVisibility();
  }

  refreshZoomControlsVisibility() {
    const gridActive = !this.layout.narrow || this.panelTab === 'grid';
    this.zoomControlObjects?.forEach(o => o.setVisible(gridActive));
  }

  /**
   * Wheel-zoom (desktop), pinch-zoom + two-finger pan combined (touch, like
   * a map app — zoom anchors on the pinch midpoint, pan follows how much
   * that midpoint moves), and right-click-drag pan (desktop, since
   * left-drag already means "paint"). All gated to the grid's own viewport
   * rectangle and to whichever panel is actually active on narrow screens.
   */
  setupGridZoomPan() {
    const inGrid = (p) => {
      if (this.layout.narrow && this.panelTab !== 'grid') return false;
      return p.x >= this.gridX && p.x <= this.gridX + this.gridViewW &&
        p.y >= this.gridY && p.y <= this.gridY + this.gridViewH;
    };

    this._gridWheel = (pointer) => {
      if (!inGrid(pointer)) return;
      const step = pointer.event.deltaY > 0 ? -0.15 : 0.15;
      this.applyGridZoom(this._userZoom + step, pointer.x, pointer.y);
    };
    this.input.on('wheel', this._gridWheel);

    this._panState = null;
    this._pinchState = null;
    this._gridPointerDown = (pointer) => {
      if (!inGrid(pointer)) return;
      if (pointer.rightButtonDown()) {
        this._panState = { startScrollX: this.gridCam.scrollX, startScrollY: this.gridCam.scrollY, startX: pointer.x, startY: pointer.y };
        return;
      }
      const p1 = this.input.pointer1, p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        this._pinchState = {
          dist: Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y),
          midX: (p1.x + p2.x) / 2, midY: (p1.y + p2.y) / 2
        };
      }
    };
    this._gridPointerMove = (pointer) => {
      if (this._panState && pointer.rightButtonDown()) {
        const zoom = this.gridCam.zoom;
        this.gridCam.scrollX = this._panState.startScrollX - (pointer.x - this._panState.startX) / zoom;
        this.gridCam.scrollY = this._panState.startScrollY - (pointer.y - this._panState.startY) / zoom;
        this.clampGridScroll();
        return;
      }
      const p1 = this.input.pointer1, p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown && this._pinchState) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
        const distDelta = dist - this._pinchState.dist;
        if (Math.abs(distDelta) > 2) this.applyGridZoom(this._userZoom + distDelta * 0.004, midX, midY);
        const zoom = this.gridCam.zoom;
        this.gridCam.scrollX -= (midX - this._pinchState.midX) / zoom;
        this.gridCam.scrollY -= (midY - this._pinchState.midY) / zoom;
        this.clampGridScroll();
        this._pinchState = { dist, midX, midY };
      }
    };
    this._gridPointerUp = () => {
      this._panState = null;
      if (!this.isMultiTouch()) this._pinchState = null;
    };
    this.input.on('pointerdown', this._gridPointerDown);
    this.input.on('pointermove', this._gridPointerMove);
    this.input.on('pointerup', this._gridPointerUp);
    this.input.on('pointerupoutside', this._gridPointerUp);
    this.input.on('pointercancel', this._gridPointerUp);
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
    } else if (t === 'component') {
      const comp = this.componentData.components.find(c => c.id === this.selectedComponentId);
      if (!comp) { this.setStatus('pick a component first (Component button, row 2)'); return; }
      const ref = componentTextureRef(comp);
      this.plan.objects[i] = { s: ref.key, f: ref.frame };
      this.plan.solids[i] = comp.solid;
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
    // Sits in the band computeLayout() reserves at the bottom of the grid
    // camera's viewport (see the gridViewH comment there) so the grid
    // camera's own per-frame background paint can never cover it.
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
    this.gridCam?.ignore(this.flashText); // otherwise it also renders inside the grid's zoom/pan transform
    this.time.delayedCall(2000, () => this.flashText?.setText(''));
  }
}
