import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { CHARACTERS, ALLERGENS, charKeys, IDLE_FRAME_DOWN, IDLE_FRAMES } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { DEFAULT_GUESTS } from '../data/defaults.js';
import { loadMenuItems } from '../data/menu.js';
import { CATEGORIES, LAYER_ORDER, randomAppearance, profileFor } from '../data/characterGenerator.js';
import { bakeAppearanceTextures, ensureAppearanceTextures, preloadLayerFiles, registerLayerFrames, layerTexKey as layerKeyFor } from '../core/AppearanceCompositor.js';

const SLOT_LABELS = { body: 'Body', eyes: 'Eyes', outfit: 'Outfit', hairstyle: 'Hairstyle', accessory: 'Accessory' };
function defaultCustomAppearance(kid = false) {
  const c = { kid, body: '1', eyes: '1', outfit: null, hairstyle: null, accessory: null };
  c.outfit = kid ? CATEGORIES.outfit.kids[0].id : CATEGORIES.outfit.adult[0].id;
  c.hairstyle = kid ? CATEGORIES.hairstyle.kids[0].id : CATEGORIES.hairstyle.adult[0].id;
  return c;
}

const LIST_W = 240;
const TOOLBAR_H = 56;

export class GuestEditorScene extends Phaser.Scene {
  constructor() { super('GuestEditor'); }

  async create() {
    this.cameras.main.setBackgroundColor('#23232c');
    this.guests = Storage.loadGuests() || JSON.parse(JSON.stringify(DEFAULT_GUESTS));
    this.editingId = this.guests[0]?.id || null;
    this.menuItems = await loadMenuItems();
    this.drinkItems = this.menuItems.filter(m => m.category === 'drink');
    this.foodItems = this.menuItems.filter(m => m.category === 'food');

    const { width, height } = this.scale;
    this.slotModal = null;
    this.pickerTab = 'preset';
    this.loadedCategoryKids = {}; // category -> Set(kid bool) already lazy-loaded this session
    this.buildToolbar(width);
    this.buildCharPicker();
    this.buildList();
    this.buildForm(height);
    this.refreshList();
    this.loadEditing();

    this.input.keyboard.on('keydown-ESC', () => {
      if (this.slotModal) { this.closeSlotPicker(); return; }
      this.scene.start('Menu');
    });
  }

  buildToolbar(width) {
    this.add.rectangle(0, 0, width, TOOLBAR_H, 0x1b1b22).setOrigin(0).setDepth(100);
    this.add.text(12, 18, 'Guest Editor', { fontFamily: 'system-ui', fontSize: '16px', color: '#ffe9a8' });

    const right = width - 12;
    this.makeBtn(right - 70, 14, 70, 30, 'Save', () => this.save());
    this.makeBtn(right - 150, 14, 70, 30, 'Export', () => Storage.downloadJSON(this.guests, 'guests.json'));
    this.makeBtn(right - 230, 14, 70, 30, 'Import', () => this.importGuests());
    this.makeBtn(right - 310, 14, 70, 30, 'Menu', () => this.scene.start('Menu'));
  }

