// Gold, and any other counter a game wants audited. One API for single player
// and for a server, so game scripts are written once:
//
//   world.context.economy.grant(player, 25, 'loot', { monster: 'imp' });
//   if (!world.context.economy.spend(player, 40, 'shop', { item: 'potion' }).ok) ...
//
// The balance lives on the character (actor.data.gold by default). Every change
// goes through here, and on a server each one is written to a transaction log,
// so an exploit can be traced and a balance rolled back. A client can never
// change gold: the server's scripts do, and these are the only calls that do it.

export class Economy {
  /**
   * options: { goldField: 'gold', sink: (transaction) => void }.
   * `sink` receives { character, kind, delta, balance, reason, meta, ts }; a server
   * passes one that writes to its store, single player passes none.
   */
  constructor(options = {}) {
    this.goldField = options.goldField || 'gold';
    this.sink = options.sink || null;
  }

  balance(player) {
    const v = player.actor.data[this.goldField];
    return Number.isFinite(v) ? v : 0;
  }

  // Amounts are whole numbers. Anything else (NaN, negative, a string from somewhere)
  // is refused, because the one thing a ledger must not do is be talked into a strange number.
  _amount(n) {
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  _commit(player, delta, kind, reason, meta) {
    const balance = this.balance(player) + delta;
    player.actor.data[this.goldField] = balance;
    if (this.sink) this.sink({ character: player.character || null, kind, delta, balance, reason, meta: meta || null, ts: Date.now() });
    return balance;
  }

  /** Give gold. Returns { ok, balance }. */
  grant(player, amount, reason = '', meta = null) {
    const n = this._amount(amount);
    if (!n) return { ok: false, reason: 'invalid-amount', balance: this.balance(player) };
    return { ok: true, balance: this._commit(player, n, 'gold', reason, meta) };
  }

  /** Take gold, only if there is enough. Returns { ok, balance } or { ok: false, reason: 'insufficient' }. */
  spend(player, amount, reason = '', meta = null) {
    const n = this._amount(amount);
    if (!n) return { ok: false, reason: 'invalid-amount', balance: this.balance(player) };
    if (this.balance(player) < n) return { ok: false, reason: 'insufficient', balance: this.balance(player) };
    return { ok: true, balance: this._commit(player, -n, 'gold', reason, meta) };
  }

  /** Move gold between two players as one step: both sides change or neither does. */
  transfer(from, to, amount, reason = 'trade', meta = null) {
    const n = this._amount(amount);
    if (!n || from === to) return { ok: false, reason: 'invalid-amount', balance: this.balance(from) };
    if (this.balance(from) < n) return { ok: false, reason: 'insufficient', balance: this.balance(from) };
    const m = { ...(meta || {}), from: from.character ? from.character.id : null, to: to.character ? to.character.id : null };
    this._commit(from, -n, 'gold', reason, m);
    this._commit(to, n, 'gold', reason, m);
    return { ok: true, balance: this.balance(from) };
  }

  /** Record something that is not gold (an item given, a quest reward) in the same log, with no balance change. */
  log(player, kind, reason = '', meta = null) {
    if (this.sink) this.sink({ character: player.character || null, kind, delta: 0, balance: this.balance(player), reason, meta: meta || null, ts: Date.now() });
  }
}
