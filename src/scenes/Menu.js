import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { Storage } from '../core/Storage.js';

export class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create() {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#1b1b22');

    this.add.text(width / 2, 90, 'WAITING GAME', {
      fontFamily: 'system-ui', fontSize: '52px', fontStyle: 'bold', color: '#ffe9a8'
    }).setOrigin(0.5);
    this.add.text(width / 2, 140, 'a cozy waiting-tables sim', {
      fontFamily: 'system-ui', fontSize: '18px', color: '#8fb6ff'
    }).setOrigin(0.5);

    const buttons = [
      { label: 'Play Shift',        action: () => this.scene.start('Game') },
      { label: 'Floor Plan Editor', action: () => this.scene.start('FloorPlanEditor') },
      { label: 'Guest Editor',      action: () => this.scene.start('GuestEditor') },
      { label: 'Export Floor Plan', action: () => {
          const p = Storage.loadPlan();
          if (!p) return this.flash('No saved floor plan yet.');
          Storage.downloadJSON(p, 'floor-plan.json');
        } },
      { label: 'Export Guests',     action: () => {
          const g = Storage.loadGuests();
          if (!g) return this.flash('No saved guests yet.');
          Storage.downloadJSON(g, 'guests.json');
        } },
      { label: 'Import Floor Plan', action: () => this.import('plan') },
      { label: 'Import Guests',     action: () => this.import('guests') }
    ];

    const startY = 220;
    const gap = 56;
    buttons.forEach((b, i) => this.makeButton(width / 2, startY + i * gap, 280, 44, b.label, b.action));

    this.add.text(width / 2, height - 24, 'WASD / Arrows to move • E to interact', {
      fontFamily: 'system-ui', fontSize: '14px', color: '#6b6b7a'
    }).setOrigin(0.5);

    this.flashText = this.add.text(width / 2, height - 60, '', {
      fontFamily: 'system-ui', fontSize: '16px', color: '#ff9a9a'
    }).setOrigin(0.5);
  }

  makeButton(x, y, w, h, label, onClick) {
    const bg = this.add.rectangle(x, y, w, h, 0x2b2b39, 1).setStrokeStyle(2, 0x4a4a5e)
      .setInteractive({ useHandCursor: true });
    const txt = this.add.text(x, y, label, {
      fontFamily: 'system-ui', fontSize: '18px', color: '#e6e6f0'
    }).setOrigin(0.5);
    bg.on('pointerover', () => { bg.setFillStyle(0x3a3a4d); txt.setColor('#ffe9a8'); });
    bg.on('pointerout', () => { bg.setFillStyle(0x2b2b39); txt.setColor('#e6e6f0'); });
    bg.on('pointerdown', onClick);
    return { bg, txt };
  }

  async import(kind) {
    try {
      const data = await Storage.pickJSON();
      if (kind === 'plan') { Storage.savePlan(data); this.flash('Floor plan imported & saved.'); }
      else { Storage.saveGuests(data); this.flash('Guests imported & saved.'); }
    } catch (e) {
      if (e && e.message !== 'No file selected') this.flash('Import failed: ' + e.message);
    }
  }

  flash(msg) {
    this.flashText.setText(msg);
    this.time.delayedCall(2500, () => this.flashText.setText(''));
  }
}
