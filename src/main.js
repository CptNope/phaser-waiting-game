import * as Phaser from 'https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.esm.js';
import { BootScene } from './scenes/Boot.js';
import { MenuScene } from './scenes/Menu.js';
import { FloorPlanEditorScene } from './scenes/FloorPlanEditor.js';
import { GuestEditorScene } from './scenes/GuestEditor.js';
import { GameScene } from './scenes/Game.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#1b1b22',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%'
  },
  scene: [BootScene, MenuScene, FloorPlanEditorScene, GuestEditorScene, GameScene],
  dom: { createContainer: true }
};

const game = new Phaser.Game(config);

// Register service worker for PWA offline support.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Expose for debugging.
window.__game = game;
