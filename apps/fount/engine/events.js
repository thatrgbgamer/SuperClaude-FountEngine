// A tiny event emitter. Gameplay code (actors, combat, abilities) reports what
// happened through events instead of reaching into audio, particles or HUD, so
// the same simulation can run headless — in Node for tests, and on a server
// later — and any layer that cares simply subscribes.

export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(name, fn) {
    let list = this._handlers.get(name);
    if (!list) this._handlers.set(name, (list = []));
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (...args) => { off(); fn(...args); });
    return off;
  }

  off(name, fn) {
    const list = this._handlers.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(name, ...args) {
    const list = this._handlers.get(name);
    if (!list || !list.length) return;
    // Copy: a handler that unsubscribes itself must not skip its neighbour.
    for (const fn of list.slice()) {
      try {
        fn(...args);
      } catch (err) {
        // One bad listener should not take the simulation down with it, but it
        // must not vanish either.
        console.error(`[fount] "${name}" handler threw:`, err);
      }
    }
  }
}
