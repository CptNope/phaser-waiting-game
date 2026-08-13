import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { SHEETS, STATION_KEYS, ALLERGENS } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { loadMenuItems } from '../data/menu.js';
import { Palette } from '../core/Palette.js';
import { loadAssetIndex, loadSheetDetail, ensureSheetTexture, nonEmptyFrames, describeFrame } from '../data/assetIndex.js';

const TOOLBAR_H = 56;
const PANEL_TAB_Y = TOOLBAR_H + 6;
const PANEL_TAB_H = 24;
const NARROW_BREAKPOINT = 760;

export class MenuEditorScene extends Phaser.Scene {
  constructor() { super('MenuEditor'); }

  async create() {
    this.cameras.main.setBackgroundColor('#23232c');
    this.items = await loadMenuItems();
    this.editingId = this.items[0]?.id || null;
    this.panelTab = 'list'; // only used on narrow screens: 'sprite' | 'list' | 'form'

    // Until the generated index loads, fall back to the sheets Boot preloaded.
    this.sheetList = SHEETS.map(s => ({ key: s.key, path: s.path, tile: s.frameW, kind: 'objects' }));
    this.sheetKey = this.editingItem()?.sheet || 'kitchen';
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

  editingItem() { return this.items.find(x => x.id === this.editingId); }

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
    if (this._listMaskShape) { this._listMaskShape.destroy(); this._listMaskShape = null; }
    this._listDrag = null;
    this._paletteDrag = null;
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
    const g = this.editingItem();
    this.setStatus(g ? `picking a sprite for "${g.name}"` : 'select a menu item to assign a sprite');
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
    this.add.text(10, 18, 'Menu Editor', {
      fontFamily: 'system-ui', fontSize: narrow ? '13px' : '16px', color: '#ffe9a8'
    });

    const btnW = narrow ? 52 : 70, btnH = 28, gap = 6;
    const specs = [
      { label: 'Menu', onClick: () => this.scene.start('Menu') },
      { label: 'Import', onClick: () => this.importItems() },
      { label: 'Export', onClick: () => Storage.downloadJSON(this.items, 'menu.json') },
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
    this.refreshSpriteVisibility();
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

    this.spriteHeading = this.add.text(panelX, panelY - 4, 'Sprite', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }).setDepth(60);
    this.sheetPrevBtn = this.makeBtn(panelX, panelY + 14, 24, 22, '◀', () => this.selectSheet(this.sheetIdx - 1));
    this.sheetNextBtn = this.makeBtn(panelX + 28, panelY + 14, 24, 22, '▶', () => this.selectSheet(this.sheetIdx + 1));
    this.sheetLabel = this.add.text(panelX + 58, panelY + 19, this.sheetKey, {
      fontFamily: 'system-ui', fontSize: '12px', color: '#ffe9a8'
    }).setDepth(101);

    this.paletteY = panelY + 44;
    this.buildPalette(layout);
    this.refreshSpriteVisibility();
  }

  refreshSpriteVisibility() {
    const active = this.isPanelActive('sprite');
    this.spriteHeading.setVisible(active);
    this.sheetPrevBtn.bg.setVisible(active); this.sheetPrevBtn.txt.setVisible(active);
    this.sheetNextBtn.bg.setVisible(active); this.sheetNextBtn.txt.setVisible(active);
    this.sheetLabel.setVisible(active);
    this.palette?.setVisible(active);
  }

  buildPalette(layout) {
    const sheet = this.currentSheet();
    if (!sheet || !this.textures.exists(sheet.key)) return;
    const tile = sheet.tile || 48;
    const only = nonEmptyFrames(this.sheetDetail);

    this.palette = new Palette(this, sheet.key, tile, tile,
      (frameIdx) => this.pickSpriteFrame(frameIdx),
      { cols: 4, only });

    const panelX = this.pickerPanelX, panelW = this.pickerPanelW;
    const panelH = this.pickerPanelY + this.pickerPanelH - this.paletteY;
    this.palette.container.setPosition(panelX, this.paletteY);
    this.palette.container.setDepth(50);
    this.palette.setVisible(this.isPanelActive('sprite'));

    if (this._paletteMaskShape) this._paletteMaskShape.destroy();
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, this.paletteY, panelW, panelH - 4);
    this.palette.container.setMask(maskShape.createGeometryMask());
    this._paletteMaskShape = maskShape;

