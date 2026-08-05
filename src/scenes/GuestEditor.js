import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { CHARACTERS, MENU_LABELS, charKeys, IDLE_FRAME_DOWN, IDLE_FRAMES } from '../data/catalog.js';
import { Storage } from '../core/Storage.js';
import { DEFAULT_GUESTS } from '../data/defaults.js';

const LIST_W = 240;
const TOOLBAR_H = 56;

export class GuestEditorScene extends Phaser.Scene {
  constructor() { super('GuestEditor'); }

  create() {
    this.cameras.main.setBackgroundColor('#23232c');
    this.guests = Storage.loadGuests() || JSON.parse(JSON.stringify(DEFAULT_GUESTS));
    this.editingId = this.guests[0]?.id || null;

    const { width, height } = this.scale;
    this.buildToolbar(width);
    this.buildCharPicker();
    this.buildList();
    this.buildForm(height);
    this.refreshList();
    this.loadEditing();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));
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

  // Character picker: scrollable grid of idle poses from all named characters.
  buildCharPicker() {
    const panelX = 8, panelY = TOOLBAR_H + 12;
    const panelW = LIST_W - 16;
    const panelH = this.scale.height - panelY - 40;

    this.add.text(panelX, panelY - 4, 'Character', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' }).setDepth(60);

    this.charContainer = this.add.container(panelX, panelY + 16).setDepth(50);
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
      this.charContainer.add([bg, img, label]);
      this.charButtons.push({ name, bg });
    });

    // Mask for scrolling.
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff, 1).fillRect(panelX, panelY + 16, panelW, panelH - 20);
    this.charContainer.setMask(maskShape.createGeometryMask());

    // Wheel scroll.
    const contentH = Math.ceil(CHARACTERS.length / cols) * (cellH + pad);
    this.input.on('wheel', (pointer) => {
      if (pointer.x < panelX || pointer.x > panelX + panelW) return;
      const minY = panelH - 20 - contentH;
      let ny = Phaser.Math.Clamp(this.charContainer.y - Math.sign(pointer.event.deltaY) * 50, Math.min(0, minY), 16);
      this.charContainer.y = ny;
    });
  }

  pickCharacter(name) {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    g.charName = name;
    if (!g.name || g.name === '(unnamed)') g.name = name.replace(/_/g, ' ');
    // Highlight selected.
    for (const b of this.charButtons) {
      b.bg.setFillStyle(b.name === name ? 0x4a4a5e : 0x2b2b39);
    }
    this.loadEditing();
    this.refreshList();
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
      const keys = charKeys(g.charName || 'Adam');
      const bg = this.add.rectangle(0, y, 220, 40, g.id === this.editingId ? 0x4a4a5e : 0x2b2b39)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4a5e).setInteractive({ useHandCursor: true });
      let preview;
      try { preview = this.add.image(24, y + 36, keys.idle, IDLE_FRAME_DOWN).setOrigin(0.5, 0.75).setDisplaySize(28, 56); }
      catch { preview = this.add.rectangle(8, y + 4, 32, 32, 0x4a4a5e); }
      const name = this.add.text(48, y + 6, g.name || '(unnamed)', { fontFamily: 'system-ui', fontSize: '14px', color: '#e6e6f0' });
      const order = this.add.text(48, y + 22, 'wants ' + (MENU_LABELS[g.order] || g.order), { fontFamily: 'system-ui', fontSize: '11px', color: '#8fb6ff' });
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

    // Order dropdown.
    this.add.text(x, TOOLBAR_H + 250, 'Order', { fontFamily: 'system-ui', fontSize: '13px', color: '#c9c9d6' });
    const orderOpts = Object.entries(MENU_LABELS).map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    this.orderInput = this.add.dom(x, TOOLBAR_H + 278).createFromHTML(
      `<select style="width:160px;padding:6px 8px;font-size:14px;background:#1b1b22;color:#e6e6f0;border:1px solid #4a4a5e;border-radius:3px;">${orderOpts}</select>`
    ).setOrigin(0, 0.5);
    this.getInput(this.orderInput).addEventListener('change', () => this.applyFormToEditing());

    this.add.text(x, height - 40,
      'Pick a character from the left panel. Idle pose shown for walking, sit pose used when seated.',
      { fontFamily: 'system-ui', fontSize: '12px', color: '#7a7a8a' });
  }

  getInput(domEl) { return domEl.node.querySelector('input,select'); }

  loadEditing() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    const keys = charKeys(g.charName || 'Adam');
    this.preview.setTexture(keys.idle, IDLE_FRAME_DOWN);
    this.getInput(this.nameInput).value = g.name || '';
    this.getInput(this.patienceInput).value = g.patience;
    this.getInput(this.orderInput).value = g.order;
    // Highlight selected character.
    for (const b of this.charButtons) {
      b.bg.setFillStyle(b.name === g.charName ? 0x4a4a5e : 0x2b2b39);
    }
  }

  applyFormToEditing() {
    const g = this.guests.find(x => x.id === this.editingId);
    if (!g) return;
    g.name = this.getInput(this.nameInput).value || '(unnamed)';
    g.patience = Math.max(10, parseInt(this.getInput(this.patienceInput).value, 10) || 60);
    g.order = this.getInput(this.orderInput).value;
    this.refreshList();
  }

  addGuest() {
    const id = 'g' + Date.now();
    const firstChar = CHARACTERS[0];
    this.guests.push({ id, name: firstChar.replace(/_/g, ' '), charName: firstChar, patience: 60, order: 'burger' });
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
