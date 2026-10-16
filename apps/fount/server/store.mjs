// Where accounts and characters live.
//
// A Store is a small async interface; the server never touches storage any
// other way, so any backend that implements it will do. Three come with the
// engine and need nothing installed:
//
//   sqlite  node:sqlite (Node 22.5+). One file, transactional, the default.
//   file    JSON files with atomic writes. Works on any Node; fine for a small
//           server, not for thousands of characters.
//   memory  Nothing is kept. For tests and throwaway servers.
//
// For Postgres (or anything else), write a module that exports
// `createStore(options)` returning an object with the methods below, and pass
// { kind: 'custom', module: './my-store.mjs' }. tests/store-contract.mjs is the
// conformance suite: if your store passes it, the server will work with it.
//
// Beyond the fixed tables (accounts, sessions, characters, transactions, audit)
// there are free-form `collections`: a game keeps banks, guilds, mail or
// anything else it invents as JSON records there, with no engine involvement.

import fs from 'node:fs';
import path from 'node:path';

export const STORE_SCHEMA = 1;

export class StoreError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const now = () => Date.now();
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const lower = (s) => String(s).toLowerCase();

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.accounts = new Map();
    this.sessions = new Map();
    this.magic = new Map();
    this.characters = new Map();
    this.transactions = [];
    this.auditLog = [];
    this.collections = new Map();
    this.seq = { account: 0, character: 0, transaction: 0, audit: 0 };
  }

  // Subclasses that persist override these: they are called after each change.
  _dirty() {}

  // ---- accounts -------------------------------------------------------------

  async createAccount({ name, hash }) {
    for (const a of this.accounts.values()) if (lower(a.name) === lower(name)) throw new StoreError('name-taken', `The account name "${name}" is taken.`);
    const account = { id: ++this.seq.account, name, hash, created: now(), lastLogin: null, banned: false, banReason: null, data: {} };
    this.accounts.set(account.id, account);
    this._dirty('accounts');
    return clone(account);
  }

  async findAccount(name) {
    for (const a of this.accounts.values()) if (lower(a.name) === lower(name)) return clone(a);
    return null;
  }

  async getAccount(id) { return clone(this.accounts.get(Number(id))) || null; }

  async updateAccount(id, patch) {
    const a = this.accounts.get(Number(id));
    if (!a) throw new StoreError('no-such-account');
    for (const k of ['hash', 'lastLogin', 'banned', 'banReason', 'data']) if (patch[k] !== undefined) a[k] = clone(patch[k]);
    this._dirty('accounts');
    return clone(a);
  }

  async listAccounts({ limit = 100, offset = 0 } = {}) {
    return [...this.accounts.values()].slice(offset, offset + limit).map(clone);
  }

  // ---- sessions and magic tokens ---------------------------------------------------

  async putSession(tokenHash, accountId, expires) { this.sessions.set(tokenHash, { accountId: Number(accountId), expires }); this._dirty('sessions'); }

  async getSession(tokenHash) {
    const s = this.sessions.get(tokenHash);
    if (!s) return null;
    if (s.expires <= now()) { this.sessions.delete(tokenHash); this._dirty('sessions'); return null; }
    return clone(s);
  }

  async deleteSession(tokenHash) { if (this.sessions.delete(tokenHash)) this._dirty('sessions'); }

  async deleteSessionsFor(accountId) {
    for (const [k, s] of this.sessions) if (s.accountId === Number(accountId)) this.sessions.delete(k);
    this._dirty('sessions');
  }

  async putMagic(tokenHash, accountId, expires) { this.magic.set(tokenHash, { accountId: Number(accountId), expires }); this._dirty('sessions'); }

  /** One use only: a magic token is gone the moment it is taken. */
  async takeMagic(tokenHash) {
    const m = this.magic.get(tokenHash);
    if (!m) return null;
    this.magic.delete(tokenHash);
    this._dirty('sessions');
    return m.expires > now() ? clone(m) : null;
  }

  // ---- characters --------------------------------------------------------------------

  async createCharacter({ accountId, name, class: cls, version = 1, record = {} }) {
    for (const c of this.characters.values()) if (!c.deleted && lower(c.name) === lower(name)) throw new StoreError('name-taken', `The name "${name}" is taken.`);
    const c = { id: ++this.seq.character, accountId: Number(accountId), name, class: cls || '', version, created: now(), lastSeen: null, deleted: false, record: clone(record) };
    this.characters.set(c.id, c);
    this._dirty('character', c.id);
    return clone(c);
  }

  async getCharacter(id) {
    const c = this.characters.get(Number(id));
    return c && !c.deleted ? clone(c) : null;
  }

  async findCharacterByName(name) {
    for (const c of this.characters.values()) if (!c.deleted && lower(c.name) === lower(name)) return clone(c);
    return null;
  }

  async listCharacters(accountId) {
    return [...this.characters.values()].filter((c) => !c.deleted && c.accountId === Number(accountId))
      .sort((a, b) => (b.lastSeen ?? b.created) - (a.lastSeen ?? a.created)).map(clone);
  }

  async saveCharacter(id, { record, class: cls, version, lastSeen }) {
    const c = this.characters.get(Number(id));
    if (!c || c.deleted) throw new StoreError('no-such-character');
    if (record !== undefined) c.record = clone(record);
    if (cls !== undefined) c.class = cls;
    if (version !== undefined) c.version = version;
    c.lastSeen = lastSeen ?? now();
    this._dirty('character', c.id);
  }

  /** A deletion keeps the record (an admin can restore it) but frees the name. */
  async deleteCharacter(id) {
    const c = this.characters.get(Number(id));
    if (!c || c.deleted) return false;
    c.deleted = true;
    c.deletedName = c.name;
    c.name = `${c.name}~deleted~${c.id}`;
    this._dirty('character', c.id);
    return true;
  }

  async restoreCharacter(id) {
    const c = this.characters.get(Number(id));
    if (!c || !c.deleted) return null;
    for (const o of this.characters.values()) if (!o.deleted && lower(o.name) === lower(c.deletedName)) throw new StoreError('name-taken', `The name "${c.deletedName}" has been taken since.`);
    c.deleted = false;
    c.name = c.deletedName;
    delete c.deletedName;
    this._dirty('character', c.id);
    return clone(c);
  }

  // ---- ledger and audit ---------------------------------------------------------------

  async addTransaction({ characterId, kind = 'gold', delta, balance, reason = '', meta = null, ts = now() }) {
    const t = { id: ++this.seq.transaction, characterId: Number(characterId), ts, kind, delta, balance, reason, meta: clone(meta) };
    this.transactions.push(t);
    this._dirty('transaction', t);
    return t.id;
  }

  async listTransactions(characterId, { limit = 200, sinceId = 0 } = {}) {
    const out = this.transactions.filter((t) => t.characterId === Number(characterId) && t.id > sinceId);
    return out.slice(-limit).map(clone);
  }

  async addAudit({ actor = 'server', action, detail = null }) {
    const e = { id: ++this.seq.audit, ts: now(), actor, action, detail: clone(detail) };
    this.auditLog.push(e);
    this._dirty('audit', e);
    return e.id;
  }

  async listAudit({ limit = 200 } = {}) { return this.auditLog.slice(-limit).map(clone); }

  // ---- free-form collections ----------------------------------------------------------

  async getRecord(collection, key) {
    const c = this.collections.get(collection);
    return c && c.has(key) ? clone(c.get(key)) : null;
  }

  async putRecord(collection, key, value) {
    if (!this.collections.has(collection)) this.collections.set(collection, new Map());
    this.collections.get(collection).set(key, clone(value));
    this._dirty('collection', collection);
  }

  async deleteRecord(collection, key) {
    const c = this.collections.get(collection);
    if (c && c.delete(key)) this._dirty('collection', collection);
  }

  async listRecords(collection, { prefix = '', limit = 1000 } = {}) {
    const c = this.collections.get(collection);
    if (!c) return [];
    return [...c.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([key, value]) => ({ key, value: clone(value) }));
  }

  // ---- maintenance ---------------------------------------------------------------------

  async backup() { throw new StoreError('unsupported', 'A memory store has nothing to back up.'); }
  async close() {}
  info() { return { kind: this.kind, schema: STORE_SCHEMA }; }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** MemoryStore plus JSON files on disk: whole files rewritten atomically, ledgers appended. */