    if (this._paletteWheel) this.input.off('wheel', this._paletteWheel);
    this._paletteWheel = (pointer) => {
      if (!this.isPanelActive('sprite')) return;
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = this.paletteY + Math.min(0, panelH - 4 - this.palette.contentHeight);
      this.palette.container.y = Phaser.Math.Clamp(this.palette.container.y - Math.sign(pointer.event.deltaY) * 50, minY, this.paletteY);
    };
    this.input.on('wheel', this._paletteWheel);

    // Drag-to-scroll so the palette is reachable on touch devices, which never fire 'wheel'.
    if (this._palettePointerDown) this.input.off('pointerdown', this._palettePointerDown);
    if (this._palettePointerMove) this.input.off('pointermove', this._palettePointerMove);
    if (this._palettePointerUp) { this.input.off('pointerup', this._palettePointerUp); this.input.off('pointerupoutside', this._palettePointerUp); }
    this._palettePointerDown = (pointer) => {
      if (!this.isPanelActive('sprite')) return;
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

  /** Clicking a palette frame assigns it to the item currently being edited. */
  pickSpriteFrame(frameIdx) {
    const g = this.editingItem();
    if (!g) { this.setStatus('select a menu item first'); return; }
    g.sheet = this.sheetKey;
    g.frame = frameIdx;
    this.setStatus(describeFrame(this.sheetDetail, frameIdx));
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

    this.listHeading = this.add.text(x, headingY, 'Items', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });
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
    this.items.forEach((g, i) => {
      const y = i * rowH;
      const bg = this.add.rectangle(0, y, rowW, 36, g.id === this.editingId ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      let icon;
      try {
        icon = this.add.image(20, y + 18, g.sheet, g.frame).setDisplaySize(28, 28);
        if (g.tint != null) icon.setTint(g.tint);
      } catch { icon = this.add.rectangle(20, y + 18, 24, 24, 0x4a4a5e); }
      const name = this.add.text(42, y + 6, g.name || '(unnamed)', { fontFamily: 'system-ui', fontSize: '13px', color: '#e6e6f0' });
      const sub = this.add.text(42, y + 21, `${g.category}${g.station ? ' · ' + g.station : ''}`, {
        fontFamily: 'system-ui', fontSize: '10px', color: '#8fb6ff'
      });
      bg.on('pointerdown', () => { this.editingId = g.id; this.loadEditing(); this.refreshList(); });
      bg.on('pointerover', () => { if (g.id !== this.editingId) bg.setFillStyle(0x3a3a4d); });
      bg.on('pointerout', () => { if (g.id !== this.editingId) bg.setFillStyle(0x2b2b39); });
      this.listContainer.add([bg, icon, name, sub]);
    });

    const addY = this.items.length * rowH + 4;
    const addBg = this.add.rectangle(0, addY, rowW, 32, 0x2b4a2b).setOrigin(0, 0).setStrokeStyle(1, 0x4a6a4a)
      .setInteractive({ useHandCursor: true });
    const addTxt = this.add.text(rowW / 2, addY + 16, '+ Add item', { fontFamily: 'system-ui', fontSize: '14px', color: '#9aff9a' }).setOrigin(0.5);
    addBg.on('pointerdown', () => this.addItem());
    addBg.on('pointerover', () => addBg.setFillStyle(0x3a6a3a));
    addBg.on('pointerout', () => addBg.setFillStyle(0x2b4a2b));
    this.listContainer.add([addBg, addTxt]);
    let nextY = addY + 40;

    if (this.editingId) {
      const delBg = this.add.rectangle(0, nextY, rowW, 28, 0x4a2b2b).setOrigin(0, 0).setStrokeStyle(1, 0x6a4a4a)
        .setInteractive({ useHandCursor: true });
      const delTxt = this.add.text(rowW / 2, nextY + 14, 'Delete selected', { fontFamily: 'system-ui', fontSize: '13px', color: '#ff9a9a' }).setOrigin(0.5);
      delBg.on('pointerdown', () => this.deleteItem());
      delBg.on('pointerover', () => delBg.setFillStyle(0x6a3a3a));
      delBg.on('pointerout', () => delBg.setFillStyle(0x4a2b2b));
      this.listContainer.add([delBg, delTxt]);
      nextY += 28;
    }
    this.listContentHeight = nextY;

    // Clamp scroll in case the roster shrank (e.g. a delete) since the last scroll position.
    const minY = this.listPanelY + Math.min(0, this.listPanelH - 4 - this.listContentHeight);
    this.listContainer.y = Phaser.Math.Clamp(this.listContainer.y, minY, this.listPanelY);
  }

  // ---------------------------------------------------------------------- form

  buildForm(layout) {
    const x = layout.formX, w = layout.formW, y0 = layout.contentTop;

    this.formHeading = this.add.text(x, y0, 'Edit item', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });
    this.preview = this.add.image(x + 24, y0 + 66, '__pixel').setDisplaySize(40, 40);
    this.formObjects = [this.formHeading, this.preview];
    const push = (...objs) => this.formObjects.push(...objs);

    push(this.add.text(x, y0 + 96, 'Name', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.nameInput = this.add.dom(x, y0 + 124).createFromHTML(
      `<input type="text" style="width:${Math.min(240, w - 16)}px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.nameInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.nameInput);

    // Category toggle (Drink / Food).
    push(this.add.text(x, y0 + 146, 'Category', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.drinkTabBtn = this.makeBtn(x, y0 + 166, 90, 26, 'Drink', () => this.setCategory('drink'));
    this.foodTabBtn = this.makeBtn(x + 96, y0 + 166, 90, 26, 'Food', () => this.setCategory('food'));
    push(this.drinkTabBtn.bg, this.drinkTabBtn.txt, this.foodTabBtn.bg, this.foodTabBtn.txt);

    // Station picker — food items only.
    this.stationLabel = this.add.text(x, y0 + 202, 'Station', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.stationBtns = STATION_KEYS.map((s, i) => this.makeBtn(x + i * 46, y0 + 222, 42, 24, s.label, () => this.setStation(s.key), 10));
    push(this.stationLabel, ...this.stationBtns.flatMap(b => [b.bg, b.txt]));

    // Tint (optional hex color applied to the icon — e.g. reusing one sprite
    // for two items, like Wine reusing the Beer bottle with a burgundy tint).
    push(this.add.text(x, y0 + 256, 'Tint (hex, blank = none)', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.tintInput = this.add.dom(x, y0 + 284).createFromHTML(
      `<input type="text" placeholder="e.g. 8b2a52" style="width:140px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.tintInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.tintInput);

    // Allergens.
    push(this.add.text(x, y0 + 312, 'Allergens', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.allergenInputs = {};
    ALLERGENS.forEach((name, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const ax = x + col * 130, ay = y0 + 336 + row * 26;
      const dom = this.add.dom(ax, ay).createFromHTML(
        `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:12px;color:#c9c9d6;cursor:pointer;">
           <input type="checkbox" style="width:14px;height:14px;" /> ${name}
         </label>`
      ).setOrigin(0, 0.5);
      this.getInput(dom).addEventListener('change', () => this.applyFormToEditing());
      this.allergenInputs[name] = dom;
      push(dom);
    });

    push(this.add.text(x, this.layout.height - 40,
      'Pick a sprite from the left panel to assign it to the selected item.',
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
  setPreviewTexture(sheet, frame, tint) {
    this.preview.setTexture(sheet, frame).setDisplaySize(40, 40);
    if (tint != null) this.preview.setTint(tint); else this.preview.clearTint();
  }

  setCategory(category) {
    const g = this.editingItem();
    if (!g) return;
    g.category = category;
    if (category === 'drink') g.station = null;
    else if (!g.station) g.station = STATION_KEYS[0].key;
    this.refreshCategoryBtns();
    this.refreshList();
  }

  setStation(key) {
    const g = this.editingItem();
    if (!g || g.category !== 'food') return;
    g.station = key;
    this.refreshStationBtns();
    this.refreshList();
  }

  refreshCategoryBtns() {
    const g = this.editingItem();
    this.drinkTabBtn.bg.setFillStyle(g?.category === 'drink' ? 0x4a4a5e : 0x2b2b39);
    this.foodTabBtn.bg.setFillStyle(g?.category === 'food' ? 0x4a4a5e : 0x2b2b39);
    const showStation = g?.category === 'food';
    const formActive = this.isPanelActive('form');
    this.stationLabel.setVisible(formActive && showStation);
    this.stationBtns.forEach(b => { b.bg.setVisible(formActive && showStation); b.txt.setVisible(formActive && showStation); });
    if (showStation) this.refreshStationBtns();
  }

  refreshStationBtns() {
    const g = this.editingItem();
    this.stationBtns.forEach((b, i) => {
      const on = STATION_KEYS[i].key === g?.station;
      b.bg.setFillStyle(on ? 0x4a4a5e : 0x2b2b39);
      b.txt.setColor(on ? '#ffe9a8' : '#e6e6f0');
    });
  }

  refreshPreview() {
    const g = this.editingItem();
    if (!g) { this.preview.setTexture('__pixel').setDisplaySize(40, 40); this.preview.clearTint(); return; }
    try { this.setPreviewTexture(g.sheet, g.frame, g.tint); }
    catch { this.preview.setTexture('__pixel').setDisplaySize(40, 40); this.preview.clearTint(); }
  }

  loadEditing() {
    const g = this.editingItem();
    if (!g) return;
    this.getInput(this.nameInput).value = g.name || '';
    this.getInput(this.tintInput).value = g.tint != null ? g.tint.toString(16) : '';
    for (const name of ALLERGENS) this.getInput(this.allergenInputs[name]).checked = (g.allergens || []).includes(name);
    this.refreshCategoryBtns();
    this.refreshPreview();
    // Jump the sprite picker to this item's current sheet.
    const idx = this.sheetList.findIndex(s => s.key === g.sheet);
    if (idx >= 0 && idx !== this.sheetIdx) this.selectSheet(idx);
  }

  applyFormToEditing() {
    const g = this.editingItem();
    if (!g) return;
    g.name = this.getInput(this.nameInput).value || '(unnamed)';
    const tintRaw = this.getInput(this.tintInput).value.trim().replace(/^#/, '');
    g.tint = /^[0-9a-fA-F]{1,6}$/.test(tintRaw) ? parseInt(tintRaw, 16) : null;
    g.allergens = ALLERGENS.filter(name => this.getInput(this.allergenInputs[name]).checked);
    this.refreshPreview();
    this.refreshList();
  }

  addItem() {
    const id = 'item' + Date.now();
    this.items.push({
      id, name: 'New Item', category: 'food', sheet: this.sheetKey, frame: 0,
      tint: null, station: STATION_KEYS[0].key, allergens: []
    });
    this.editingId = id;
    this.refreshList();
    this.loadEditing();
  }

  deleteItem() {
    this.items = this.items.filter(g => g.id !== this.editingId);
    this.editingId = this.items[0]?.id || null;
    this.refreshList();
    if (this.editingId) this.loadEditing();
  }

  save() {
    Storage.saveMenu(this.items);
    this.flash('Menu saved.');
  }

  async importItems() {
    try {
      const data = await Storage.pickJSON();
      this.items = data;
      Storage.saveMenu(data);
      this.editingId = this.items[0]?.id || null;
      this.refreshList();
      this.loadEditing();
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
