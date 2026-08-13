// Lightweight persistence: localStorage cache + JSON export/import.
const KEY_PLAN = 'waiting-game.floorplan';
const KEY_GUESTS = 'waiting-game.guests';
const KEY_MENU = 'waiting-game.menu';
const KEY_NPCS = 'waiting-game.npcs';

export const Storage = {
  loadPlan() {
    try {
      const raw = localStorage.getItem(KEY_PLAN);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  savePlan(plan) {
    try { localStorage.setItem(KEY_PLAN, JSON.stringify(plan)); } catch {}
  },
  loadGuests() {
    try {
      const raw = localStorage.getItem(KEY_GUESTS);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  saveGuests(guests) {
    try { localStorage.setItem(KEY_GUESTS, JSON.stringify(guests)); } catch {}
  },
  loadNPCs() {
    try {
      const raw = localStorage.getItem(KEY_NPCS);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  saveNPCs(npcs) {
    try { localStorage.setItem(KEY_NPCS, JSON.stringify(npcs)); } catch {}
  },
  loadMenu() {
    try {
      const raw = localStorage.getItem(KEY_MENU);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  saveMenu(items) {
    try { localStorage.setItem(KEY_MENU, JSON.stringify(items)); } catch {}
  },

  downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // Returns a Promise<parsed> from a user-picked file.
  pickJSON() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return reject(new Error('No file selected'));
        const reader = new FileReader();
        reader.onload = () => {
          try { resolve(JSON.parse(reader.result)); }
          catch (e) { reject(e); }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      };
      input.click();
    });
  }
};