export class FileStore extends MemoryStore {
  constructor(dir) {
    super();
    this.kind = 'file';
    this.dir = path.resolve(dir);
    fs.mkdirSync(path.join(this.dir, 'characters'), { recursive: true });
    this.pending = new Set();
    this.load();
  }

  p(...parts) { return path.join(this.dir, ...parts); }

  readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(this.p(file), 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw new StoreError('corrupt', `Could not read ${file} in ${this.dir}: ${err.message}. Restore it from a backup.`);
    }
  }

  readLines(file) {
    try {
      return fs.readFileSync(this.p(file), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  }

  load() {
    const meta = this.readJson('meta.json', { schema: STORE_SCHEMA, seq: this.seq });
    if (meta.schema > STORE_SCHEMA) throw new StoreError('too-new', `This store was written by a newer engine (schema ${meta.schema}).`);
    this.seq = { ...this.seq, ...meta.seq };
    for (const a of this.readJson('accounts.json', [])) this.accounts.set(a.id, a);
    const sess = this.readJson('sessions.json', { sessions: [], magic: [] });
    for (const [k, v] of sess.sessions) this.sessions.set(k, v);
    for (const [k, v] of sess.magic) this.magic.set(k, v);
    for (const f of fs.readdirSync(this.p('characters'))) {
      if (!f.endsWith('.json')) continue;
      const c = JSON.parse(fs.readFileSync(this.p('characters', f), 'utf8'));
      this.characters.set(c.id, c);
    }
    this.transactions = this.readLines('transactions.jsonl');
    this.auditLog = this.readLines('audit.jsonl');
    for (const f of fs.existsSync(this.p('collections')) ? fs.readdirSync(this.p('collections')) : []) {
      if (!f.endsWith('.json')) continue;
      this.collections.set(decodeURIComponent(f.slice(0, -5)), new Map(Object.entries(JSON.parse(fs.readFileSync(this.p('collections', f), 'utf8')))));
    }
  }

  _dirty(kind, ref) {
    // Written synchronously: a crash then loses at most the change in flight, never half of a file.
    try {
      if (kind === 'accounts') writeAtomic(this.p('accounts.json'), JSON.stringify([...this.accounts.values()]));
      else if (kind === 'sessions') writeAtomic(this.p('sessions.json'), JSON.stringify({ sessions: [...this.sessions], magic: [...this.magic] }));
      else if (kind === 'character') writeAtomic(this.p('characters', `${ref}.json`), JSON.stringify(this.characters.get(ref)));
      else if (kind === 'transaction') fs.appendFileSync(this.p('transactions.jsonl'), JSON.stringify(ref) + '\n');
      else if (kind === 'audit') fs.appendFileSync(this.p('audit.jsonl'), JSON.stringify(ref) + '\n');
      else if (kind === 'collection') {
        fs.mkdirSync(this.p('collections'), { recursive: true });
        writeAtomic(this.p('collections', `${encodeURIComponent(ref)}.json`), JSON.stringify(Object.fromEntries(this.collections.get(ref) || [])));
      }
      writeAtomic(this.p('meta.json'), JSON.stringify({ schema: STORE_SCHEMA, seq: this.seq }));
    } catch (err) {
      throw new StoreError('write-failed', `Could not write to ${this.dir}: ${err.message}`);
    }
  }

  async backup(dest) {
    fs.cpSync(this.dir, path.resolve(dest), { recursive: true });
    return path.resolve(dest);
  }

  info() { return { kind: 'file', path: this.dir, schema: STORE_SCHEMA, characters: this.characters.size, accounts: this.accounts.size }; }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

const SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, hash TEXT NOT NULL,
  created INTEGER, last_login INTEGER, banned INTEGER DEFAULT 0, ban_reason TEXT, data TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS magic (token_hash TEXT PRIMARY KEY, account_id INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, name TEXT NOT NULL COLLATE NOCASE, deleted_name TEXT,
  class TEXT, version INTEGER, created INTEGER, last_seen INTEGER, deleted INTEGER DEFAULT 0, record TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS characters_name ON characters(name) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS characters_account ON characters(account_id);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, character_id INTEGER, ts INTEGER, kind TEXT, delta REAL, balance REAL, reason TEXT, meta TEXT);
CREATE INDEX IF NOT EXISTS transactions_character ON transactions(character_id, id);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS collections (collection TEXT, key TEXT, value TEXT, PRIMARY KEY (collection, key));
`;

const j = (v) => JSON.stringify(v ?? null);
const unj = (s) => (s === null || s === undefined ? null : JSON.parse(s));

export class SqliteStore {
  constructor(db, file) {
    this.kind = 'sqlite';
    this.db = db;
    this.file = file;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.exec(SQL);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    const have = row ? Number(row.value) : 0;
    if (have > STORE_SCHEMA) throw new StoreError('too-new', `This database was written by a newer engine (schema ${have}).`);
    // Migrations go here, one `if (have < n)` block per schema version.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(STORE_SCHEMA));
  }

  static async open(file) {
    let sqlite;
    try { sqlite = await import('node:sqlite'); } catch { throw new StoreError('no-sqlite', 'node:sqlite is not available in this Node (it needs 22.5 or newer). Use the "file" store instead.'); }
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    return new SqliteStore(new sqlite.DatabaseSync(file), file);
  }

  q(sql) { return this.db.prepare(sql); }

  wrap(fn) {
    try { return fn(); } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new StoreError('name-taken', 'That name is taken.');
      throw err;
    }
  }

  account(r) { return r ? { id: r.id, name: r.name, hash: r.hash, created: r.created, lastLogin: r.last_login, banned: !!r.banned, banReason: r.ban_reason, data: unj(r.data) || {} } : null; }
  character(r) { return r ? { id: r.id, accountId: r.account_id, name: r.name, class: r.class, version: r.version, created: r.created, lastSeen: r.last_seen, deleted: !!r.deleted, record: unj(r.record) || {} } : null; }

  async createAccount({ name, hash }) {
    const exists = this.q('SELECT 1 FROM accounts WHERE name = ?').get(name);
    if (exists) throw new StoreError('name-taken', `The account name "${name}" is taken.`);
    const r = this.wrap(() => this.q('INSERT INTO accounts (name, hash, created) VALUES (?, ?, ?)').run(name, hash, now()));
    return this.account(this.q('SELECT * FROM accounts WHERE id = ?').get(Number(r.lastInsertRowid)));
  }

  async findAccount(name) { return this.account(this.q('SELECT * FROM accounts WHERE name = ?').get(name)); }
  async getAccount(id) { return this.account(this.q('SELECT * FROM accounts WHERE id = ?').get(Number(id))); }

  async updateAccount(id, patch) {
    const a = await this.getAccount(id);
    if (!a) throw new StoreError('no-such-account');
    const n = { ...a, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && ['hash', 'lastLogin', 'banned', 'banReason', 'data'].includes(k))) };
    this.q('UPDATE accounts SET hash = ?, last_login = ?, banned = ?, ban_reason = ?, data = ? WHERE id = ?')
      .run(n.hash, n.lastLogin ?? null, n.banned ? 1 : 0, n.banReason ?? null, j(n.data), Number(id));
    return n;
  }

  async listAccounts({ limit = 100, offset = 0 } = {}) { return this.q('SELECT * FROM accounts ORDER BY id LIMIT ? OFFSET ?').all(limit, offset).map((r) => this.account(r)); }

  async putSession(h, accountId, expires) { this.q('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(h, Number(accountId), expires); }
  async getSession(h) {
    const r = this.q('SELECT * FROM sessions WHERE token_hash = ?').get(h);
    if (!r) return null;
    if (r.expires <= now()) { await this.deleteSession(h); return null; }
    return { accountId: r.account_id, expires: r.expires };
  }
  async deleteSession(h) { this.q('DELETE FROM sessions WHERE token_hash = ?').run(h); }
  async deleteSessionsFor(accountId) { this.q('DELETE FROM sessions WHERE account_id = ?').run(Number(accountId)); }
  async putMagic(h, accountId, expires) { this.q('INSERT OR REPLACE INTO magic VALUES (?, ?, ?)').run(h, Number(accountId), expires); }
  async takeMagic(h) {
    const r = this.q('SELECT * FROM magic WHERE token_hash = ?').get(h);
    if (!r) return null;
    this.q('DELETE FROM magic WHERE token_hash = ?').run(h);
    return r.expires > now() ? { accountId: r.account_id, expires: r.expires } : null;
  }

  async createCharacter({ accountId, name, class: cls, version = 1, record = {} }) {
    const taken = this.q('SELECT 1 FROM characters WHERE name = ? AND deleted = 0').get(name);
    if (taken) throw new StoreError('name-taken', `The name "${name}" is taken.`);
    const r = this.wrap(() => this.q('INSERT INTO characters (account_id, name, class, version, created, record) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Number(accountId), name, cls || '', version, now(), j(record)));
    return this.character(this.q('SELECT * FROM characters WHERE id = ?').get(Number(r.lastInsertRowid)));
  }

  async getCharacter(id) { return this.character(this.q('SELECT * FROM characters WHERE id = ? AND deleted = 0').get(Number(id))); }
  async findCharacterByName(name) { return this.character(this.q('SELECT * FROM characters WHERE name = ? AND deleted = 0').get(name)); }
  async listCharacters(accountId) {
    return this.q('SELECT * FROM characters WHERE account_id = ? AND deleted = 0 ORDER BY COALESCE(last_seen, created) DESC').all(Number(accountId)).map((r) => this.character(r));
  }
  async saveCharacter(id, { record, class: cls, version, lastSeen }) {
    const c = await this.getCharacter(id);
    if (!c) throw new StoreError('no-such-character');
    this.q('UPDATE characters SET record = ?, class = ?, version = ?, last_seen = ? WHERE id = ?')
      .run(j(record !== undefined ? record : c.record), cls ?? c.class, version ?? c.version, lastSeen ?? now(), Number(id));
  }
  async deleteCharacter(id) {
    const c = await this.getCharacter(id);
    if (!c) return false;
    this.q('UPDATE characters SET deleted = 1, deleted_name = name, name = ? WHERE id = ?').run(`${c.name}~deleted~${c.id}`, Number(id));
    return true;
  }
  async restoreCharacter(id) {
    const r = this.q('SELECT * FROM characters WHERE id = ? AND deleted = 1').get(Number(id));
    if (!r) return null;
    if (this.q('SELECT 1 FROM characters WHERE name = ? AND deleted = 0').get(r.deleted_name)) throw new StoreError('name-taken', `The name "${r.deleted_name}" has been taken since.`);
    this.q('UPDATE characters SET deleted = 0, name = deleted_name, deleted_name = NULL WHERE id = ?').run(Number(id));
    return this.getCharacter(id);
  }

  async addTransaction({ characterId, kind = 'gold', delta, balance, reason = '', meta = null, ts = now() }) {
    return Number(this.q('INSERT INTO transactions (character_id, ts, kind, delta, balance, reason, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Number(characterId), ts, kind, delta, balance, reason, j(meta)).lastInsertRowid);
  }
  async listTransactions(characterId, { limit = 200, sinceId = 0 } = {}) {
    return this.q('SELECT * FROM (SELECT * FROM transactions WHERE character_id = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(Number(characterId), sinceId, limit).map((r) => ({ id: r.id, characterId: r.character_id, ts: r.ts, kind: r.kind, delta: r.delta, balance: r.balance, reason: r.reason, meta: unj(r.meta) }));
  }
  async addAudit({ actor = 'server', action, detail = null }) {
    return Number(this.q('INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(now(), actor, action, j(detail)).lastInsertRowid);
  }
  async listAudit({ limit = 200 } = {}) {
    return this.q('SELECT * FROM (SELECT * FROM audit ORDER BY id DESC LIMIT ?) ORDER BY id').all(limit).map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, detail: unj(r.detail) }));
  }

  async getRecord(collection, key) { const r = this.q('SELECT value FROM collections WHERE collection = ? AND key = ?').get(collection, key); return r ? unj(r.value) : null; }
  async putRecord(collection, key, value) { this.q('INSERT OR REPLACE INTO collections VALUES (?, ?, ?)').run(collection, key, j(value)); }
  async deleteRecord(collection, key) { this.q('DELETE FROM collections WHERE collection = ? AND key = ?').run(collection, key); }
  async listRecords(collection, { prefix = '', limit = 1000 } = {}) {
    return this.q("SELECT key, value FROM collections WHERE collection = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?")
      .all(collection, prefix.length, prefix, limit).map((r) => ({ key: r.key, value: unj(r.value) }));
  }

  /** A consistent copy of the whole database, safe to take while the server runs. */
  async backup(dest) {
    const out = path.resolve(dest);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (fs.existsSync(out)) fs.rmSync(out);
    this.db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    return out;
  }

  async close() { try { this.db.close(); } catch { /* already closed */ } }
  info() { return { kind: 'sqlite', path: this.file, schema: STORE_SCHEMA, characters: this.q('SELECT COUNT(*) n FROM characters WHERE deleted = 0').get().n, accounts: this.q('SELECT COUNT(*) n FROM accounts').get().n }; }
}

// ---------------------------------------------------------------------------

/**
 * options: { kind: 'auto' | 'sqlite' | 'file' | 'memory' | 'custom', path, module }
 * `auto` is SQLite where this Node has it, JSON files where it does not.
 */
export async function createStore(options = {}) {
  const kind = options.kind || 'auto';
  const dir = options.path || path.join(process.cwd(), 'data');
  if (kind === 'memory') return new MemoryStore();
  if (kind === 'custom') {
    const mod = await import(path.isAbsolute(options.module) ? new URL(`file://${options.module}`).href : options.module);
    return mod.createStore(options);
  }
  if (kind === 'file') return new FileStore(options.path || path.join(dir, 'store'));
  if (kind === 'sqlite') return SqliteStore.open(options.path || path.join(dir, 'fount.db'));
  try { return await SqliteStore.open(options.path || path.join(dir, 'fount.db')); } catch (err) {
    if (err.code !== 'no-sqlite') throw err;
    return new FileStore(path.join(dir, 'store'));
  }
}
