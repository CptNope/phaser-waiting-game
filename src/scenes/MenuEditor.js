import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { SHEETS, STATION_KEYS, ALLERGENS } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { loadMenuItems } from '../data/menu.js';
import { Palette } from '../core/Palette.js';
import { loadAssetIndex, loadSheetDetail, ensureSheetTexture, nonEmptyFrames, describeFrame } from '../data/assetIndex.js';

const PICKER_W = 240;
const LIST_W = 240;
const TOOLBAR_H = 56;

export class MenuEditorScene extends Phaser.Scene {
  constructor() { super('MenuEditor'); }

  async create() {
    this.cameras.main.setBackgroundColor('#23232c');
    this.items = await loadMenuItems();
    this.editingId = this.items[0]?.id || null;

    // Until the generated index loads, fall back to the sheets Boot preloaded.
    this.sheetList = SHEETS.map(s => ({ key: s.key, path: s.path, tile: s.frameW, kind: 'objects' }));
    this.sheetKey = this.editingItem()?.sheet || 'kitchen';
    this.sheetIdx = Math.max(0, this.sheetList.findIndex(s => s.key === this.sheetKey));
    this.sheetDetail = null;

    const { width, height } = this.scale;
    this.buildToolbar(width);
    this.buildSpritePicker(height);
    this.buildList();
    this.buildForm(height);
    this.refreshList();
    this.loadEditing();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));

    this.initIndex();
  }

  editingItem() { return this.items.find(x => x.id === this.editingId); }

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
    this.buildPalette();
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

  buildToolbar(width) {
    this.add.rectangle(0, 0, width, TOOLBAR_H, 0x1b1b22).setOrigin(0).setDepth(100);
    this.add.text(12, 18, 'Menu Editor', { fontFamily: 'system-ui', fontSize: '16px', color: '#ffe9a8' });

    const right = width - 12;
    this.makeBtn(right - 70, 14, 70, 30, 'Save', () => this.save());
    this.makeBtn(right - 150, 14, 70, 30, 'Export', () => Storage.downloadJSON(this.items, 'menu.json'));
    this.makeBtn(right - 230, 14, 70, 30, 'Import', () => this.importItems());
    this.makeBtn(right - 310, 14, 70, 30, 'Menu', () => this.scene.start('Menu'));

    this.statusText = this.add.text(360, 24, '', { fontFamily: 'system-ui', fontSize: '12px', color: '#8fb6ff' }).setDepth(101);
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

  // ------------------------------------------------------------- sprite picker

  buildSpritePicker(height) {
    const panelX = 8, panelY = TOOLBAR_H + 12;
    const panelW = PICKER_W - 16;
    this.pickerPanelX = panelX;
    this.pickerPanelY = panelY;
    this.pickerPanelW = panelW;
    this.pickerPanelH = height - panelY - 40;

    this.add.text(panelX, panelY - 4, 'Sprite', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }).setDepth(60);
    this.makeBtn(panelX, panelY + 14, 24, 22, '◀', () => this.selectSheet(this.sheetIdx - 1));
    this.makeBtn(panelX + 28, panelY + 14, 24, 22, '▶', () => this.selectSheet(this.sheetIdx + 1));
    this.sheetLabel = this.add.text(panelX + 58, panelY + 19, this.sheetKey, {
      fontFamily: 'system-ui', fontSize: '12px', color: '#ffe9a8'
    }).setDepth(101);

    this.paletteY = panelY + 44;
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
    const panelH = this.pickerPanelY + this.pickerPanelH - this.paletteY;
    this.palette.container.setPosition(panelX, this.paletteY);
    this.palette.container.setDepth(50);

    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, this.paletteY, panelW, panelH - 4);
    this.palette.container.setMask(maskShape.createGeometryMask());

    if (this.paletteWheel) this.input.off('wheel', this.paletteWheel);
    this.paletteWheel = (pointer) => {
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = this.paletteY + Math.min(0, panelH - 4 - this.palette.contentHeight);
      this.palette.container.y = Phaser.Math.Clamp(this.palette.container.y - Math.sign(pointer.event.deltaY) * 50, minY, this.paletteY);
    };
    this.input.on('wheel', this.paletteWheel);
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

  buildList() {
    const x = PICKER_W + 16;
    this.add.text(x, TOOLBAR_H + 12, 'Items', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });
    this.listContainer = this.add.container(x, TOOLBAR_H + 40).setDepth(10);
  }

  refreshList() {
    this.listContainer.removeAll(true);
    this.items.forEach((g, i) => {
      const y = i * 40;
      const bg = this.add.rectangle(0, y, 220, 36, g.id === this.editingId ? 0x4a4a5e : 0x2b2b39)
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

    const addY = this.items.length * 40 + 4;
    const addBg = this.add.rectangle(0, addY, 220, 32, 0x2b4a2b).setOrigin(0, 0).setStrokeStyle(1, 0x4a6a4a)
      .setInteractive({ useHandCursor: true });
    const addTxt = this.add.text(110, addY + 16, '+ Add item', { fontFamily: 'system-ui', fontSize: '14px', color: '#9aff9a' }).setOrigin(0.5);
    addBg.on('pointerdown', () => this.addItem());
    addBg.on('pointerover', () => addBg.setFillStyle(0x3a6a3a));
    addBg.on('pointerout', () => addBg.setFillStyle(0x2b4a2b));
    this.listContainer.add([addBg, addTxt]);

    if (this.editingId) {
      const delY = addY + 40;
      const delBg = this.add.rectangle(0, delY, 220, 28, 0x4a2b2b).setOrigin(0, 0).setStrokeStyle(1, 0x6a4a4a)
        .setInteractive({ useHandCursor: true });
      const delTxt = this.add.text(110, delY + 14, 'Delete selected', { fontFamily: 'system-ui', fontSize: '13px', color: '#ff9a9a' }).setOrigin(0.5);
      delBg.on('pointerdown', () => this.deleteItem());
      delBg.on('pointerover', () => delBg.setFillStyle(0x6a3a3a));
      delBg.on('pointerout', () => delBg.setFillStyle(0x4a2b2b));
      this.listContainer.add([delBg, delTxt]);
    }
  }

  // ---------------------------------------------------------------------- form

  buildForm(height) {
    const x = PICKER_W + 16 + 240;
    this.add.text(x, TOOLBAR_H + 12, 'Edit item', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });

    this.preview = this.add.image(x + 24, TOOLBAR_H + 66, '__pixel').setDisplaySize(40, 40);

    this.add.text(x, TOOLBAR_H + 96, 'Name', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.nameInput = this.add.dom(x, TOOLBAR_H + 124).createFromHTML(
      `<input type="text" style="width:240px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.nameInput).addEventListener('input', () => this.applyFormToEditing());

    // Category toggle (Drink / Food).
    this.add.text(x, TOOLBAR_H + 146, 'Category', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.drinkTabBtn = this.makeBtn(x, TOOLBAR_H + 166, 90, 26, 'Drink', () => this.setCategory('drink'));
    this.foodTabBtn = this.makeBtn(x + 96, TOOLBAR_H + 166, 90, 26, 'Food', () => this.setCategory('food'));

    // Station picker — food items only.
    this.stationLabel = this.add.text(x, TOOLBAR_H + 202, 'Station', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.stationBtns = STATION_KEYS.map((s, i) => this.makeBtn(x + i * 46, TOOLBAR_H + 222, 42, 24, s.label, () => this.setStation(s.key), 10));

    // Tint (optional hex color applied to the icon — e.g. reusing one sprite
    // for two items, like Wine reusing the Beer bottle with a burgundy tint).
    this.add.text(x, TOOLBAR_H + 256, 'Tint (hex, blank = none)', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.tintInput = this.add.dom(x, TOOLBAR_H + 284).createFromHTML(
      `<input type="text" placeholder="e.g. 8b2a52" style="width:140px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.tintInput).addEventListener('input', () => this.applyFormToEditing());

    // Allergens.
    this.add.text(x, TOOLBAR_H + 312, 'Allergens', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.allergenInputs = {};
    ALLERGENS.forEach((name, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const ax = x + col * 130, ay = TOOLBAR_H + 336 + row * 26;
      const dom = this.add.dom(ax, ay).createFromHTML(
        `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:12px;color:#c9c9d6;cursor:pointer;">
           <input type="checkbox" style="width:14px;height:14px;" /> ${name}
         </label>`
      ).setOrigin(0, 0.5);
      this.getInput(dom).addEventListener('change', () => this.applyFormToEditing());
      this.allergenInputs[name] = dom;
    });

    this.add.text(x, height - 40,
      'Pick a sprite from the left panel to assign it to the selected item.',
      { fontFamily: 'system-ui', fontSize: '12px', color: '#7a7a8a' });
  }

  getInput(domEl) { return domEl.node.querySelector('input,select'); }

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
    this.stationLabel.setVisible(showStation);
    this.stationBtns.forEach(b => { b.bg.setVisible(showStation); b.txt.setVisible(showStation); });
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
    if (!g) { this.preview.setTexture('__pixel'); return; }
    try {
      this.preview.setTexture(g.sheet, g.frame);
      if (g.tint != null) this.preview.setTint(g.tint); else this.preview.clearTint();
    } catch { this.preview.setTexture('__pixel'); }
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
