// Remappable actions. Game code asks "is `forward` down?" or "was `hotbar1`
// pressed?", never "is KeyW down?", so a player can rebind everything and a
// game can ship its own defaults. Pure and DOM-free: the game feeds it key and
// mouse events, which keeps it testable and keeps a single binding table.

export const DEFAULT_BINDINGS = {
  // Movement (also the first-person defaults)
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  fire: ['KeyF', 'Enter', 'ControlLeft', 'ControlRight'],
  // Top-down / RPG
  primary: ['Mouse0'],
  secondary: ['Mouse2'],
  interact: ['KeyE'],
  inventory: ['KeyI'],
  chat: ['Enter'],
  camLeft: ['BracketLeft'],
  camRight: ['BracketRight'],
  hotbar1: ['Digit1'],
  hotbar2: ['Digit2'],
  hotbar3: ['Digit3'],
  hotbar4: ['Digit4'],
  hotbar5: ['Digit5'],
  hotbar6: ['Digit6'],
  hotbar7: ['Digit7'],
  hotbar8: ['Digit8'],
  hotbar9: ['Digit9'],
  hotbar10: ['Digit0'],
};

const STORAGE_KEY = 'fount.keys';

export class Input {
  constructor(bindings = DEFAULT_BINDINGS) {
    this.defaults = clone(bindings);
    this.bindings = clone(bindings);
    this.codes = new Set();        // physical keys and buttons currently held
    this.latched = new Set();      // actions pressed since someone last asked
    this.capture = null;           // { action, resolve } while waiting for a rebind
    this._lookup = null;
  }

  // ---- events fed in by the game ------------------------------------------

  keyDown(code) {
    if (this.capture) {
      const { action, resolve, add } = this.capture;
      this.capture = null;
      if (code === 'Escape') { resolve(null); return; }
      if (add) this.add(action, code); else this.bind(action, [code]);
      resolve(code);
      return;
    }
    if (this.codes.has(code)) return;           // auto-repeat is not a new press
    this.codes.add(code);
    for (const action of this.actionsFor(code)) this.latched.add(action);
  }

  keyUp(code) { this.codes.delete(code); }

  mouseDown(button) { this.keyDown(`Mouse${button}`); }
  mouseUp(button) { this.keyUp(`Mouse${button}`); }

  clear() {
    this.codes.clear();
    this.latched.clear();
  }

  // ---- queries ---------------------------------------------------------------

  /** Is any key bound to this action currently held? */
  isDown(action) {
    const list = this.bindings[action];
    if (!list) return false;
    for (const code of list) if (this.codes.has(code)) return true;
    return false;
  }

  /**
   * True once per press. Fixed-timestep games can run several physics steps in
   * one frame; latching means whichever step asks first sees the press and the
   * others do not, instead of a tap firing an ability three times.
   */
  pressed(action) {
    if (this.latched.has(action)) { this.latched.delete(action); return true; }
    return false;
  }

  // ---- bindings ---------------------------------------------------------------

  actionsFor(code) {
    if (!this._lookup) {
      this._lookup = new Map();
      for (const [action, codes] of Object.entries(this.bindings)) {
        for (const c of codes) {
          if (!this._lookup.has(c)) this._lookup.set(c, []);
          this._lookup.get(c).push(action);
        }
      }
    }
    return this._lookup.get(code) || [];
  }

  bind(action, codes) {
    this.bindings[action] = [].concat(codes);
    this._lookup = null;
  }

  add(action, code) {
    const list = (this.bindings[action] ||= []);
    if (!list.includes(code)) list.push(code);
    this._lookup = null;
  }

  remove(action, code) {
    const list = this.bindings[action];
    if (!list) return;
    this.bindings[action] = list.filter((c) => c !== code);
    this._lookup = null;
  }

  /** Merge a { action: code | [codes] } table over the current bindings. */
  configure(table) {
    for (const [action, codes] of Object.entries(table || {})) this.bind(action, codes);
  }

  reset() {
    this.bindings = clone(this.defaults);
    this._lookup = null;
  }

  /**
   * Wait for the next key press and bind it to `action`. Resolves with the code,
   * or null if the player pressed Escape. Drives a "press a key..." rebind UI.
   */
  rebind(action, { add = false } = {}) {
    return new Promise((resolve) => { this.capture = { action, resolve, add }; });
  }

  /** "W / UP" style label for showing a binding to the player. */
  describe(action) {
    return (this.bindings[action] || []).map(label).join(' / ') || 'unbound';
  }

  // ---- persistence (a player's rebinds survive a reload) -------------------------

  save(storage = globalThis.localStorage) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(this.bindings)); } catch { /* storage may be blocked */ }
  }

  load(storage = globalThis.localStorage) {
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') this.configure(saved);
    } catch { /* corrupt or blocked: keep the defaults */ }
  }
}

function label(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return ['Left click', 'Middle click', 'Right click'][+code.slice(5)] || code;
  return code.replace('Arrow', '').replace('Left', ' L').replace('Right', ' R').toUpperCase();
}

function clone(table) {
  return Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v]]));
}
