import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { Storage } from '../core/Storage.js';

export class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create() {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#1b1b22');

    const titleSize = Phaser.Math.Clamp(Math.round(height * 0.095), 32, 56);
    const subtitleSize = Phaser.Math.Clamp(Math.round(height * 0.032), 14, 20);
    this.add.text(width / 2, height * 0.10, 'WAITING GAME', {
      fontFamily: 'system-ui', fontSize: `${titleSize}px`, fontStyle: 'bold', color: '#ffe9a8'
    }).setOrigin(0.5);
    this.add.text(width / 2, height * 0.15, 'a cozy waiting-tables sim', {
      fontFamily: 'system-ui', fontSize: `${subtitleSize}px`, color: '#8fb6ff'
    }).setOrigin(0.5);

    const buttons = [
      { label: 'Play Shift',        action: () => this.scene.start('Game') },
      { label: 'Floor Plan Editor', action: () => this.scene.start('FloorPlanEditor') },
      { label: 'Guests & Staff',    action: () => this.scene.start('GuestEditor') },
      { label: 'Menu Editor',       action: () => this.scene.start('MenuEditor') },
      { label: 'Export Floor Plan', action: () => {
          const p = Storage.loadPlan();
          if (!p) return this.flash('No saved floor plan yet.');
          Storage.downloadJSON(p, 'floor-plan.json');
        } },
      { label: 'Import Floor Plan', action: () => this.importPlan() }
    ];

    const narrow = width < 900;
    // Scale button height and vertical spacing so all buttons fit on short screens.
    const btnH = Phaser.Math.Clamp(Math.round(height * 0.10), 40, 56);
    const gap = Phaser.Math.Clamp(Math.round(height * 0.075), 32, 64);
    const startY = Math.round(height * 0.22);
    const btnW = narrow ? Math.min(320, width - 48) : Math.min(360, width * 0.45);
    buttons.forEach((b, i) => this.makeButton(width / 2, startY + i * gap, btnW, btnH, b.label, b.action));

    // Keep the hint short and within the bottom safe margin.
    const controlsHint = 'D-pad/Arrows move • E/Action acts • \u2261/ESC menu';
    this.add.text(width / 2, height - 20, controlsHint, {
      fontFamily: 'system-ui', fontSize: narrow ? '13px' : '14px', color: '#6b6b7a'
    }).setOrigin(0.5);

    this.flashText = this.add.text(width / 2, height - 60, '', {
      fontFamily: 'system-ui', fontSize: '16px', color: '#ff9a9a'
    }).setOrigin(0.5);
  }

  makeButton(x, y, w, h, label, onClick) {
    const fontSize = Phaser.Math.Clamp(Math.round(h * 0.45), 14, 20);
    const bg = this.add.rectangle(x, y, w, h, 0x2b2b39, 1).setStrokeStyle(2, 0x4a4a5e)
      .setInteractive({ useHandCursor: true });
    const txt = this.add.text(x, y, label, {
      fontFamily: 'system-ui', fontSize: `${fontSize}px`, color: '#e6e6f0'
    }).setOrigin(0.5);
    bg.on('pointerover', () => { bg.setFillStyle(0x3a3a4d); txt.setColor('#ffe9a8'); });
    bg.on('pointerout', () => { bg.setFillStyle(0x2b2b39); txt.setColor('#e6e6f0'); });
    bg.on('pointerdown', onClick);
    return { bg, txt };
  }

  async importPlan() {
    try {
      const data = await Storage.pickJSON();
      Storage.savePlan(data);
      this.flash('Floor plan imported & saved.');
    } catch (e) {
      if (e && e.message !== 'No file selected') this.flash('Import failed: ' + e.message);
    }
  }

  flash(msg) {
    this.flashText.setText(msg);
    this.time.delayedCall(2500, () => this.flashText.setText(''));
  }
}
