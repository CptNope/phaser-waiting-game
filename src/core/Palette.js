// Palette: renders a spritesheet as a scrollable grid of clickable frames.
// Used by the Floor Plan editor as the tile picker.
export class Palette {
  // scene, sheetKey, frameW/H, onPick(frameIndex), options:
  //   cols  - how many frames per palette row
  //   only  - optional array of frame indices to show, packed left-to-right.
  //           Used with the generated asset index to skip blank frames; some
  //           sheets are 8500+ frames and rendering them all is prohibitive.
  constructor(scene, sheetKey, frameW, frameH, onPick, options = {}) {
    this.scene = scene;
    this.sheetKey = sheetKey;
    this.frameW = frameW;
    this.frameH = frameH;
    this.onPick = onPick;
    this.cols = options.cols || 8;
    this.only = options.only && options.only.length ? options.only : null;
    this.container = scene.add.container(0, 0);
    this.buttons = [];
    this.selected = -1;
    this.build();
  }

  build() {
    const tex = this.scene.textures.get(this.sheetKey);
    if (!tex || tex.key === '__MISSING') return;
    const src = tex.source[0];
    const sheetCols = Math.floor(src.width / this.frameW);
    const sheetRows = Math.floor(src.height / this.frameH);
    const cell = this.frameW; // 1:1 scale in palette
    const pad = 2;
    const step = cell + pad;

    // Packed mode uses this.cols per row; full mode mirrors the sheet layout so
    // tiles stay in their familiar positions.
    const list = this.only || Array.from({ length: sheetCols * sheetRows }, (_, i) => i);
    const perRow = this.only ? this.cols : sheetCols;

    list.forEach((frameIdx, n) => {
      const x = (n % perRow) * step;
      const y = Math.floor(n / perRow) * step;
      const img = this.scene.add.image(x, y, this.sheetKey, frameIdx)
        .setOrigin(0, 0).setDisplaySize(cell, cell);
      const hit = this.scene.add.rectangle(x, y, cell, cell, 0xffffff, 0.001)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true });
      hit.on('pointerover', () => img.setTint(0xccddff));
      hit.on('pointerout', () => { if (frameIdx !== this.selected) img.clearTint(); });
      hit.on('pointerdown', () => this.select(frameIdx));
      this.container.add([img, hit]);
      this.buttons.push({ frameIdx, img, hit });
    });

    this.frameCount = list.length;
    this.contentHeight = Math.ceil(list.length / perRow) * step;
    this.contentWidth = Math.min(list.length, perRow) * step;
  }

  select(frameIdx) {
    this.selected = frameIdx;
    for (const b of this.buttons) {
      if (b.frameIdx === frameIdx) b.img.setTint(0x8fb6ff);
      else b.img.clearTint();
    }
    if (this.onPick) this.onPick(frameIdx);
  }

  setVisible(v) { this.container.setVisible(v); }
  destroy() { this.container.destroy(); }
}
