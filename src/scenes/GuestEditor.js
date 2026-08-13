import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { CHARACTERS, ALLERGENS, STATION_KEYS, charKeys, IDLE_FRAME_DOWN, IDLE_FRAMES } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { DEFAULT_GUESTS, DEFAULT_NPCS } from '../data/defaults.js';
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

const TOOLBAR_H = 56;
const ENTITY_TAB_Y = TOOLBAR_H + 6;
const ENTITY_TAB_H = 26;
const PANEL_TAB_Y = ENTITY_TAB_Y + ENTITY_TAB_H + 6;
const PANEL_TAB_H = 24;
const NARROW_BREAKPOINT = 760;

export class GuestEditorScene extends Phaser.Scene {
  constructor() { super('GuestEditor'); }

  get entities() { return this.tab === 'guests' ? this.guests : this.npcs; }
  get editingId() { return this.tab === 'guests' ? this.editingGuestId : this.editingNpcId; }
  set editingId(v) { if (this.tab === 'guests') this.editingGuestId = v; else this.editingNpcId = v; }

  async create() {
    this.cameras.main.setBackgroundColor('#23232c');
    this.guests = Storage.loadGuests() || JSON.parse(JSON.stringify(DEFAULT_GUESTS));
    this.npcs = Storage.loadNPCs() || JSON.parse(JSON.stringify(DEFAULT_NPCS));
    this.tab = 'guests';
    this.panelTab = 'list'; // only used on narrow screens: 'char' | 'list' | 'form'
    this.pickerTab = 'preset';
    this.editingGuestId = this.guests[0]?.id || null;
    this.editingNpcId = this.npcs[0]?.id || null;
    this.loadedCategoryKids = {}; // category -> Set(kid bool) already lazy-loaded this session
    this.menuItems = await loadMenuItems();
    this.drinkItems = this.menuItems.filter(m => m.category === 'drink');
    this.foodItems = this.menuItems.filter(m => m.category === 'food');

    this.build();

    this.input.keyboard.on('keydown-ESC', () => {
      if (this.slotModal) { this.closeSlotPicker(); return; }
      this.scene.start('Menu');
    });

    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.onResize, this);
      if (this._resizeTimer) this._resizeTimer.remove(false);
    });
  }

  onResize() {
    if (this._resizeTimer) this._resizeTimer.remove(false);
    this._resizeTimer = this.time.delayedCall(120, () => { this._resizeTimer = null; this.build(); });
  }

  // ---------------------------------------------------------------- layout

  computeLayout() {
    const { width, height } = this.scale;
    const narrow = width < NARROW_BREAKPOINT;
    const margin = 8, gap = 16;
    const tabsBottom = narrow ? (PANEL_TAB_Y + PANEL_TAB_H) : (ENTITY_TAB_Y + ENTITY_TAB_H);
    const contentTop = tabsBottom + 10;
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
    if (this.slotModal) { this.slotModal.destroy(true); this.slotModal = null; }
    if (this._presetWheel) { this.input.off('wheel', this._presetWheel); this._presetWheel = null; }
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
    if (this._presetMaskShape) { this._presetMaskShape.destroy(); this._presetMaskShape = null; }
    if (this._listMaskShape) { this._listMaskShape.destroy(); this._listMaskShape = null; }
    this._listDrag = null;
    this.children.removeAll(true);
  }

  build() {
    this.teardown();
    this.layout = this.computeLayout();
    this.buildToolbar(this.layout);
    this.buildEntityTabs(this.layout);
    this.panelTabBtns = null;
    if (this.layout.narrow) this.buildPanelTabs(this.layout);
    this.buildCharPicker(this.layout);
    this.buildList(this.layout);
    this.buildForm(this.layout);
    this.refreshList();
    this.loadEditing();
  }

  // ------------------------------------------------------------- toolbar

  buildToolbar(layout) {
    const { width, narrow } = layout;
    this.add.rectangle(0, 0, width, TOOLBAR_H, 0x1b1b22).setOrigin(0).setDepth(100);
    this.add.text(10, 18, narrow ? 'Guests & Staff' : 'Guest & Staff Editor', {
      fontFamily: 'system-ui', fontSize: narrow ? '13px' : '16px', color: '#ffe9a8'
    });

    const btnW = narrow ? 52 : 70, btnH = 28, gap = 6;
    const specs = [
      { label: 'Menu', onClick: () => this.scene.start('Menu') },
      { label: 'Import', onClick: () => this.importActive(), ref: 'importBtn' },
      { label: 'Export', onClick: () => this.exportActive(), ref: 'exportBtn' },
      { label: 'Save', onClick: () => this.save() },
    ];
    let x = width - 8 - btnW;
    for (const s of specs) {
      const btn = this.makeBtn(x, 14, btnW, btnH, s.label, s.onClick, narrow ? 10 : undefined);
      if (s.ref) this[s.ref] = btn;
      x -= btnW + gap;
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

  // ---------------------------------------------------------- entity tabs

  buildEntityTabs(layout) {
    const w = layout.narrow ? (layout.width - 16 - 8) / 2 : 110;
    this.guestsTabBtn = this.makeBtn(8, ENTITY_TAB_Y, w, ENTITY_TAB_H, 'Guests', () => this.setTab('guests'));
    this.staffTabBtn = this.makeBtn(8 + w + 8, ENTITY_TAB_Y, w, ENTITY_TAB_H, 'Staff', () => this.setTab('staff'));
    if (!layout.narrow) {
      this.add.text(layout.width - 10, ENTITY_TAB_Y + ENTITY_TAB_H / 2, 'Export/Import apply to the selected tab', {
        fontFamily: 'system-ui', fontSize: '10px', color: '#5a5a6a'
      }).setOrigin(1, 0.5);
    }
    this.refreshEntityTabButtons();
  }

  refreshEntityTabButtons() {
    this.guestsTabBtn.bg.setFillStyle(this.tab === 'guests' ? 0x4a4a5e : 0x2b2b39);
    this.staffTabBtn.bg.setFillStyle(this.tab === 'staff' ? 0x4a4a5e : 0x2b2b39);
  }

  setTab(tab) {
    if (this.tab === tab) return;
    this.tab = tab;
    this.refreshEntityTabButtons();
    this.refreshList();
    this.refreshFormVisibility();
    this.loadEditing();
  }

  // ----------------------------------------------- narrow-screen panel tabs

  buildPanelTabs(layout) {
    const w = (layout.width - 16 - 16) / 3;
    const defs = [['char', 'Character'], ['list', 'List'], ['form', 'Form']];
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

  // Appearance picker: tab between Presets (named characters) and Custom
  // (layered generator: body/eyes/outfit/hairstyle/accessory). Shared as-is
  // between guests and staff — both use the same {mode, charName|custom} shape.
  buildCharPicker(layout) {
    const panelX = layout.pickerX, panelY = layout.contentTop;
    const panelW = layout.pickerW, panelH = layout.panelH;
    this.pickerPanelX = panelX;
    this.pickerPanelY = panelY;
    this.pickerPanelW = panelW;
    this.pickerPanelH = panelH;

    this.presetTabBtn = this.makeBtn(panelX, panelY, panelW / 2 - 2, 24, 'Presets', () => this.onAppearanceTabClick('preset'));
    this.customTabBtn = this.makeBtn(panelX + panelW / 2 + 2, panelY, panelW / 2 - 2, 24, 'Custom', () => this.onAppearanceTabClick('custom'));

    this.buildPresetPicker(panelX, panelY + 28, panelW, panelH - 28);
    this.buildCustomPicker(panelX, panelY + 28, panelW, panelH - 28);
    this.showPickerTab(this.pickerTab);
  }

  /** Pure UI: shows the matching panel for the current entity's appearance.mode, gated by which top-level panel is active on narrow screens. Does not touch data. */
  showPickerTab(tab) {
    this.pickerTab = tab;
    const active = this.isPanelActive('char');
    this.presetContainer.setVisible(active && tab === 'preset');
    this.customPanel.setVisible(active && tab === 'custom');
    this.kidInput.setVisible(active && tab === 'custom');
    this.presetTabBtn.bg.setVisible(active); this.presetTabBtn.txt.setVisible(active);
    this.customTabBtn.bg.setVisible(active); this.customTabBtn.txt.setVisible(active);
    this.presetTabBtn.bg.setFillStyle(tab === 'preset' ? 0x4a4a5e : 0x2b2b39);
    this.customTabBtn.bg.setFillStyle(tab === 'custom' ? 0x4a4a5e : 0x2b2b39);
  }

  /** User clicked a tab button: switches the editing entity into that appearance mode. */
  onAppearanceTabClick(tab) {
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g) return;
    if (tab === 'preset' && g.appearance?.mode !== 'preset') {
      g.appearance = { mode: 'preset', charName: g.appearance?.charName || g.charName || 'Adam' };
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
    const cols = Math.max(1, Math.floor(panelW / (cellW + pad)));

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
    this._presetMaskShape = maskShape;

    // Wheel scroll.
    const contentH = Math.ceil(CHARACTERS.length / cols) * (cellH + pad);
    this._presetWheel = (pointer) => {
      if (this.pickerTab !== 'preset' || !this.isPanelActive('char')) return;
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = panelH - 4 - contentH;
      this.presetContainer.y = Phaser.Math.Clamp(this.presetContainer.y - Math.sign(pointer.event.deltaY) * 50, panelY + Math.min(0, minY), panelY);
    };
    this.input.on('wheel', this._presetWheel);
  }

  pickCharacter(name) {
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g) return;
    g.appearance = { mode: 'preset', charName: name };
    if (this.tab === 'guests') {
      g.charName = name; // legacy mirror — some read paths still check it directly
      if (!g.name || g.name === '(unnamed)') g.name = name.replace(/_/g, ' ');
    }
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
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    g.appearance.custom = defaultCustomAppearance(kid);
    this.updateCustomRowLabels();
    this.updateCustomPreview();
    this.refreshList();
  }

  randomizeCustom() {
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    const kid = !!g.appearance.custom?.kid;
    g.appearance.custom = randomAppearance(kid);
    this.updateCustomRowLabels();
    this.updateCustomPreview();
    this.refreshList();
  }

  updateCustomRowLabels() {
    const g = this.entities.find(x => x.id === this.editingId);
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
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g || g.appearance?.mode !== 'custom') return;
    const custom = g.appearance.custom;
    try {
      const keys = bakeAppearanceTextures(this, custom);
      this.setPreviewTexture(keys.idle);
    } catch {
      ensureAppearanceTextures(this, custom).then(keys => {
        if (this.editingId === g.id && this.pickerTab === 'custom') {
          this.setPreviewTexture(keys.idle);
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
    const g = this.entities.find(x => x.id === this.editingId);
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
    modal.once('destroy', () => { this.input.off('wheel', wheelHandler); maskShape.destroy(); });
    modal.add(grid);
  }

  selectSlotVariant(category, id) {
    const g = this.entities.find(x => x.id === this.editingId);
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

  // ---------------------------------------------------------------------- list

  buildList(layout) {
    const x = layout.listX;
    const w = layout.listW;
    const headingY = layout.contentTop;
    const containerY = headingY + 28;
    const panelH = layout.panelH - 28;

    this.listHeading = this.add.text(x, headingY, this.tab === 'guests' ? 'Guests' : 'Staff', {
      fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8'
    });
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
    this.listHeading.setText(this.tab === 'guests' ? 'Guests' : 'Staff');

    const rowH = 44;
    const rowW = this.listRowW;
    this.entities.forEach((g, i) => {
      const y = i * rowH;
      this.ensureAppearanceDefaults(g);
      const bg = this.add.rectangle(0, y, rowW, 40, g.id === this.editingId ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      let preview;
      try {
        const keys = this.resolveIdleKeysSync(g);
        preview = this.add.image(24, y + 36, keys.idle, IDLE_FRAME_DOWN).setOrigin(0.5, 0.75).setDisplaySize(28, 56);
      }
      catch { preview = this.add.rectangle(8, y + 4, 32, 32, 0x4a4a5e); }

      let primary, secondary;
      if (this.tab === 'guests') {
        primary = g.name || '(unnamed)';
        const drinkLabel = this.menuName(g.drinkOrder) || 'Coffee';
        secondary = g.prefersBar ? `bar: ${drinkLabel}` : `${drinkLabel} → ${this.menuName(g.foodOrder) || 'Burger'}`;
      } else {
        primary = g.badge || this.describeRole(g);
        secondary = g.appearance?.charName || g.charName || 'Custom';
      }
      const name = this.add.text(48, y + 6, primary, { fontFamily: 'system-ui', fontSize: '14px', color: '#e6e6f0' });
      const sub = this.add.text(48, y + 22, secondary, { fontFamily: 'system-ui', fontSize: '11px', color: '#8fb6ff' });
      bg.on('pointerdown', () => { this.editingId = g.id; this.loadEditing(); this.refreshList(); });
      bg.on('pointerover', () => { if (g.id !== this.editingId) bg.setFillStyle(0x3a3a4d); });
      bg.on('pointerout', () => { if (g.id !== this.editingId) bg.setFillStyle(0x2b2b39); });
      this.listContainer.add([bg, preview, name, sub]);
    });

    let nextY = this.entities.length * rowH + 4;
    if (this.tab === 'guests') {
      const addBg = this.add.rectangle(0, nextY, rowW, 32, 0x2b4a2b).setOrigin(0, 0).setStrokeStyle(1, 0x4a6a4a)
        .setInteractive({ useHandCursor: true });
      const addTxt = this.add.text(rowW / 2, nextY + 16, '+ Add guest', { fontFamily: 'system-ui', fontSize: '14px', color: '#9aff9a' }).setOrigin(0.5);
      addBg.on('pointerdown', () => this.addGuest());
      addBg.on('pointerover', () => addBg.setFillStyle(0x3a6a3a));
      addBg.on('pointerout', () => addBg.setFillStyle(0x2b4a2b));
      this.listContainer.add([addBg, addTxt]);
      nextY += 40;

      if (this.editingId) {
        const delBg = this.add.rectangle(0, nextY, rowW, 28, 0x4a2b2b).setOrigin(0, 0).setStrokeStyle(1, 0x6a4a4a)
          .setInteractive({ useHandCursor: true });
        const delTxt = this.add.text(rowW / 2, nextY + 14, 'Delete selected', { fontFamily: 'system-ui', fontSize: '13px', color: '#ff9a9a' }).setOrigin(0.5);
        delBg.on('pointerdown', () => this.deleteGuest());
        delBg.on('pointerover', () => delBg.setFillStyle(0x6a3a3a));
        delBg.on('pointerout', () => delBg.setFillStyle(0x4a2b2b));
        this.listContainer.add([delBg, delTxt]);
        nextY += 28;
      }
    }
    this.listContentHeight = nextY;

    // Clamp scroll in case the roster shrank (e.g. a delete) since the last scroll position.
    const minY = this.listPanelY + Math.min(0, this.listPanelH - 4 - this.listContentHeight);
    this.listContainer.y = Phaser.Math.Clamp(this.listContainer.y, minY, this.listPanelY);
  }

  describeRole(g) {
    if (g.kind === 'host') return 'Host';
    if (g.kind === 'bartender') return 'Bartender';
    if (g.kind === 'cook') {
      const s = STATION_KEYS.find(s => s.key === g.stationKey);
      return `${s?.label || g.stationKey} Cook`;
    }
    if (g.kind === 'runner') return `Food Runner ${(g.slot ?? 0) + 1}`;
    return g.kind || 'Staff';
  }

  // ---------------------------------------------------------------------- form

  buildForm(layout) {
    const x = layout.formX, w = layout.formW, y0 = layout.contentTop;

    this.formHeading = this.add.text(x, y0, this.tab === 'guests' ? 'Edit guest' : 'Edit staff', {
      fontFamily: 'system-ui', fontSize: '18px', color: '#ffe9a8'
    });
    this.preview = this.add.image(x + 48, y0 + 84, '__pixel').setOrigin(0.5, 0.75).setDisplaySize(48, 96);

    this.guestFormObjects = [];
    this.staffFormObjects = [];
    this.buildGuestForm(x, y0, w);
    this.buildStaffForm(x, y0, w);

    this.refreshFormVisibility();
  }

  buildGuestForm(x, y0, w) {
    const inputW = Math.min(240, w - 16);
    const push = (...objs) => this.guestFormObjects.push(...objs);

    push(this.add.text(x, y0 + 138, 'Name', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.nameInput = this.add.dom(x, y0 + 166).createFromHTML(
      `<input type="text" style="width:${inputW}px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.nameInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.nameInput);

    push(this.add.text(x, y0 + 188, 'Patience (seconds)', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.patienceInput = this.add.dom(x, y0 + 216).createFromHTML(
      `<input type="number" min="10" max="300" style="width:120px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.patienceInput).addEventListener('input', () => this.applyFormToEditing());
    push(this.patienceInput);

    // Drink dropdown (stage 1 — everyone orders a drink first).
    push(this.add.text(x, y0 + 238, 'Drink', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    const drinkOpts = this.drinkItems.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    this.drinkInput = this.add.dom(x, y0 + 266).createFromHTML(
      `<select style="width:160px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;">${drinkOpts}</select>`
    ).setOrigin(0, 0.5);
    this.getInput(this.drinkInput).addEventListener('change', () => this.applyFormToEditing());
    push(this.drinkInput);

    // Food dropdown (stage 2 — skipped entirely for prefersBar guests).
    this.foodLabel = this.add.text(x, y0 + 288, 'Food', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    push(this.foodLabel);
    const foodOpts = this.foodItems.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    this.foodInput = this.add.dom(x, y0 + 316).createFromHTML(
      `<select style="width:160px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;">${foodOpts}</select>`
    ).setOrigin(0, 0.5);
    this.getInput(this.foodInput).addEventListener('change', () => this.applyFormToEditing());
    push(this.foodInput);

    // Prefers bar checkbox — skips the host queue, drink-only visit.
    this.barInput = this.add.dom(x, y0 + 348).createFromHTML(
      `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:13px;color:#c9c9d6;cursor:pointer;">
         <input type="checkbox" style="width:16px;height:16px;" />
         Prefers bar (drink only, skips queue)
       </label>`
    ).setOrigin(0, 0.5);
    this.getInput(this.barInput).addEventListener('change', () => this.applyFormToEditing());
    push(this.barInput);

    // Allergies — metadata only for now; doesn't affect order generation or serving.
    push(this.add.text(x, y0 + 380, 'Allergies', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.allergyInputs = {};
    ALLERGENS.forEach((name, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const ax = x + col * 130, ay = y0 + 404 + row * 24;
      const dom = this.add.dom(ax, ay).createFromHTML(
        `<label style="display:flex;align-items:center;gap:6px;font-family:system-ui;font-size:12px;color:#c9c9d6;cursor:pointer;">
           <input type="checkbox" style="width:14px;height:14px;" /> ${name}
         </label>`
      ).setOrigin(0, 0.5);
      this.getInput(dom).addEventListener('change', () => this.applyFormToEditing());
      this.allergyInputs[name] = dom;
      push(dom);
    });

    push(this.add.text(x, this.layout.height - 40,
      'Pick a character from the left panel. Idle pose shown for walking, sit pose used when seated.',
      { fontFamily: 'system-ui', fontSize: '12px', color: '#7a7a8a', wordWrap: { width: w } }));
  }

  buildStaffForm(x, y0, w) {
    const inputW = Math.min(240, w - 16);
    const push = (...objs) => this.staffFormObjects.push(...objs);

    push(this.add.text(x, y0 + 138, 'Role', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.roleValueText = this.add.text(x, y0 + 162, '', { fontFamily: 'system-ui', fontSize: '15px', color: '#8fb6ff' });
    push(this.roleValueText);

    push(this.add.text(x, y0 + 200, 'Badge label', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }));
    this.badgeInput = this.add.dom(x, y0 + 228).createFromHTML(
      `<input type="text" style="width:${inputW}px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;" />`
    ).setOrigin(0, 0.5);
    this.getInput(this.badgeInput).addEventListener('input', () => this.applyNpcFormToEditing());
    push(this.badgeInput);

    push(this.add.text(x, y0 + 262,
      'Staff roles are fixed slots tied to the floor plan (one host, one bartender, one cook per station, two food runners) — pick an appearance on the left and set the label shown above them in-game.',
      { fontFamily: 'system-ui', fontSize: '11px', color: '#7a7a8a', wordWrap: { width: w } }));
  }

  refreshFormVisibility() {
    const active = this.isPanelActive('form');
    const guestActive = active && this.tab === 'guests';
    const staffActive = active && this.tab === 'staff';
    this.formHeading.setVisible(active);
    this.formHeading.setText(this.tab === 'guests' ? 'Edit guest' : 'Edit staff');
    this.preview.setVisible(active);
    for (const o of this.guestFormObjects) o.setVisible(guestActive);
    for (const o of this.staffFormObjects) o.setVisible(staffActive);
  }

  getInput(domEl) { return domEl.node.querySelector('input,select'); }

  /** setTexture() alone resets the frame's base size but not scale, so a display size set against
   * the placeholder '__pixel' texture would otherwise carry over — always re-lock the size after. */
  setPreviewTexture(idleKey) {
    this.preview.setTexture(idleKey, IDLE_FRAME_DOWN).setDisplaySize(48, 96);
  }

  menuName(id) { return this.menuItems.find(m => m.id === id)?.name || id; }

  ensureAppearanceDefaults(g) {
    if (!g.appearance) g.appearance = { mode: 'preset', charName: g.charName || 'Adam' };
  }

  /** Throws if a custom entity's layer textures aren't loaded yet — callers decide the fallback. */
  resolveIdleKeysSync(g) {
    if (g.appearance?.mode === 'custom' && g.appearance.custom) {
      return bakeAppearanceTextures(this, g.appearance.custom);
    }
    return charKeys(g.appearance?.charName || g.charName || 'Adam');
  }

  loadEditing() {
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g) return;
    this.ensureAppearanceDefaults(g);
    this.showPickerTab(g.appearance.mode === 'custom' ? 'custom' : 'preset');

    if (g.appearance.mode === 'custom') {
      this.updateCustomRowLabels();
      this.updateCustomPreview();
    } else {
      const keys = charKeys(g.appearance.charName || g.charName || 'Adam');
      this.setPreviewTexture(keys.idle);
    }

    if (this.tab === 'guests') {
      this.getInput(this.nameInput).value = g.name || '';
      this.getInput(this.patienceInput).value = g.patience;
      this.getInput(this.drinkInput).value = g.drinkOrder || 'coffee';
      this.getInput(this.foodInput).value = g.foodOrder || 'burger';
      this.getInput(this.barInput).checked = !!g.prefersBar;
      this.refreshFoodRow(!!g.prefersBar);
      for (const name of ALLERGENS) this.getInput(this.allergyInputs[name]).checked = (g.allergies || []).includes(name);
    } else {
      this.getInput(this.badgeInput).value = g.badge || '';
      this.roleValueText.setText(this.describeRole(g));
    }

    // Highlight selected character.
    const activeCharName = g.appearance.charName || g.charName;
    for (const b of this.charButtons) {
      b.bg.setFillStyle(b.name === activeCharName ? 0x4a4a5e : 0x2b2b39);
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
    const g = this.entities.find(x => x.id === this.editingId);
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

  applyNpcFormToEditing() {
    const g = this.entities.find(x => x.id === this.editingId);
    if (!g) return;
    g.badge = this.getInput(this.badgeInput).value || g.badge || 'STAFF';
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
    Storage.saveNPCs(this.npcs);
    this.flash('Saved.');
  }

  exportActive() {
    Storage.downloadJSON(this.entities, this.tab === 'guests' ? 'guests.json' : 'npcs.json');
  }

  async importActive() {
    try {
      const data = await Storage.pickJSON();
      if (this.tab === 'guests') {
        this.guests = data;
        Storage.saveGuests(data);
        this.editingGuestId = this.guests[0]?.id || null;
      } else {
        this.npcs = data;
        Storage.saveNPCs(data);
        this.editingNpcId = this.npcs[0]?.id || null;
      }
      this.refreshList();
      this.loadEditing();
      this.flash('Imported.');
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
