// A small client for a server's account and character API, so a game's login
// and character-select screens do not each re-write the fetch calls. It holds
// the session token (kept in localStorage when the browser allows it) and
// turns server errors into exceptions carrying the server's message and code,
// ready to show a player.
//
//   const acct = new AccountClient();                       // same origin as the page
//   await acct.login('ada', 'a long password');
//   const { characters } = await acct.characters();
//   await acct.createCharacter('Brightblade', 'warrior');
//   await game.playOnline(acct.socketUrl(), { hello: acct.hello(characterId) });

export class AccountError extends Error {
  constructor(message, code, status, retryAfter) { super(message); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}

export class AccountClient {
  constructor(base = '', options = {}) {
    this.base = base.replace(/\/$/, '');
    this.storageKey = options.storageKey || 'fount.session';
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.token = this.load();
    this.account = null;
  }

  load() { try { return localStorage.getItem(this.storageKey) || null; } catch { return null; } }
  remember(token) { this.token = token; try { token ? localStorage.setItem(this.storageKey, token) : localStorage.removeItem(this.storageKey); } catch { /* storage may be blocked */ } }

  get loggedIn() { return !!this.token; }

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new AccountError('Could not reach the server.', 'network', 0);
    }
    let data = {};
    try { data = await res.json(); } catch { /* an empty body is fine */ }
    if (!res.ok) {
      if (res.status === 401 && data.code === 'login-required') this.remember(null);   // the saved session has expired
      throw new AccountError(data.error || `The server answered ${res.status}.`, data.code || 'error', res.status, data.retryAfter);
    }
    return data;
  }

  async register(name, password) {
    const d = await this.request('POST', '/api/register', { name, password });
    this.remember(d.token); this.account = d.account;
    return d.account;
  }

  async login(name, password) {
    const d = await this.request('POST', '/api/login', { name, password });
    this.remember(d.token); this.account = d.account;
    return d.account;
  }

  /** Log in with a one-time link an operator gave you. */
  async loginWithMagic(magic) {
    const d = await this.request('POST', '/api/login', { magic });
    this.remember(d.token); this.account = d.account;
    return d.account;
  }

  async logout() {
    try { await this.request('POST', '/api/logout'); } finally { this.remember(null); this.account = null; }
  }

  /** The signed-in account and its characters, or null if the saved session is no longer valid. */
  async me() {
    if (!this.token) return null;
    try {
      const d = await this.request('GET', '/api/me');
      this.account = d.account;
      return d;
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  }

  async characters() { return this.request('GET', '/api/characters'); }
  async createCharacter(name, cls) { return (await this.request('POST', '/api/characters', { name, class: cls })).character; }
  async deleteCharacter(id, confirmName) { return this.request('DELETE', `/api/characters/${id}`, { confirm: confirmName }); }

  async changePassword(oldPassword, newPassword) {
    const d = await this.request('POST', '/api/password', { old: oldPassword, new: newPassword });
    this.remember(d.token);
  }

  /** What to pass as playOnline's hello to play a character. */
  hello(characterId) { return { token: this.token, character: String(characterId) }; }

  /** The WebSocket address of the server this client talks to. */
  socketUrl() {
    const base = this.base || (typeof location !== 'undefined' ? location.origin : '');
    return base.replace(/^http/, 'ws');
  }
}
