// Characters: creating and deleting them, and keeping a playing character saved.
//
// A character record is plain JSON:
//   { snapshot: actor.snapshot(), position: { map, feet, yaw }, savedAt }
// The snapshot is the actor's own (health, resources, stats, statuses, cooldowns
// and `data`, where a game keeps its level, gold, keys and inventory), so
// anything a game stores on actor.data is saved without the engine knowing what
// it is. The engine adds only where the character is standing.

import { StoreError } from './store.mjs';

export class CharacterError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const CHARACTER_NAME_RULE = /^[A-Za-z][A-Za-z' -]{1,14}[A-Za-z]$/;

export class CharacterService {
  constructor({ store, gameData, manager, log = () => {} }) {
    Object.assign(this, { store, gameData, manager, log });
  }

  get serverConfig() { return this.gameData.config.server || {}; }
  get maxCharacters() { return this.serverConfig.maxCharacters ?? 5; }
  get currentVersion() { return this.serverConfig.characterVersion ?? 1; }

  /** Summaries for a character-select screen. A game adds its own fields with the characterSummary hook. */
  summary(c) {
    const data = (c.record && c.record.snapshot && c.record.snapshot.data) || {};
    const base = { id: c.id, name: c.name, class: c.class, level: data.level ?? 1, lastSeen: c.lastSeen, created: c.created, map: c.record && c.record.position ? c.record.position.map : null };
    const extra = this.gameData.callHook('characterSummary', c.record, c) || {};
    return { ...base, ...extra, online: !!this.manager.playerForCharacter(c.id) };
  }

  async list(account) { return (await this.store.listCharacters(account.id)).map((c) => this.summary(c)); }

  validateName(name) {
    if (typeof name !== 'string' || !CHARACTER_NAME_RULE.test(name) || /  /.test(name)) {
      throw new CharacterError('bad-name', 'Character names are 3 to 16 letters, with spaces, apostrophes and hyphens inside.');
    }
    const verdict = this.gameData.callHook('nameAllowed', name);
    if (verdict === false || typeof verdict === 'string') throw new CharacterError('name-refused', typeof verdict === 'string' ? verdict : 'That name is not allowed.');
  }

  async create(account, { name, class: cls }) {
    this.validateName(name);
    const classes = this.gameData.callHook('classes');
    if (classes && !classes.includes(cls)) throw new CharacterError('bad-class', `Choose one of: ${classes.join(', ')}.`);
    if (!classes && !(typeof cls === 'string' && cls.length <= 32)) throw new CharacterError('bad-class', 'Choose a class.');
    const existing = await this.store.listCharacters(account.id);
    if (existing.length >= this.maxCharacters) throw new CharacterError('too-many', `An account holds at most ${this.maxCharacters} characters.`);
    let c;
    try {
      c = await this.store.createCharacter({ accountId: account.id, name, class: cls, version: this.currentVersion, record: { snapshot: null, position: null } });
    } catch (err) {
      if (err instanceof StoreError && err.code === 'name-taken') throw new CharacterError('name-taken', 'That name is taken.');
      throw err;
    }
    await this.store.addAudit({ actor: `account:${account.id}`, action: 'character-create', detail: { id: c.id, name, class: cls } });
    this.gameData.callHook('characterCreated', c);
    return this.summary(c);
  }

  /** Delete a character, but only if the caller types its exact name, and never while it is in the game. */
  async remove(account, id, confirm) {
    const c = await this.store.getCharacter(id);
    if (!c || c.accountId !== account.id) throw new CharacterError('not-yours', 'That character does not exist.');
    if (String(confirm ?? '').toLowerCase() !== c.name.toLowerCase()) throw new CharacterError('not-confirmed', 'Type the character\'s name to confirm deleting it.');
    if (this.manager.playerForCharacter(c.id)) throw new CharacterError('online', 'Log that character out before deleting it.');
    await this.store.deleteCharacter(c.id);
    await this.store.addAudit({ actor: `account:${account.id}`, action: 'character-delete', detail: { id: c.id, name: c.name } });
    return true;
  }

  /**
   * The character a player is about to play, checked to be theirs and brought up
   * to date. When the game's character version has moved on, its migrateCharacter
   * hook gets the old record and returns the new one.
   */
  async forJoin(account, id) {
    const c = await this.store.getCharacter(id);
    if (!c || c.accountId !== account.id) throw new CharacterError('not-yours', 'That character does not exist on this account.');
    if (c.version < this.currentVersion) {
      const migrated = this.gameData.callHook('migrateCharacter', c.record, c.version, this.currentVersion);
      c.record = migrated || c.record;
      c.version = this.currentVersion;
      await this.store.saveCharacter(c.id, { record: c.record, version: c.version, lastSeen: c.lastSeen ?? Date.now() });
      this.log(`migrated character ${c.name} to version ${c.version}`);
    } else if (c.version > this.currentVersion) {
      throw new CharacterError('too-new', 'This character was saved by a newer version of the game than this server runs.');
    }
    return c;
  }
}

/** Keeps characters saved: on a timer, when they move between maps, when they leave, and on shutdown. */
export class Persistence {
  constructor({ store, gameData, manager, log = () => {}, intervalSeconds = 45 }) {
    Object.assign(this, { store, gameData, manager, log, intervalSeconds });
    this.chains = new Map();
    this.timer = null;
    this.saves = 0;
    this.failures = 0;
    this.off = [];
  }

  start() {
    const ev = this.manager.events;
    this.off.push(ev.on('player-left', (p) => this.save(p, 'left')));
    this.off.push(ev.on('player-joined', (p) => this.save(p, 'joined')));
    this.timer = setInterval(() => this.autosave(), 5000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    for (const off of this.off) off();
    this.off = [];
  }

  record(player) {
    const A = player.actor;
    const inst = player.instance;
    return {
      snapshot: A.snapshot(),
      // A dead character is saved where it will wake, not on its corpse.
      position: { map: inst.mapPath, feet: A.dead ? player.spawnPoint : A.feet, yaw: (Math.atan2(-A.facing[1], A.facing[0]) * 180) / Math.PI },
      savedAt: Date.now(),
    };
  }

  /** Save one player's character. Saves for the same character are done in order. */
  save(player, reason = 'autosave') {
    const ch = player.character;
    if (!ch || !player.instance) return Promise.resolve();
    const record = this.record(player);
    player.lastSavedAt = Date.now();
    const prev = this.chains.get(ch.id) || Promise.resolve();
    const next = prev.then(() => this.store.saveCharacter(ch.id, { record, version: this.gameData.config.server?.characterVersion ?? 1 }))
      .then(() => { this.saves++; })
      .catch((err) => { this.failures++; this.log(`could not save ${ch.name} (${reason}): ${err.message}`); });
    this.chains.set(ch.id, next);
    next.then(() => { if (this.chains.get(ch.id) === next) this.chains.delete(ch.id); });
    return next;
  }

  autosave() {
    const now = Date.now();
    for (const inst of this.manager.instances.values()) {
      for (const p of inst.players) {
        if (p.character && now - (p.lastSavedAt || 0) >= this.intervalSeconds * 1000) this.save(p, 'autosave');
      }
    }
  }

  /** Save everyone and wait until it is on disk: for shutdown and for backups. */
  async saveAll(reason = 'all') {
    const waits = [];
    for (const inst of this.manager.instances.values()) for (const p of inst.players) waits.push(this.save(p, reason));
    await Promise.all(waits);
    await Promise.all([...this.chains.values()]);
  }
}

/**
 * Put a character's gold back to what it was before transaction `sinceId`: for undoing a duplication
 * exploit. Works on an online character (through the economy, so it is logged) or an offline one.
 */
export async function rollbackGold({ store, manager, economy, characterId, sinceId, goldField = 'gold', reason = 'rollback' }) {
  const all = await store.listTransactions(characterId, { limit: 100000 });
  const after = all.filter((t) => t.id > sinceId && t.kind === 'gold');
  if (!after.length) return { changed: 0, balance: null };
  const net = after.reduce((n, t) => n + t.delta, 0);
  const online = manager.playerForCharacter(characterId);
  if (online) {
    const target = Math.max(0, economy.balance(online) - net);
    const delta = target - economy.balance(online);
    if (delta > 0) economy.grant(online, delta, reason, { sinceId });
    else if (delta < 0) economy.spend(online, -delta, reason, { sinceId });
    return { changed: after.length, balance: economy.balance(online), online: true };
  }
  const c = await store.getCharacter(characterId);
  if (!c) throw new CharacterError('not-found', 'No such character.');
  if (!c.record.snapshot) return { changed: 0, balance: 0, online: false };   // never played: nothing to roll back
  const data = (c.record.snapshot.data ||= {});
  const before = Number.isFinite(data[goldField]) ? data[goldField] : 0;
  data[goldField] = Math.max(0, before - net);
  await store.saveCharacter(c.id, { record: c.record });
  await store.addTransaction({ characterId, kind: 'gold', delta: data[goldField] - before, balance: data[goldField], reason, meta: { sinceId } });
  return { changed: after.length, balance: data[goldField], online: false };
}
