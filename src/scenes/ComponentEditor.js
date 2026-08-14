import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { SHEETS } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { Palette } from '../core/Palette.js';
import { DEFAULT_COMPONENTS } from '../data/defaults.js';
import { loadAssetIndex, loadSheetDetail, ensureSheetTexture, nonEmptyFrames, describeFrame } from '../data/assetIndex.js';
import { customTexKey, componentTextureRef, registerCustomSprite, registerCustomSprites } from '../core/ComponentSprites.js';

const TOOLBAR_H = 56;
const PANEL_TAB_Y = TOOLBAR_H + 6;
const PANEL_TAB_H = 24;
const NARROW_BREAKPOINT = 760;

// Named, reusable tile/prop building blocks: a sprite (from a pack sheet or
// a user-uploaded image) plus attributes like collision, so the Floor Plan
// Editor's Component tool can stamp "a Stove, solid" in one click instead of
// hand-picking a frame and re-toggling Solid every time.
export class ComponentEditorScene extends Phaser.Scene {
  constructor() { super('ComponentEditor'); }

  async create() {
    this.cameras.main.setBackgroundColor('#23232c');
    const saved = Storage.loadComponents();
    this.customSprites = saved?.customSprites ? JSON.parse(JSON.stringify(saved.customSprites)) : [];
    this.components = saved?.components ? JSON.parse(JSON.stringify(saved.components)) : JSON.parse(JSON.stringify(DEFAULT_COMPONENTS));
    // Custom sprites' textures must be registered before anything tries to
    // render them (the list, the custom picker grid, the form preview).
    await registerCustomSprites(this, this.customSprites);

    this.editingId = this.components[0]?.id || null;
    this.panelTab = 'list'; // only used on narrow screens: 'sprite' | 'list' | 'form'
    this.pickerTab = 'sheets'; // 'sheets' | 'custom'

    // Until the generated index loads, fall back to the sheets Boot preloaded.
    this.sheetList = SHEETS.map(s => ({ key: s.key, path: s.path, tile: s.frameW, kind: 'objects' }));
    this.sheetKey = this.editingComponent()?.sheet || 'kitchen';
    this.sheetIdx = Math.max(0, this.sheetList.findIndex(s => s.key === this.sheetKey));
    this.sheetDetail = null;

    this.build();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));

    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.onResize, this);
      if (this._resizeTimer) this._resizeTimer.remove(false);
    });

    this.initIndex();
  }

  onResize() {
    if (this._resizeTimer) this._resizeTimer.remove(false);
    this._resizeTimer = this.time.delayedCall(120, () => { this._resizeTimer = null; this.build(); });
  }

  editingComponent() { return this.components.find(c => c.id === this.editingId); }

  // ---------------------------------------------------------------- layout

  computeLayout() {
    const { width, height } = this.scale;
    const narrow = width < NARROW_BREAKPOINT;
    const margin = 8, gap = 16;
    const tabsBottom = narrow ? (PANEL_TAB_Y + PANEL_TAB_H) : TOOLBAR_H;
    const contentTop = tabsBottom + 12;
    const panelH = Math.max(200, height - contentTop - margin);

    let pickerX, pickerW, listX, listW, formX, formW;
    if (narrow) {
      pickerX = listX = formX = margin;
      pickerW = listW = formW = width - margin * 2;
    } else {
      pickerW = Phaser.Math.Clamp(Math.round(width * 0.20), 170, 260);
      listW = Phaser.Math.Clamp(Math.round(width * 0.24), 200, 320);
      pickerX = margin;
      listX = pickerX + pickerW + gap;
      formX = listX + listW + gap;
      formW = Math.max(260, width - formX - margin);
    }
    return { width, height, narrow, margin, gap, contentTop, panelH, pickerX, pickerW, listX, listW, formX, formW };
  }

  isPanelActive(name) { return !this.layout.narrow || this.panelTab === name; }

  /** Destroys every display object + input listener from the previous build so a full rebuild never leaks or duplicates. */
  teardown() {
    if (this._paletteWheel) { this.input.off('wheel', this._paletteWheel); this._paletteWheel = null; }
    if (this._palettePointerDown) { this.input.off('pointerdown', this._palettePointerDown); this._palettePointerDown = null; }
    if (this._palettePointerMove) { this.input.off('pointermove', this._palettePointerMove); this._palettePointerMove = null; }
    if (this._palettePointerUp) {
      this.input.off('pointerup', this._palettePointerUp);
      this.input.off('pointerupoutside', this._palettePointerUp);
      this._palettePointerUp = null;
    }
    if (this._customGridWheel) { this.input.off('wheel', this._customGridWheel); this._customGridWheel = null; }
    if (this._customGridPointerDown) { this.input.off('pointerdown', this._customGridPointerDown); this._customGridPointerDown = null; }
    if (this._customGridPointerMove) { this.input.off('pointermove', this._customGridPointerMove); this._customGridPointerMove = null; }
    if (this._customGridPointerUp) {
      this.input.off('pointerup', this._customGridPointerUp);
      this.input.off('pointerupoutside', this._customGridPointerUp);
      this._customGridPointerUp = null;
    }
    if (this._listWheel) { this.input.off('wheel', this._listWheel); this._listWheel = null; }
    if (this._listPointerDown) { this.input.off('pointerdown', this._listPointerDown); this._listPointerDown = null; }
    if (this._listPointerMove) { this.input.off('pointermove', this._listPointerMove); this._listPointerMove = null; }
    if (this._listPointerUp) {
      this.input.off('pointerup', this._listPointerUp);
      this.input.off('pointerupoutside', this._listPointerUp);
      this._listPointerUp = null;
    }
    // Graphics used only for a geometry mask live outside the display list
    // (this.make, not this.add), so children.removeAll() below won't catch them.
    if (this._paletteMaskShape) { this._paletteMaskShape.destroy(); this._paletteMaskShape = null; }
    if (this._customGridMaskShape) { this._customGridMaskShape.destroy(); this._customGridMaskShape = null; }
    if (this._listMaskShape) { this._listMaskShape.destroy(); this._listMaskShape = null; }
    this._listDrag = null;
    this._paletteDrag = null;
    this._customGridDrag = null;
    this.palette = null; // container destroyed by children.removeAll() below
    this.children.removeAll(true);
  }

  build() {
    this.teardown();
    this.layout = this.computeLayout();
    this.buildToolbar(this.layout);
    this.panelTabBtns = null;
    if (this.layout.narrow) this.buildPanelTabs(this.layout);
    this.buildSpritePicker(this.layout);
    this.buildList(this.layout);
    this.buildForm(this.layout);
    this.refreshList();
    this.loadEditing();
  }

  // ---------------------------------------------------------------- asset index

  async initIndex() {
    const index = await loadAssetIndex();
    if (!index?.sheets?.length) { this.setStatus('asset index unavailable — using preloaded sheets'); return; }
    this.sheetList = index.sheets;
    const cur = this.sheetList.findIndex(s => s.key === this.sheetKey);
    this.sheetIdx = cur >= 0 ? cur : 0;
    await this.selectSheet(this.sheetIdx);
  }

  currentSheet() { return this.sheetList.find(s => s.key === this.sheetKey) || this.sheetList[0]; }

  async selectSheet(i) {
    const sheet = this.sheetList[(i + this.sheetList.length) % this.sheetList.length];
    if (!sheet) return;
    this.sheetIdx = this.sheetList.indexOf(sheet);
    this.sheetKey = sheet.key;
    this.refreshSheetLabel('loading…');
    try { await ensureSheetTexture(this, sheet); }
    catch { this.refreshSheetLabel('load failed'); this.setStatus(`could not load ${sheet.key}`); return; }
    this.sheetDetail = await loadSheetDetail(sheet);
    this.palette?.destroy();
    this.buildPalette(this.layout);
    this.refreshSheetLabel();
    const c = this.editingComponent();
    this.setStatus(c ? `picking a sprite for "${c.label}"` : 'select a component to assign a sprite');
  }

  refreshSheetLabel(suffix) {
    const n = this.sheetList.length;
    const pos = this.sheetIdx != null ? `${this.sheetIdx + 1}/${n} ` : '';
    this.sheetLabel.setText(`${pos}${this.sheetKey}${suffix ? ` (${suffix})` : ''}`);
  }

  // ------------------------------------------------------------------- toolbar

  buildToolbar(layout) {
    const { width, narrow } = layout;
    this.add.rectangle(0, 0, width, TOOLBAR_H, 0x1b1b22).setOrigin(0).setDepth(100);
    this.add.text(10, 18, 'Components', {
      fontFamily: 'system-ui', fontSize: narrow ? '13px' : '16px', color: '#ffe9a8'
    });

    const btnW = narrow ? 52 : 70, btnH = 28, gap = 6;
    const specs = [
      { label: 'Menu', onClick: () => this.scene.start('Menu') },
      { label: 'Import', onClick: () => this.importData() },
      { label: 'Export', onClick: () => this.exportData() },
      { label: 'Save', onClick: () => this.save() },
    ];
    let x = width - 8 - btnW;
    for (const s of specs) {
      this.makeBtn(x, 14, btnW, btnH, s.label, s.onClick, narrow ? 10 : undefined);
      x -= btnW + gap;
    }

    if (!narrow) {
      this.statusText = this.add.text(x - 150, 24, '', { fontFamily: 'system-ui', fontSize: '12px', color: '#8fb6ff' })
        .setDepth(101).setOrigin(1, 0);
    } else {
      this.statusText = null;
    }
  }

  makeBtn(x, y, w, h, label, onClick, fontSize) {
    const bg = this.add.rectangle(x, y, w, h, 0x2b2b39).setOrigin(0).setStrokeStyle(1, 0x4a4a5e)
      .setInteractive({ useHandCursor: true }).setDepth(101);
    const size = fontSize ?? Math.max(10, h - 4);
    const txt = this.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'system-ui', fontSize: size + 'px', color: '#e6e6f0'
    }).setOrigin(0.5).setDepth(102);
    bg.on('pointerover', () => bg.setFillStyle(0x3a3a4d));
    bg.on('pointerout', () => bg.setFillStyle(0x2b2b39));
    bg.on('pointerdown', onClick);
    return { bg, txt };
  }

  setStatus(msg) { this.statusText?.setText(msg || ''); }

  // ----------------------------------------------- narrow-screen panel tabs

  buildPanelTabs(layout) {
    const w = (layout.width - 16 - 16) / 3;
    const defs = [['sprite', 'Sprite'], ['list', 'List'], ['form', 'Form']];
    this.panelTabBtns = {};
    defs.forEach(([key, label], i) => {
      this.panelTabBtns[key] = this.makeBtn(8 + i * (w + 8), PANEL_TAB_Y, w, PANEL_TAB_H, label, () => this.setPanelTab(key), 10);
    });
    this.refreshPanelTabButtons();
  }

  refreshPanelTabButtons() {
    if (!this.panelTabBtns) return;
    for (const [key, btn] of Object.entries(this.panelTabBtns)) {
      btn.bg.setFillStyle(this.panelTab === key ? 0x4a4a5e : 0x2b2b39);
    }
  }

  setPanelTab(name) {
    if (this.panelTab === name) return;
    this.panelTab = name;
    this.refreshPanelTabButtons();
    this.showPickerTab(this.pickerTab);
    this.refreshList();
    this.refreshFormVisibility();
  }

  // ------------------------------------------------------------- sprite picker

  buildSpritePicker(layout) {
    const panelX = layout.pickerX, panelY = layout.contentTop;
    const panelW = layout.pickerW, panelH = layout.panelH;
    this.pickerPanelX = panelX;
    this.pickerPanelY = panelY;
    this.pickerPanelW = panelW;
    this.pickerPanelH = panelH;

    this.sheetsTabBtn = this.makeBtn(panelX, panelY, panelW / 2 - 2, 24, 'Sheets', () => this.onPickerTabClick('sheets'));
    this.customTabBtn = this.makeBtn(panelX + panelW / 2 + 2, panelY, panelW / 2 - 2, 24, 'Custom', () => this.onPickerTabClick('custom'));

    this.buildSheetsPicker(panelX, panelY + 28, panelW, panelH - 28);
    this.buildCustomPicker(panelX, panelY + 28, panelW, panelH - 28);
    this.showPickerTab(this.pickerTab);
  }

  onPickerTabClick(tab) {
    if (this.pickerTab === tab) return;
    this.showPickerTab(tab);
  }

  showPickerTab(tab) {
    this.pickerTab = tab;
    const active = this.isPanelActive('sprite');
    this.sheetsTabBtn.bg.setVisible(active); this.sheetsTabBtn.txt.setVisible(active);
    this.customTabBtn.bg.setVisible(active); this.customTabBtn.txt.setVisible(active);
    this.sheetsTabBtn.bg.setFillStyle(tab === 'sheets' ? 0x4a4a5e : 0x2b2b39);
    this.customTabBtn.bg.setFillStyle(tab === 'custom' ? 0x4a4a5e : 0x2b2b39);

    const sheetsVisible = active && tab === 'sheets';
    this.sheetPrevBtn.bg.setVisible(sheetsVisible); this.sheetPrevBtn.txt.setVisible(sheetsVisible);
    this.sheetNextBtn.bg.setVisible(sheetsVisible); this.sheetNextBtn.txt.setVisible(sheetsVisible);
    this.sheetLabel.setVisible(sheetsVisible);
    this.palette?.setVisible(sheetsVisible);

    const customVisible = active && tab === 'custom';
    this.uploadBtn.bg.setVisible(customVisible); this.uploadBtn.txt.setVisible(customVisible);
    this.customGridContainer.setVisible(customVisible);
  }

  buildSheetsPicker(panelX, panelY, panelW, panelH) {
    this.sheetPrevBtn = this.makeBtn(panelX, panelY, 24, 22, '◀', () => this.selectSheet(this.sheetIdx - 1));
    this.sheetNextBtn = this.makeBtn(panelX + 28, panelY, 24, 22, '▶', () => this.selectSheet(this.sheetIdx + 1));
    this.sheetLabel = this.add.text(panelX + 58, panelY + 5, this.sheetKey, {
      fontFamily: 'system-ui', fontSize: '12px', color: '#ffe9a8'
    }).setDepth(101);

    this.paletteY = panelY + 30;
    this.palettePanelH = panelH - 30;
    this.buildPalette();
  }

  buildPalette() {
    const sheet = this.currentSheet();
    if (!sheet || !this.textures.exists(sheet.key)) return;
    const tile = sheet.tile || 48;
    const only = nonEmptyFrames(this.sheetDetail);

    this.palette = new Palette(this, sheet.key, tile, tile,
      (frameIdx) => this.pickSpriteFrame(frameIdx),
      { cols: 4, only });

    const panelX = this.pickerPanelX, panelW = this.pickerPanelW;
    const panelH = this.palettePanelH;
    this.palette.container.setPosition(panelX, this.paletteY);
    this.palette.container.setDepth(50);
    this.palette.setVisible(this.isPanelActive('sprite') && this.pickerTab === 'sheets');

    if (this._paletteMaskShape) this._paletteMaskShape.destroy();
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, this.paletteY, panelW, panelH - 4);
    this.palette.container.setMask(maskShape.createGeometryMask());
    this._paletteMaskShape = maskShape;

    if (this._paletteWheel) this.input.off('wheel', this._paletteWheel);
    this._paletteWheel = (pointer) => {
      if (!this.isPanelActive('sprite') || this.pickerTab !== 'sheets') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = this.paletteY + Math.min(0, panelH - 4 - this.palette.contentHeight);
      this.palette.container.y = Phaser.Math.Clamp(this.palette.container.y - Math.sign(pointer.event.deltaY) * 50, minY, this.paletteY);
    };
    this.input.on('wheel', this._paletteWheel);

    if (this._palettePointerDown) this.input.off('pointerdown', this._palettePointerDown);
    if (this._palettePointerMove) this.input.off('pointermove', this._palettePointerMove);
    if (this._palettePointerUp) { this.input.off('pointerup', this._palettePointerUp); this.input.off('pointerupoutside', this._palettePointerUp); }
    this._palettePointerDown = (pointer) => {
      if (!this.isPanelActive('sprite') || this.pickerTab !== 'sheets') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW || pointer.y < this.paletteY || pointer.y > this.paletteY + panelH) return;
      this._paletteDrag = { startY: pointer.y, startContainerY: this.palette.container.y };
    };
    this._palettePointerMove = (pointer) => {
      if (!this._paletteDrag || !pointer.isDown) return;
      const dy = pointer.y - this._paletteDrag.startY;
      const minY = this.paletteY + Math.min(0, panelH - 4 - this.palette.contentHeight);
      this.palette.container.y = Phaser.Math.Clamp(this._paletteDrag.startContainerY + dy, minY, this.paletteY);
    };
    this._palettePointerUp = () => { this._paletteDrag = null; };
    this.input.on('pointerdown', this._palettePointerDown);
    this.input.on('pointermove', this._palettePointerMove);
    this.input.on('pointerup', this._palettePointerUp);
    this.input.on('pointerupoutside', this._palettePointerUp);
  }

  /** Clicking a palette frame assigns it (as a pack sheet reference) to the component currently being edited. */
  pickSpriteFrame(frameIdx) {
    const c = this.editingComponent();
    if (!c) { this.setStatus('select a component first'); return; }
    c.custom = false;
    c.sheet = this.sheetKey;
    c.frame = frameIdx;
    delete c.customId;
    this.setStatus(describeFrame(this.sheetDetail, frameIdx));
    this.refreshList();
    this.refreshPreview();
  }

  // -------------------------------------------------------------- custom sprites

  buildCustomPicker(panelX, panelY, panelW, panelH) {
    this.uploadBtn = this.makeBtn(panelX, panelY, panelW, 26, '+ Upload Image', () => this.uploadCustomSprite());

    const gridY = panelY + 32;
    const gridH = panelH - 32;
    this.customGridPanelX = panelX;
    this.customGridPanelY = gridY;
    this.customGridPanelW = panelW;
    this.customGridPanelH = gridH;
    this.customGridContainer = this.add.container(panelX, gridY).setDepth(50);
    this.refreshCustomGrid();

    if (this._customGridMaskShape) this._customGridMaskShape.destroy();
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, gridY, panelW, gridH - 4);
    this.customGridContainer.setMask(maskShape.createGeometryMask());
    this._customGridMaskShape = maskShape;

    if (this._customGridWheel) this.input.off('wheel', this._customGridWheel);
    this._customGridWheel = (pointer) => {
      if (!this.isPanelActive('sprite') || this.pickerTab !== 'custom') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW || pointer.y < gridY || pointer.y > gridY + gridH) return;
      const minY = gridY + Math.min(0, gridH - 4 - (this.customGridContentHeight || 0));
      this.customGridContainer.y = Phaser.Math.Clamp(this.customGridContainer.y - Math.sign(pointer.event.deltaY) * 50, minY, gridY);
    };
    this.input.on('wheel', this._customGridWheel);

    if (this._customGridPointerDown) this.input.off('pointerdown', this._customGridPointerDown);
    if (this._customGridPointerMove) this.input.off('pointermove', this._customGridPointerMove);
    if (this._customGridPointerUp) { this.input.off('pointerup', this._customGridPointerUp); this.input.off('pointerupoutside', this._customGridPointerUp); }
    this._customGridPointerDown = (pointer) => {
      if (!this.isPanelActive('sprite') || this.pickerTab !== 'custom') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW || pointer.y < gridY || pointer.y > gridY + gridH) return;
      this._customGridDrag = { startY: pointer.y, startContainerY: this.customGridContainer.y };
    };
    this._customGridPointerMove = (pointer) => {
      if (!this._customGridDrag || !pointer.isDown) return;
      const dy = pointer.y - this._customGridDrag.startY;
      const minY = gridY + Math.min(0, gridH - 4 - (this.customGridContentHeight || 0));
      this.customGridContainer.y = Phaser.Math.Clamp(this._customGridDrag.startContainerY + dy, minY, gridY);
    };
    this._customGridPointerUp = () => { this._customGridDrag = null; };
    this.input.on('pointerdown', this._customGridPointerDown);
    this.input.on('pointermove', this._customGridPointerMove);
    this.input.on('pointerup', this._customGridPointerUp);
    this.input.on('pointerupoutside', this._customGridPointerUp);
  }

  refreshCustomGrid() {
    this.customGridContainer.removeAll(true);
    const cellW = 56, cellH = 56, pad = 6;
    const cols = Math.max(1, Math.floor(this.customGridPanelW / (cellW + pad)));
    const editing = this.editingComponent();

    this.customSprites.forEach((cs, i) => {
      const cx = (i % cols) * (cellW + pad), cy = Math.floor(i / cols) * (cellH + pad);
      const selected = !!(editing?.custom && editing.customId === cs.id);
      const bg = this.add.rectangle(cx, cy, cellW, cellH, selected ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      let img;
      try { img = this.add.image(cx + cellW / 2, cy + cellH / 2 - 6, customTexKey(cs.id)).setDisplaySize(36, 36); }
      catch { img = this.add.rectangle(cx + cellW / 2, cy + cellH / 2 - 6, 32, 32, 0x4a4a5e); }
      const label = this.add.text(cx + cellW / 2, cy + cellH - 8, cs.name || '', {
        fontFamily: 'system-ui', fontSize: '8px', color: '#8fb6ff'
      }).setOrigin(0.5);
      bg.on('pointerdown', () => this.pickCustomSprite(cs.id));
      this.customGridContainer.add([bg, img, label]);
    });
    this.customGridContentHeight = Math.ceil(this.customSprites.length / cols) * (cellH + pad);
  }

  async uploadCustomSprite() {
    try {
      const dataURL = await Storage.pickImage();
      const record = { id: 'cs' + Date.now(), name: `Custom ${this.customSprites.length + 1}`, dataURL };
      await registerCustomSprite(this, record);
      this.customSprites.push(record);
      this.refreshCustomGrid();
      this.setStatus('uploaded — click it below to assign to the selected component');
    } catch (e) {
      if (e && e.message !== 'No file selected') this.flash('Upload failed: ' + e.message);
    }
  }

  /** Clicking an uploaded sprite assigns it (as a custom reference) to the component currently being edited. */
  pickCustomSprite(customId) {
    const c = this.editingComponent();
    if (!c) { this.setStatus('select a component first'); return; }
    c.custom = true;
    c.customId = customId;
    delete c.sheet;
    delete c.frame;
    this.refreshCustomGrid();
    this.refreshList();
    this.refreshPreview();
  }

  // ---------------------------------------------------------------------- list

  buildList(layout) {
    const x = layout.listX;
    const w = layout.listW;
    const headingY = layout.contentTop;
    const containerY = headingY + 28;
    const panelH = layout.panelH - 28;

    this.listHeading = this.add.text(x, headingY, 'Components', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });
    this.listContainer = this.add.container(x, containerY).setDepth(10);

    this.listPanelX = x; this.listPanelY = containerY; this.listPanelW = w; this.listPanelH = panelH;
    this.listRowW = Math.max(160, w - 20);

    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(x, containerY, w, panelH - 4);
    this.listContainer.setMask(maskShape.createGeometryMask());
    this._listMaskShape = maskShape;

    this._listWheel = (pointer) => {
      if (!this.isPanelActive('list')) return;
      if (pointer.x < x || pointer.x > x + w || pointer.y < containerY || pointer.y > containerY + panelH) return;
      const minY = containerY + Math.min(0, panelH - 4 - (this.listContentHeight || 0));
      this.listContainer.y = Phaser.Math.Clamp(this.listContainer.y - Math.sign(pointer.event.deltaY) * 50, minY, containerY);
    };
    this.input.on('wheel', this._listWheel);

    // Drag-to-scroll so the list is reachable on touch devices, which never fire 'wheel'.
    this._listPointerDown = (pointer) => {
      if (!this.isPanelActive('list')) return;
      if (pointer.x < x || pointer.x > x + w || pointer.y < containerY || pointer.y > containerY + panelH) return;
      this._listDrag = { startY: pointer.y, startContainerY: this.listContainer.y };
    };
    this._listPointerMove = (pointer) => {
      if (!this._listDrag || !pointer.isDown) return;
      const dy = pointer.y - this._listDrag.startY;
      const minY = containerY + Math.min(0, panelH - 4 - (this.listContentHeight || 0));
      this.listContainer.y = Phaser.Math.Clamp(this._listDrag.startContainerY + dy, minY, containerY);
    };
    this._listPointerUp = () => { this._listDrag = null; };
    this.input.on('pointerdown', this._listPointerDown);
    this.input.on('pointermove', this._listPointerMove);
    this.input.on('pointerup', this._listPointerUp);
    this.input.on('pointerupoutside', this._listPointerUp);
  }

  refreshList() {
    this.listContainer.removeAll(true);
    const active = this.isPanelActive('list');
    this.listContainer.setVisible(active);
    this.listHeading.setVisible(active);

    const rowH = 40, rowW = this.listRowW;
    this.components.forEach((c, i) => {
      const y = i * rowH;
      const bg = this.add.rectangle(0, y, rowW, 36, c.id === this.editingId ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      let icon;
      try {
        const ref = componentTextureRef(c);
        icon = this.add.image(20, y + 18, ref.key, ref.frame).setDisplaySize(28, 28);
        if (c.tint != null) icon.setTint(c.tint);
      } catch { icon = this.add.rectangle(20, y + 18, 24, 24, 0x4a4a5e); }
      const name = this.add.text(42, y + 6, c.label || '(unnamed)', { fontFamily: 'system-ui', fontSize: '13px', color: '#e6e6f0' });
      const sub = this.add.text(42, y + 21, `${c.category || 'component'} · ${c.solid ? 'solid' : 'walkable'}`, {
        fontFamily: 'system-ui', fontSize: '10px', color: '#8fb6ff'
      });
      bg.on('pointerdown', () => { this.editingId = c.id; this.loadEditing(); this.refreshList(); });
      bg.on('pointerover', () => { if (c.id !== this.editingId) bg.setFillStyle(0x3a3a4d); });
      bg.on('pointerout', () => { if (c.id !== this.editingId) bg.setFillStyle(0x2b2b39); });
      this.listContainer.add([bg, icon, name, sub]);
    });

    const addY = this.components.length * rowH + 4;
    const addBg = this.add.rectangle(0, addY, rowW, 32, 0x2b4a2b).setOrigin(0, 0).setStrokeStyle(1, 0x4a6a4a)
      .setInteractive({ useHandCursor: true });
    const addTxt = this.add.text(rowW / 2, addY + 16, '+ Add component', { fontFamily: 'system-ui', fontSize: '14px', color: '#9aff9a' }).setOrigin(0.5);
    addBg.on('pointerdown', () => this.addComponent());
    addBg.on('pointerover', () => addBg.setFillStyle(0x3a6a3a));
    addBg.on('pointerout', () => addBg.setFillStyle(0x2b4a2b));
    this.listContainer.add([addBg, addTxt]);
    let nextY = addY + 40;

    if (this.editingId) {
      const delBg = this.add.rectangle(0, nextY, rowW, 28, 0x4a2b2b).setOrigin(0, 0).setStrokeStyle(1, 0x6a4a4a)
        .setInteractive({ useHandCursor: true });
      const delTxt = this.add.text(rowW / 2, nextY + 14, 'Delete selected', { fontFamily: 'system-ui', fontSize: '13px', color: '#ff9a9a' }).setOrigin(0.5);
      delBg.on('pointerdown', () => this.deleteComponent());
      delBg.on('pointerover', () => delBg.setFillStyle(0x6a3a3a));
      delBg.on('pointerout', () => delBg.setFillStyle(0x4a2b2b));
      this.listContainer.add([delBg, delTxt]);
      nextY += 28;
    }
    this.listContentHeight = nextY;

    // Clamp scroll in case the catalog shrank (e.g. a delete) since the last scroll position.
    const minY = this.listPanelY + Math.min(0, this.listPanelH - 4 - this.listContentHeight);
    this.listContainer.y = Phaser.Math.Clamp(this.listContainer.y, minY, this.listPanelY);
  }

  // ---------------------------------------------------------------------- form

  buildForm(layout) {
    const x = layout.formX, w = layout.formW, y0 = layout.contentTop;

    this.formHeading = this.add.text(x, y0, 'Edit component', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });
    this.preview = this.add.image(x + 24, y0 + 66, '__pixel').setDisplaySize(40, 40);
    this.formObjects = [this.formHeading, this.preview];
    const push = (...objs) => this.formObjects.push(...objs);

    push(this.add.text(x, y0 + 96, 'Label', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.nameInput = this.add.dom(x, y0 + 124).createFromHTML(
      `<input type="text" style="width:${Math.min(240, w - 16)}px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.nameInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.nameInput);

    push(this.add.text(x, y0 + 146, 'Category (free text, for your own grouping)', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.categoryInput = this.add.dom(x, y0 + 174).createFromHTML(
      `<input type="text" placeholder="e.g. furniture" style="width:${Math.min(200, w - 16)}px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.categoryInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.categoryInput);

    // Solid — the collision default the Floor Plan Editor's Component tool applies on placement.
    this.solidInput = this.add.dom(x, y0 + 206).createFromHTML(
      `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:13px;color:#c9c9d6;cursor:pointer;">
         <input type="checkbox" style="width:16px;height:16px;" />
         Solid (blocks movement when placed)
       </label>`
    ).setOrigin(0, 0.5);
    this.getInput(this.solidInput).addEventListener('change', () => this.applyFormToEditing());
    push(this.solidInput);

    // Tint (optional hex color applied to the icon — same pattern as menu items).
    push(this.add.text(x, y0 + 238, 'Tint (hex, blank = none)', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.tintInput = this.add.dom(x, y0 + 266).createFromHTML(
      `<input type="text" placeholder="e.g. 8b2a52" style="width:140px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.tintInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.tintInput);

    push(this.add.text(x, this.layout.height - 40,
      'Pick a sprite from the left panel — Sheets for pack art, Custom for your own uploaded images — then use the Component tool in the Floor Plan Editor to paint with it.',
      { fontFamily: 'system-ui', fontSize: '12px', color: '#7a7a8a', wordWrap: { width: w } }));

    this.refreshFormVisibility();
  }

  refreshFormVisibility() {
    const active = this.isPanelActive('form');
    for (const o of this.formObjects) o.setVisible(active);
  }

  getInput(domEl) { return domEl.node.querySelector('input,select'); }

  /** setTexture() alone resets the frame's base size but not scale, so a display size set against
   * the placeholder '__pixel' texture would otherwise carry over — always re-lock the size after. */
  setPreviewTexture(key, frame, tint) {
    this.preview.setTexture(key, frame).setDisplaySize(40, 40);
    if (tint != null) this.preview.setTint(tint); else this.preview.clearTint();
  }

  refreshPreview() {
    const c = this.editingComponent();
    if (!c) { this.preview.setTexture('__pixel').setDisplaySize(40, 40); this.preview.clearTint(); return; }
    try {
      const ref = componentTextureRef(c);
      this.setPreviewTexture(ref.key, ref.frame, c.tint);
    } catch { this.preview.setTexture('__pixel').setDisplaySize(40, 40); this.preview.clearTint(); }
  }

  loadEditing() {
    const c = this.editingComponent();
    if (!c) return;
    this.getInput(this.nameInput).value = c.label || '';
    this.getInput(this.categoryInput).value = c.category || '';
    this.getInput(this.solidInput).checked = !!c.solid;
    this.getInput(this.tintInput).value = c.tint != null ? c.tint.toString(16) : '';
    this.refreshPreview();
    if (c.custom) {
      this.showPickerTab('custom');
      this.refreshCustomGrid();
    } else {
      this.showPickerTab('sheets');
      // Jump the sprite picker to this component's current sheet.
      const idx = this.sheetList.findIndex(s => s.key === c.sheet);
      if (idx >= 0 && idx !== this.sheetIdx) this.selectSheet(idx);
    }
  }

  applyFormToEditing() {
    const c = this.editingComponent();
    if (!c) return;
    c.label = this.getInput(this.nameInput).value || '(unnamed)';
    c.category = this.getInput(this.categoryInput).value || '';
    c.solid = this.getInput(this.solidInput).checked;
    const tintRaw = this.getInput(this.tintInput).value.trim().replace(/^#/, '');
    c.tint = /^[0-9a-fA-F]{1,6}$/.test(tintRaw) ? parseInt(tintRaw, 16) : null;
    this.refreshPreview();
    this.refreshList();
  }

  addComponent() {
    const id = 'comp' + Date.now();
    this.components.push({
      id, label: 'New Component', category: '', solid: false, tint: null,
      custom: false, sheet: this.sheetKey, frame: 0
    });
    this.editingId = id;
    this.refreshList();
    this.loadEditing();
  }

  deleteComponent() {
    this.components = this.components.filter(c => c.id !== this.editingId);
    this.editingId = this.components[0]?.id || null;
    this.refreshList();
    if (this.editingId) this.loadEditing();
  }

  save() {
    Storage.saveComponents({ customSprites: this.customSprites, components: this.components });
    this.flash('Components saved.');
  }

  exportData() {
    Storage.downloadJSON({ customSprites: this.customSprites, components: this.components }, 'components.json');
  }

  async importData() {
    try {
      const data = await Storage.pickJSON();
      this.customSprites = data.customSprites || [];
      this.components = data.components || [];
      await registerCustomSprites(this, this.customSprites);
      Storage.saveComponents({ customSprites: this.customSprites, components: this.components });
      this.editingId = this.components[0]?.id || null;
      this.refreshCustomGrid();
      this.refreshList();
      this.loadEditing();
      this.flash('Components imported & saved.');
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