  makeBtn(x, y, w, h, label, onClick) {
    const bg = this.add.rectangle(x, y, w, h, 0x2b2b39).setOrigin(0).setStrokeStyle(1, 0x4a4a5e)
      .setInteractive({ useHandCursor: true }).setDepth(101);
    const txt = this.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'system-ui', fontSize: Math.max(10, h - 4) + 'px', color: '#e6e6f0'
    }).setOrigin(0.5).setDepth(102);
    bg.on('pointerover', () => bg.setFillStyle(0x3a3a4d));
    bg.on('pointerout', () => bg.setFillStyle(0x2b2b39));
    bg.on('pointerdown', onClick);
    return { bg, txt };
  }

  // Appearance picker: tab between Presets (named characters) and Custom
  // (layered generator: body/eyes/outfit/hairstyle/accessory).
  buildCharPicker() {
    const panelX = 8, panelY = TOOLBAR_H + 12;
    const panelW = LIST_W - 16;
    this.pickerPanelX = panelX;
    this.pickerPanelY = panelY;
    this.pickerPanelW = panelW;
    this.pickerPanelH = this.scale.height - panelY - 40;

    this.presetTabBtn = this.makeBtn(panelX, panelY - 4, panelW / 2 - 2, 24, 'Presets', () => this.onTabClick('preset'));
    this.customTabBtn = this.makeBtn(panelX + panelW / 2 + 2, panelY - 4, panelW / 2 - 2, 24, 'Custom', () => this.onTabClick('custom'));

    this.buildPresetPicker(panelX, panelY + 26, panelW, this.pickerPanelH - 26);
    this.buildCustomPicker(panelX, panelY + 26, panelW, this.pickerPanelH - 26);
    this.showPickerTab('preset');
  }

  /** Pure UI: shows the matching panel for a guest's existing appearance.mode. Does not touch data. */
  showPickerTab(tab) {
    this.pickerTab = tab;
    this.presetContainer.setVisible(tab === 'preset');
    this.customPanel.setVisible(tab === 'custom');
    this.kidInput.setVisible(tab === 'custom');
    this.presetTabBtn.bg.setFillStyle(tab === 'preset' ? 0x4a4a5e : 0x2b2b39);
    this.customTabBtn.bg.setFillStyle(tab === 'custom' ? 0x4a4a5e : 0x2b2b39);
  }

  /** User clicked a tab button: switches the editing guest into that mode. */
  onTabClick(tab) {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    if (tab === 'preset' && g.appearance?.mode !== 'preset') {
      g.appearance = { mode: 'preset', charName: g.charName || 'Adam' };
    } else if (tab === 'custom' && g.appearance?.mode !== 'custom') {
      g.appearance = { mode: 'custom', custom: defaultCustomAppearance(false) };
    }
    this.showPickerTab(tab);
    if (tab === 'custom') { this.updateCustomRowLabels(); this.updateCustomPreview(); }
    this.refreshList();
  }

  // Preset picker: scrollable grid of idle poses from all named characters.
  buildPresetPicker(panelX, panelY, panelW, panelH) {
    this.presetContainer = this.add.container(panelX, panelY).setDepth(50);
    const cellW = 48, cellH = 72, pad = 4;
    const cols = Math.floor(panelW / (cellW + pad));

    this.charButtons = [];
    CHARACTERS.forEach((name, i) => {
      const cx = (i % cols) * (cellW + pad);
      const cy = Math.floor(i / cols) * (cellH + pad);
      const keys = charKeys(name);

      const bg = this.add.rectangle(cx, cy, cellW, cellH, 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      const img = this.add.image(cx + cellW / 2, cy + cellH - 12, keys.idle, IDLE_FRAME_DOWN)
        .setOrigin(0.5, 0.75).setDisplaySize(36, 72);
      const label = this.add.text(cx + cellW / 2, cy + cellH - 10, name.replace(/_/g, ' '), {
        fontFamily: 'system-ui', fontSize: '8px', color: '#8fb6ff'
      }).setOrigin(0.5);

      bg.on('pointerover', () => bg.setFillStyle(0x3a3a4d));
      bg.on('pointerout', () => bg.setFillStyle(0x2b2b39));
      bg.on('pointerdown', () => this.pickCharacter(name));
      this.presetContainer.add([bg, img, label]);
      this.charButtons.push({ name, bg });
    });

    // Mask for scrolling.
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, panelY, panelW, panelH - 4);
    this.presetContainer.setMask(maskShape.createGeometryMask());

    // Wheel scroll.
    const contentH = Math.ceil(CHARACTERS.length / cols) * (cellH + pad);
    this.input.on('wheel', (pointer) => {
      if (this.pickerTab !== 'preset') return;
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = panelH - 4 - contentH;
      let ny = Phaser.Math.Clamp(this.presetContainer.y - Math.sign(pointer.event.deltaY) * 50, panelY + Math.min(0, minY), panelY);
      this.presetContainer.y = ny;
    });
  }

  pickCharacter(name) {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    g.charName = name;
    g.appearance = { mode: 'preset', charName: name };
    if (!g.name || g.name === '(unnamed)') g.name = name.replace(/_/g, ' ');
    // Highlight selected.
    for (const b of this.charButtons) {
      b.bg.setFillStyle(b.name === name ? 0x4a4a5e : 0x2b2b39);
    }
    this.loadEditing();
    this.refreshList();
  }

  // Custom picker: Kid toggle + 5 layered slots (body/eyes/outfit/hairstyle/accessory).
  buildCustomPicker(panelX, panelY, panelW, panelH) {
    this.customPanel = this.add.container(0, 0).setDepth(50).setVisible(false);

    this.kidInput = this.add.dom(panelX, panelY + 10).createFromHTML(
      `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:12px;color:#c9c9d6;cursor:pointer;">
         <input type="checkbox" style="width:14px;height:14px;" /> Kid
       </label>`
    ).setOrigin(0, 0.5);
    this.getInput(this.kidInput).addEventListener('change', () => this.setKid(this.getInput(this.kidInput).checked));
    this.kidInput.setVisible(false); // DOM elements can't live inside a regular Container — track visibility alongside customPanel instead.

    this.customRows = {};
    let rowY = panelY + 30;
    for (const category of LAYER_ORDER) {
      const label = this.add.text(panelX, rowY, SLOT_LABELS[category], {
        fontFamily: 'system-ui', fontSize: '12px', color: '#c9c9d6'
      });
      const value = this.add.text(panelX, rowY + 15, '', {
        fontFamily: 'system-ui', fontSize: '11px', color: '#8fb6ff'
      });
      const btn = this.makeBtn(panelX + panelW - 64, rowY - 2, 64, 24, 'Change', () => this.openSlotPicker(category));
      this.customPanel.add([label, value, btn.bg, btn.txt]);
      this.customRows[category] = { value };
      rowY += 38;
    }

    const randomBtn = this.makeBtn(panelX, rowY + 4, panelW, 28, 'Randomize', () => this.randomizeCustom());
    this.customPanel.add([randomBtn.bg, randomBtn.txt]);
  }

  setKid(kid) {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    g.appearance.custom = defaultCustomAppearance(kid);
    this.updateCustomRowLabels();
    this.updateCustomPreview();
    this.refreshList();
  }

  randomizeCustom() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    const kid = !!g.appearance.custom?.kid;
    g.appearance.custom = randomAppearance(kid);
    this.updateCustomRowLabels();
    this.updateCustomPreview();
    this.refreshList();
  }

  updateCustomRowLabels() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    const custom = g.appearance.custom;
    this.getInput(this.kidInput).checked = !!custom.kid;
    for (const category of LAYER_ORDER) {
      const id = custom[category];
      const manifest = custom.kid ? CATEGORIES[category].kids : CATEGORIES[category].adult;
      const variant = id != null ? manifest.find(v => v.id === id) : null;
      this.customRows[category].value.setText(variant ? variant.label : 'None');
    }
  }

  /** Bakes (or kicks off loading + baking) the custom preview and applies it. */
  updateCustomPreview() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    const custom = g.appearance.custom;
    try {
      const keys = bakeAppearanceTextures(this, custom);
      this.preview.setTexture(keys.idle, IDLE_FRAME_DOWN);
    } catch {
      ensureAppearanceTextures(this, custom).then(keys => {
        if (this.editingId === g.id && this.pickerTab === 'custom') {
          this.preview.setTexture(keys.idle, IDLE_FRAME_DOWN);
          this.refreshList();
        }
      }).catch(e => this.flash('Appearance load failed: ' + e.message));
    }
  }

  /** Lazy-loads every layer file for a category (both kid/adult are cached separately per session). */
  async loadCategoryFiles(category, kid) {
    this.loadedCategoryKids[category] ??= new Set();
    if (this.loadedCategoryKids[category].has(kid)) return;
    const manifest = kid ? CATEGORIES[category].kids : CATEGORIES[category].adult;
    const files = manifest.map(v => ({ key: layerKeyFor(v.path), path: v.path }));
    await preloadLayerFiles(this, files);
    const profile = profileFor(kid);
    for (const f of files) registerLayerFrames(this.textures.get(f.key), profile);
    this.loadedCategoryKids[category].add(kid);
  }

  openSlotPicker(category) {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    const custom = g.appearance.custom;
    const kid = !!custom.kid;
    const manifest = kid ? CATEGORIES[category].kids : CATEGORIES[category].adult;

    const { width, height } = this.scale;
    const modal = this.add.container(0, 0).setDepth(300);
    const backdrop = this.add.rectangle(0, 0, width, height, 0x000000, 0.6).setOrigin(0).setInteractive();
    const panel = this.add.rectangle(40, 40, width - 80, height - 80, 0x23232c).setStrokeStyle(2, 0x4a4a5e).setOrigin(0);
    const title = this.add.text(56, 52, `Choose ${SLOT_LABELS[category]}`, { fontFamily: 'system-ui', fontSize: '16px', color: '#ffe9a8' });
    const closeBtn = this.makeBtn(width - 110, 48, 54, 26, 'Close', () => this.closeSlotPicker());
    const loadingTxt = this.add.text(width / 2, height / 2, `Loading ${SLOT_LABELS[category]}…`, {
      fontFamily: 'system-ui', fontSize: '14px', color: '#c9c9d6'
    }).setOrigin(0.5);
    modal.add([backdrop, panel, title, closeBtn.bg, closeBtn.txt, loadingTxt]);
    this.slotModal = modal;

    this.loadCategoryFiles(category, kid).then(() => {
      if (this.slotModal !== modal) return; // closed while loading
      loadingTxt.destroy();
      this.buildSlotGrid(modal, category, manifest, custom, 56, 88, width - 112, height - 140);
    }).catch(e => {
      loadingTxt.setText('Failed to load: ' + e.message);
    });
  }

  buildSlotGrid(modal, category, manifest, custom, gx, gy, gw, gh) {
    const cellW = 56, cellH = 76, pad = 6;
    const cols = Math.floor(gw / (cellW + pad));
    const grid = this.add.container(gx, gy).setDepth(301);
    const entries = category === 'accessory' ? [{ id: null, label: 'None', path: null }, ...manifest] : manifest;

    entries.forEach((v, i) => {
      const cx = (i % cols) * (cellW + pad);
      const cy = Math.floor(i / cols) * (cellH + pad);
      const selected = custom[category] === v.id;
      const bg = this.add.rectangle(cx, cy, cellW, cellH, selected ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      grid.add(bg);
      if (v.path) {
        const texKey = layerKeyFor(v.path);
        if (this.textures.exists(texKey) && this.textures.get(texKey).has('gen_idle_down')) {
          const img = this.add.image(cx + cellW / 2, cy + cellH - 14, texKey, 'gen_idle_down').setOrigin(0.5, 0.75).setDisplaySize(40, 80);
          grid.add(img);
        }
      }
      const label = this.add.text(cx + cellW / 2, cy + cellH - 8, v.label, {
        fontFamily: 'system-ui', fontSize: '8px', color: '#8fb6ff'
      }).setOrigin(0.5);
      grid.add(label);
      bg.on('pointerdown', () => this.selectSlotVariant(category, v.id));
    });

    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(gx, gy, gw, gh);
    grid.setMask(maskShape.createGeometryMask());

    const contentH = Math.ceil(entries.length / cols) * (cellH + pad);
    const wheelHandler = (pointer) => {
      if (pointer.x < gx || pointer.x > gx + gw || pointer.y < gy || pointer.y > gy + gh) return;
      const minY = gh - contentH;
      grid.y = Phaser.Math.Clamp(grid.y - Math.sign(pointer.event.deltaY) * 50, gy + Math.min(0, minY), gy);
    };
    this.input.on('wheel', wheelHandler);
    modal.once('destroy', () => this.input.off('wheel', wheelHandler));
    modal.add(grid);
  }

  selectSlotVariant(category, id) {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    g.appearance.custom[category] = id;
    this.closeSlotPicker();
    this.updateCustomRowLabels();
    this.updateCustomPreview();
    this.refreshList();
  }

  closeSlotPicker() {
    if (!this.slotModal) return;
    this.slotModal.destroy(true);
    this.slotModal = null;
  }

  buildList() {
    const x = LIST_W + 16;
    this.add.text(x, TOOLBAR_H + 12, 'Guests', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });
    this.listContainer = this.add.container(x, TOOLBAR_H + 40).setDepth(10);
  }

  refreshList() {
    this.listContainer.removeAll(true);
    this.guests.forEach((g, i) => {
      const y = i * 44;
      this.ensureAppearanceDefaults(g);
      const bg = this.add.rectangle(0, y, 220, 40, g.id === this.editingId ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      let preview;
      try {
        const keys = this.resolveIdleKeysSync(g);
        preview = this.add.image(24, y + 36, keys.idle, IDLE_FRAME_DOWN).setOrigin(0.5, 0.75).setDisplaySize(28, 56);
      }
      catch { preview = this.add.rectangle(8, y + 4, 32, 32, 0x4a4a5e); }
      const name = this.add.text(48, y + 6, g.name || '(unnamed)', { fontFamily: 'system-ui', fontSize: '14px', color: '#e6e6f0' });
      const drinkLabel = this.menuName(g.drinkOrder) || 'Coffee';
      const orderText = g.prefersBar
        ? `bar: ${drinkLabel}`
        : `${drinkLabel} → ${this.menuName(g.foodOrder) || 'Burger'}`;
      const order = this.add.text(48, y + 22, orderText, { fontFamily: 'system-ui', fontSize: '11px', color: '#8fb6ff' });
      bg.on('pointerdown', () => { this.editingId = g.id; this.loadEditing(); this.refreshList(); });
      bg.on('pointerover', () => { if (g.id !== this.editingId) bg.setFillStyle(0x3a3a4d); });
      bg.on('pointerout', () => { if (g.id !== this.editingId) bg.setFillStyle(0x2b2b39); });
      this.listContainer.add([bg, preview, name, order]);
    });

    const addY = this.guests.length * 44 + 4;
    const addBg = this.add.rectangle(0, addY, 220, 32, 0x2b4a2b).setOrigin(0, 0).setStrokeStyle(1, 0x4a6a4a)
      .setInteractive({ useHandCursor: true });
    const addTxt = this.add.text(110, addY + 16, '+ Add guest', { fontFamily: 'system-ui', fontSize: '14px', color: '#9aff9a' }).setOrigin(0.5);
    addBg.on('pointerdown', () => this.addGuest());
    addBg.on('pointerover', () => addBg.setFillStyle(0x3a6a3a));
    addBg.on('pointerout', () => addBg.setFillStyle(0x2b4a2b));
    this.listContainer.add([addBg, addTxt]);

    if (this.editingId) {
      const delY = addY + 40;
      const delBg = this.add.rectangle(0, delY, 220, 28, 0x4a2b2b).setOrigin(0, 0).setStrokeStyle(1, 0x6a4a4a)
        .setInteractive({ useHandCursor: true });
      const delTxt = this.add.text(110, delY + 14, 'Delete selected', { fontFamily: 'system-ui', fontSize: '13px', color: '#ff9a9a' }).setOrigin(0.5);
      delBg.on('pointerdown', () => this.deleteGuest());
      delBg.on('pointerover', () => delBg.setFillStyle(0x6a3a3a));
      delBg.on('pointerout', () => delBg.setFillStyle(0x4a2b2b));
      this.listContainer.add([delBg, delTxt]);
    }
  }

  buildForm(height) {
    const x = LIST_W + 16 + 240;
    this.add.text(x, TOOLBAR_H + 12, 'Edit guest', { fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8' });

    // Preview (idle pose, 96px tall).
    this.preview = this.add.image(x + 48, TOOLBAR_H + 96, '__pixel').setOrigin(0.5, 0.75).setDisplaySize(48, 96);

    // Name field.
    this.add.text(x, TOOLBAR_H + 150, 'Name', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.nameInput = this.add.dom(x, TOOLBAR_H + 178).createFromHTML(
      `<input type="text" style="width:240px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.nameInput).addEventListener('input', () => this.applyFormToEditing());

    // Patience field.
    this.add.text(x, TOOLBAR_H + 200, 'Patience (seconds)', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.patienceInput = this.add.dom(x, TOOLBAR_H + 228).createFromHTML(
      `<input type="number" min="10" max="300" style="width:120px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.patienceInput).addEventListener('input', () => this.applyFormToEditing());

    // Drink dropdown (stage 1 — everyone orders a drink first).
    this.add.text(x, TOOLBAR_H + 250, 'Drink', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    const drinkOpts = this.drinkItems.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    this.drinkInput = this.add.dom(x, TOOLBAR_H + 278).createFromHTML(
      `<select style="width:160px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;">${drinkOpts}</select>`
    ).setOrigin(0, 0.5);
    this.getInput(this.drinkInput).addEventListener('change', () => this.applyFormToEditing());

    // Food dropdown (stage 2 — skipped entirely for prefersBar guests).
    this.foodLabel = this.add.text(x, TOOLBAR_H + 300, 'Food', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    const foodOpts = this.foodItems.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    this.foodInput = this.add.dom(x, TOOLBAR_H + 328).createFromHTML(
      `<select style="width:160px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;">${foodOpts}</select>`
    ).setOrigin(0, 0.5);
    this.getInput(this.foodInput).addEventListener('change', () => this.applyFormToEditing());

    // Prefers bar checkbox — skips the host queue, drink-only visit.
    this.barInput = this.add.dom(x, TOOLBAR_H + 360).createFromHTML(
      `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:13px;color:#c9c9d6;cursor:pointer;">
         <input type="checkbox" style="width:16px;height:16px;" />
         Prefers bar (drink only, skips queue)
       </label>`
    ).setOrigin(0, 0.5);
    this.getInput(this.barInput).addEventListener('change', () => this.applyFormToEditing());

    // Allergies — metadata only for now; doesn't affect order generation or serving.
    this.add.text(x, TOOLBAR_H + 392, 'Allergies', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    this.allergyInputs = {};
    ALLERGENS.forEach((name, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const ax = x + col * 130, ay = TOOLBAR_H + 416 + row * 24;
      const dom = this.add.dom(ax, ay).createFromHTML(
        `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:12px;color:#c9c9d6;cursor:pointer;">
           <input type="checkbox" style="width:14px;height:14px;" /> ${name}
         </label>`
      ).setOrigin(0, 0.5);
      this.getInput(dom).addEventListener('change', () => this.applyFormToEditing());
      this.allergyInputs[name] = dom;
    });

    this.add.text(x, height - 40,
      'Pick a character from the left panel. Idle pose shown for walking, sit pose used when seated.',
      { fontFamily: 'system-ui', fontSize: '12px', color: '#7a7a8a' });
  }

  getInput(domEl) { return domEl.node.querySelector('input,select'); }

  menuName(id) { return this.menuItems.find(m => m.id === id)?.name || id; }

  ensureAppearanceDefaults(g) {
    if (!g.appearance) g.appearance = { mode: 'preset', charName: g.charName || 'Adam' };
  }

  /** Throws if a custom guest's layer textures aren't loaded yet — callers decide the fallback. */
  resolveIdleKeysSync(g) {
    if (g.appearance?.mode === 'custom' && g.appearance.custom) {
      return bakeAppearanceTextures(this, g.appearance.custom);
    }
    return charKeys(g.charName || 'Adam');
  }

  loadEditing() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    this.ensureAppearanceDefaults(g);
    this.showPickerTab(g.appearance.mode === 'custom' ? 'custom' : 'preset');

    if (g.appearance.mode === 'custom') {
      this.updateCustomRowLabels();
      this.updateCustomPreview();
    } else {
      const keys = charKeys(g.charName || 'Adam');
      this.preview.setTexture(keys.idle, IDLE_FRAME_DOWN);
    }
    this.getInput(this.nameInput).value = g.name || '';
    this.getInput(this.patienceInput).value = g.patience;
    this.getInput(this.drinkInput).value = g.drinkOrder || 'coffee';
    this.getInput(this.foodInput).value = g.foodOrder || 'burger';
    this.getInput(this.barInput).checked = !!g.prefersBar;
    this.refreshFoodRow(!!g.prefersBar);
    for (const name of ALLERGENS) this.getInput(this.allergyInputs[name]).checked = (g.allergies || []).includes(name);
    // Highlight selected character.
    for (const b of this.charButtons) {
      b.bg.setFillStyle(b.name === g.charName ? 0x4a4a5e : 0x2b2b39);
    }
  }

  /** Greys out the Food dropdown when the guest is bar-only (drink stage is their whole visit). */
  refreshFoodRow(prefersBar) {
    const alpha = prefersBar ? 0.4 : 1;
    this.foodLabel.setAlpha(alpha);
    this.foodInput.setAlpha(alpha);
    this.getInput(this.foodInput).disabled = prefersBar;
  }

  applyFormToEditing() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    g.name = this.getInput(this.nameInput).value || '(unnamed)';
    g.patience = Math.max(10, parseInt(this.getInput(this.patienceInput).value, 10) || 60);
    g.drinkOrder = this.getInput(this.drinkInput).value;
    g.foodOrder = this.getInput(this.foodInput).value;
    g.prefersBar = this.getInput(this.barInput).checked;
    this.refreshFoodRow(g.prefersBar);
    g.allergies = ALLERGENS.filter(name => this.getInput(this.allergyInputs[name]).checked);
    this.refreshList();
  }

  addGuest() {
    const id = 'g' + Date.now();
    const firstChar = CHARACTERS[0];
    this.guests.push({
      id, name: firstChar.replace(/_/g, ' '), charName: firstChar, patience: 60,
      drinkOrder: this.drinkItems[0]?.id || 'coffee', foodOrder: this.foodItems[0]?.id || 'burger',
      prefersBar: false, allergies: [],
      appearance: { mode: 'preset', charName: firstChar }
    });
    this.editingId = id;
    this.refreshList();
    this.loadEditing();
  }

  deleteGuest() {
    this.guests = this.guests.filter(g => g.id !== this.editingId);
    this.editingId = this.guests[0]?.id || null;
    this.refreshList();
    if (this.editingId) this.loadEditing();
  }

  save() {
    Storage.saveGuests(this.guests);
    this.flash('Guests saved.');
  }

  async importGuests() {
    try {
      const data = await Storage.pickJSON();
      this.guests = data;
      Storage.saveGuests(data);
      this.editingId = this.guests[0]?.id || null;
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
