// The path a player takes from opening the page to playing, as a small state
// machine a game's UI can hang screens on. The engine draws none of these
// screens (a game's menus are its own HTML); it tracks where the player is,
// refuses nonsense transitions, and fires an event for each change.
//
//   boot ─► title ─► login ─► characters ─► loading ─► playing ─► disconnected ─► title
//                │                              ▲          │
//                └──────── (offline play) ──────┘          └─► title   (log out / leave)
//
//   game.flow.on('title', () => showTitle());
//   game.flow.on('playing', () => hideMenus());
//   game.flow.on('change', ({ from, to, data }) => ...);
//   await game.flow.enter(account, characterId, { url });    // loading → playing, or → disconnected on failure
//
// States are plain strings so a game can show its own screen per state. Add your own with
// flow.allow('characters', 'create') for a character-creation screen between two of the stock ones.

const TRANSITIONS = {
  boot: ['title'],
  title: ['login', 'loading', 'playing'],       // 'loading'/'playing' straight from the title: a single-player "New Game"
  login: ['title', 'characters'],
  characters: ['title', 'loading', 'login'],
  loading: ['playing', 'disconnected', 'characters', 'title'],
  playing: ['title', 'disconnected', 'loading'],
  disconnected: ['title', 'loading', 'characters'],
};

export class Flow {
  constructor(game) {
    this.game = game;
    this.state = 'boot';
    this.data = null;
    this.table = Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, new Set(v)]));
    this.handlers = new Map();
    this.history = [];
    this.wired = false;
  }

  /** Permit a transition the stock table does not (for a screen of your own). */
  allow(from, to) {
    (this.table[from] ||= new Set()).add(to);
    this.table[to] ||= new Set();
    return this;
  }

  /** Listen for entering a state ('title', 'playing', ...) or every change ('change'). Returns an unsubscribe function. */
  on(state, fn) {
    if (!this.handlers.has(state)) this.handlers.set(state, new Set());
    this.handlers.get(state).add(fn);
    return () => this.handlers.get(state).delete(fn);
  }

  emit(name, payload) {
    for (const fn of this.handlers.get(name) || []) {
      try { fn(payload); } catch (err) { console.error(`[fount] flow handler for "${name}" threw:`, err); }
    }
  }

  can(to) { return !!(this.table[this.state] && this.table[this.state].has(to)); }

  /** Move to another state. Returns false (and changes nothing) if the table does not allow it from here. */
  go(to, data = null) {
    if (to === this.state) return true;
    if (!this.can(to)) {
      console.warn(`[fount] flow: cannot go from "${this.state}" to "${to}"`);
      return false;
    }
    const from = this.state;
    this.state = to;
    this.data = data;
    this.history.push(to);
    if (this.history.length > 50) this.history.shift();
    this.emit('change', { from, to, data });
    this.emit(to, data);
    return true;
  }

  /** Begin: boot → title. Also hooks the game's connection events so a dropped connection moves the flow on its own. */
  start() {
    this.wire();
    if (this.state === 'boot') this.go('title');
    return this;
  }

  wire() {
    if (this.wired) return;
    this.wired = true;
    const ev = this.game.events;
    ev.on('online-ended', ({ reason } = {}) => { if (this.state === 'playing' || this.state === 'loading') this.go('disconnected', { reason: reason || 'The connection was lost.' }); });
  }

  /**
   * Log in and play a character: loading, then playing. `account` is an AccountClient and `characterId` one of its
   * characters. On failure the flow lands on 'disconnected' with the server's reason, and the promise rejects.
   */
  async enter(account, characterId, options = {}) {
    this.wire();
    if (!this.go('loading', { characterId })) throw new Error(`Cannot start playing from "${this.state}".`);
    try {
      await this.game.playOnline(options.url || account.socketUrl(), { hello: account.hello(characterId) });
    } catch (err) {
      this.go('disconnected', { reason: err.message });
      throw err;
    }
    this.go('playing', { characterId });
    return this.game.online;
  }

  /** Leave the world and return to the title screen. */
  leave() {
    this.game.goOffline();
    return this.go('title');
  }
}
