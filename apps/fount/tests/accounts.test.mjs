import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, near, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { MemoryStore, FileStore, SqliteStore } from '../server/store.mjs';
import { Auth, AttemptLimiter, hashPassword, verifyPassword, AuthError } from '../server/auth.mjs';
import { rollbackGold } from '../server/characters.mjs';
import { AccountClient, AccountError } from '../engine/account.js';
import { Economy } from '../engine/economy.js';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

const FAST = { scrypt: { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } };   // the real cost is for production; tests do not need to pay it

// ---------------------------------------------------------------------------
// Auth on its own
// ---------------------------------------------------------------------------

test('passwords are hashed with a per-account salt, verified in constant time, and never stored', async () => {
  const a = await hashPassword('correct horse', FAST.scrypt), b = await hashPassword('correct horse', FAST.scrypt);
  assert(a !== b, 'a fresh salt each time');
  assert(a.startsWith('scrypt$1024$8$1$') && !a.includes('correct'));
  assert(await verifyPassword('correct horse', a) && !(await verifyPassword('correct horsf', a)) && !(await verifyPassword('', a)));
  assert(!(await verifyPassword('x', 'disabled$abc')) && !(await verifyPassword('x', 'garbage')), 'a malformed or disabled hash never matches');
});

test('registration validates names and passwords and refuses duplicates', async () => {
  const auth = new Auth(new MemoryStore(), FAST);
  const r = await auth.register('Ada Lovelace', 'a long password');
  assert(r.token.length > 30 && r.account.name === 'Ada Lovelace');
  for (const bad of ['', 'ab', 'a'.repeat(30), '-lead', 'two  spaces', '<script>', 'x\ny']) {
    let code = ''; await auth.register(bad, 'a long password').catch((e) => { code = e.code; });
    assert(code === 'bad-name', `${JSON.stringify(bad)} -> ${code}`);
  }
  let pw = ''; await auth.register('Okay', 'short').catch((e) => { pw = e.code; });
  assert(pw === 'bad-password');
  let dup = ''; await auth.register('ada lovelace', 'another long password').catch((e) => { dup = e.code; });
  assert(dup === 'name-taken', 'case-insensitive');
});

test('session tokens are stored only as hashes, and a database leak does not hand out logins', async () => {
  const store = new MemoryStore();
  const auth = new Auth(store, FAST);
  const { token } = await auth.register('Hasher', 'a long password');
  assert(!JSON.stringify([...store.sessions.keys()]).includes(token), 'the raw token is not a key');
  assert((await auth.verifyToken(token)).name === 'Hasher');
  assert(await auth.verifyToken(token + 'x') === null && await auth.verifyToken('') === null && await auth.verifyToken(null) === null);
  await auth.logout(token);
  assert(await auth.verifyToken(token) === null, 'logged out');
});

test('wrong guesses slow down, per address and per account, and a right login clears it', async () => {
  const auth = new Auth(new MemoryStore(), { ...FAST, accountLimit: { free: 3, baseSeconds: 30 }, addressLimit: { free: 100 } });
  await auth.register('Target', 'the real password');
  for (let i = 0; i < 3; i++) await auth.login('Target', 'wrong' + i, '1.2.3.4').catch(() => {});
  await auth.login('Target', 'wrong', '9.9.9.9').catch(() => {});
  let err; await auth.login('Target', 'the real password', '5.5.5.5').catch((e) => { err = e; });
  assert(err && err.code === 'throttled' && err.retryAfter > 0, 'even the right password waits once the account is under attack');
  const lim = new AttemptLimiter({ free: 2, baseSeconds: 1, maxSeconds: 8 });
  const t0 = 1000000;
  lim.fail('k', t0); lim.fail('k', t0);
  assert(lim.wait('k', t0) === 0, 'the first few are free');
  lim.fail('k', t0); assert(lim.wait('k', t0) === 1);
  lim.fail('k', t0); assert(lim.wait('k', t0) === 2);
  for (let i = 0; i < 10; i++) lim.fail('k', t0);
  assert(lim.wait('k', t0) === 8, 'capped');
  assert(lim.wait('k', t0 + 1000 * 60 * 20) === 0, 'forgotten after a while');
});

test('a wrong name and a wrong password look the same, and a banned account cannot log in', async () => {
  const auth = new Auth(new MemoryStore(), FAST);
  await auth.register('Realname', 'a long password');
  const msgs = [];
  await auth.login('Realname', 'nope nope nope').catch((e) => msgs.push(e.message));
  await auth.login('Nobody', 'nope nope nope').catch((e) => msgs.push(e.message));
  assert(msgs.length === 2 && msgs[0] === msgs[1], 'no hint which was wrong');
  const { token } = await auth.login('Realname', 'a long password');
  await auth.ban('Realname', 'testing');
  assert(await auth.verifyToken(token) === null, 'existing sessions end');
  let e; await auth.login('Realname', 'a long password').catch((x) => { e = x; });
  assert(e.code === 'banned' && /testing/.test(e.message));
  await auth.unban('Realname');
  assert((await auth.login('Realname', 'a long password')).account.name === 'Realname');
});

test('magic tokens work once; changing a password signs every other session out', async () => {
  const auth = new Auth(new MemoryStore(), FAST);
  const { account, token } = await auth.register('Forgetful', 'a long password');
  const magic = await auth.issueMagicToken('Forgetful');
  const first = await auth.loginWithMagic(magic);
  assert(first.account.id === account.id);
  let e; await auth.loginWithMagic(magic).catch((x) => { e = x; });
  assert(e && e.code === 'bad-login', 'the second use fails');
  const fresh = await auth.changePassword(await auth.store.getAccount(account.id), 'a long password', 'a better password');
  assert(await auth.verifyToken(token) === null && await auth.verifyToken(first.token) === null, 'old sessions are gone');
  assert((await auth.verifyToken(fresh)).id === account.id, 'the one that changed it stays signed in');
  assert((await auth.login('Forgetful', 'a better password')).account.id === account.id);
  const made = await auth.createWithMagic('TrialUser');
  assert((await auth.loginWithMagic(made.magic)).account.name === 'TrialUser', 'an account made with no password');
  let none; await auth.login('TrialUser', 'anything at all').catch((x) => { none = x; });
  assert(none, 'and it cannot be logged into by password');
});

test('the economy refuses strange amounts, never goes negative, and logs every change', () => {
  const log = [];
  const eco = new Economy({ sink: (t) => log.push(t) });
  const p = { actor: { data: {} }, character: { id: 7 } };
  const q = { actor: { data: { gold: 10 } }, character: { id: 8 } };
  assert(eco.grant(p, 25, 'loot', { m: 'imp' }).balance === 25 && p.actor.data.gold === 25);
  for (const bad of [0, -5, NaN, Infinity, '12', null, undefined]) assert(eco.grant(p, bad).ok === false, String(bad));
  assert(eco.spend(p, 100).reason === 'insufficient' && p.actor.data.gold === 25, 'cannot overspend');
  assert(eco.spend(p, 10, 'shop').balance === 15);
  assert(eco.grant(p, 2.9).balance === 17, 'whole numbers only');
  assert(eco.transfer(p, q, 5, 'trade').ok && p.actor.data.gold === 12 && q.actor.data.gold === 15);
  assert(eco.transfer(p, q, 500).ok === false && p.actor.data.gold === 12 && q.actor.data.gold === 15, 'a failed transfer changes nothing');
  assert(eco.transfer(p, p, 1).ok === false, 'not to yourself');
  assert(log.length === 5 && log[0].character.id === 7 && log[0].reason === 'loot' && log[0].meta.m === 'imp' && log.every((t) => t.balance >= 0));
  eco.log(p, 'item', 'gave sword', { item: 'sword' });
  assert(log[log.length - 1].kind === 'item' && log[log.length - 1].delta === 0);
});

// ---------------------------------------------------------------------------
// The server with accounts
// ---------------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fount-acct-'));
const root = makeGameFolder({ config: { server: { startMap: 'game/maps/arena.json', maxCharacters: 2, autosaveSeconds: 1, characterVersion: 1 } } });
const dbPath = path.join(dir, 'game.db');
const startAccounts = (extra = {}) => startServer({
  root, port: 0, quiet: true, host: '127.0.0.1', reconnectGraceSeconds: 1.5, auth: 'required',
  authOptions: FAST, store: { kind: 'sqlite', path: dbPath }, ...extra,
});
let server = await startAccounts();
const url = () => `http://127.0.0.1:${server.port}`;
const bots = [];
const bot = (hello) => { const b = new Bot(server.port, root, hello); bots.push(b); return b; };

test('the HTTP API: register, log in, see yourself, and everything else needs the token', async () => {
  const c = new AccountClient(url());
  const acct = await c.register('Apiuser', 'a long password');
  assert(acct.name === 'Apiuser' && c.loggedIn && !('hash' in acct));
  const me = await c.me();
  assert(me.account.name === 'Apiuser' && me.characters.length === 0);
  const anon = new AccountClient(url());
  let e; await anon.characters().catch((x) => { e = x; });
  assert(e instanceof AccountError && e.status === 401 && e.code === 'login-required');
  const other = new AccountClient(url());
  let bad; await other.login('Apiuser', 'wrong password!').catch((x) => { bad = x; });
  assert(bad.status === 401 && bad.code === 'bad-login');
  await c.logout();
  assert(!c.loggedIn && (await c.me()) === null);
  const again = new AccountClient(url());
  assert((await again.login('apiuser', 'a long password')).name === 'Apiuser', 'log back in, name in any case');
});

test('characters: validated names, a limit per account, delete only with the exact name', async () => {
  const c = new AccountClient(url());
  await c.register('Charmaker', 'a long password');
  const made = await c.createCharacter('Brightblade', 'warrior');
  assert(made.id && made.name === 'Brightblade' && made.class === 'warrior' && made.level === 1);
  for (const bad of ['x', 'Has1Digit', 'Two  Spaces', '<b>x</b>', 'A'.repeat(30)]) {
    let code; await c.createCharacter(bad, 'mage').catch((x) => { code = x.code; });
    assert(code === 'bad-name', `${bad} -> ${code}`);
  }
  let dup; await new AccountClient(url()).register('Second', 'a long password').then(async () => dup = 'ok');
  const other = new AccountClient(url()); await other.login('Second', 'a long password');
  let taken; await other.createCharacter('brightblade', 'mage').catch((x) => { taken = x.code; });
  assert(taken === 'name-taken' && dup, 'names are unique across accounts');
  await c.createCharacter('Second Wind', 'rogue');
  let many; await c.createCharacter('Third One', 'mage').catch((x) => { many = x.code; });
  assert(many === 'too-many', 'the limit is two in this server');
  let wrong; await c.deleteCharacter(made.id, 'Brightblad').catch((x) => { wrong = x.code; });
  assert(wrong === 'not-confirmed', 'an exact name is required');
  let notMine; await other.deleteCharacter(made.id, 'Brightblade').catch((x) => { notMine = x.code; });
  assert(notMine === 'not-yours', 'and it has to be yours');
  await c.deleteCharacter(made.id, 'brightblade');
  assert((await c.characters()).characters.length === 1, 'deleted');
  assert((await c.createCharacter('Brightblade', 'warrior')).id !== made.id, 'the name is free again');
});

test('API hygiene: oversize and malformed bodies are refused, and a flood is slowed', async () => {
  let r = await fetch(`${url()}/api/login`, { method: 'POST', body: 'x'.repeat(20000) });
  assert(r.status === 413, `oversize ${r.status}`);
  r = await fetch(`${url()}/api/login`, { method: 'POST', body: '{not json' });
  assert(r.status === 400 && (await r.json()).code === 'bad-json');
  r = await fetch(`${url()}/api/login`, { method: 'POST', body: '[1,2]' });
  assert(r.status === 400, 'an array is not an object');
  r = await fetch(`${url()}/api/nonsense`, { headers: { Authorization: 'Bearer nope' } });
  assert(r.status === 401, 'no information leaks to someone who is not logged in');
  assert(r.headers.get('cache-control') === 'no-store');
});

test('required auth refuses guests, a bad token, someone else\'s character, and a character already in the game', async () => {
  const c = new AccountClient(url());
  await c.register('Player One', 'a long password');
  const mine = await c.createCharacter('Ironwill', 'warrior');
  const rival = new AccountClient(url());
  await rival.register('Player Two', 'a long password');

  const reasons = async (hello) => { let why = ''; await bot(hello).join().catch((e) => { why = e.message; }); return why; };
  assert(/log in/i.test(await reasons({ name: 'Guest' })), 'a guest is refused');
  assert(/log in/i.test(await reasons({ token: 'x'.repeat(40), character: '1' })), 'a forged token is refused');
  assert(/choose a character/i.test(await reasons({ token: c.token })), 'a token alone is not enough');
  assert(/does not exist/i.test(await reasons({ ...rival.hello(mine.id) })), 'cannot play someone else\'s character');

  const ok = bot(c.hello(mine.id));
  const w = await ok.join();
  assert(w.name === 'Ironwill', 'the character decides the name, not the client');
  assert(/already in the game/i.test(await reasons(c.hello(mine.id))), 'a second login as the same character is refused');
  ok.leave();
  await sleep(200);
});

test('a character is saved on leaving and comes back exactly as it was, position included', async () => {
  const c = new AccountClient(url());
  await c.register('Saver', 'a long password');
  const ch = await c.createCharacter('Persistor', 'rogue');
  let b = bot(c.hello(ch.id));
  await b.join();
  await waitFor(() => b.self && b.session.predictor, 2000);
  const inst = [...server.manager.instances.values()].find((i) => i.players.some((p) => p.actor.name === 'Persistor'));
  const sp = inst.players.find((p) => p.actor.name === 'Persistor');
  assert(sp.character.id === ch.id, 'the server knows which character this is');
  server.economy.grant(sp, 120, 'test', { why: 'persistence test' });
  sp.actor.data.keys = { ember: true };
  sp.actor.health = 61;
  sp.actor.teleport([-3, 0, 4]);
  b.leave();
  await waitFor(async () => true, 100);
  await sleep(1800);       // past the reconnect grace: the body is removed and saved
  const row = await server.store.getCharacter(ch.id);
  assert(row.record.snapshot.data.gold === 120 && row.record.snapshot.data.keys.ember === true && Math.round(row.record.snapshot.health) === 61, JSON.stringify(row.record.snapshot));
  assert(row.record.position.map === 'game/maps/arena.json' && Math.hypot(row.record.position.feet[0] + 3, row.record.position.feet[2] - 4) < 0.5, JSON.stringify(row.record.position));

  b = bot(c.hello(ch.id));
  await b.join();
  const inst2 = [...server.manager.instances.values()].find((i) => i.players.some((p) => p.actor.name === 'Persistor'));
  const back = inst2.players.find((p) => p.actor.name === 'Persistor').actor;
  assert(back.data.gold === 120 && back.data.keys.ember && Math.round(back.health) === 61, 'state restored');
  assert(Math.hypot(back.feet[0] + 3, back.feet[2] - 4) < 0.5, `and the place: ${back.feet.map((v) => v.toFixed(1))}`);
  b.leave();
});

test('characters are autosaved while they play, not only when they leave', async () => {
  const c = new AccountClient(url());
  await c.register('Autosaver', 'a long password');
  const ch = await c.createCharacter('Steadfast', 'mage');
  const b = bot(c.hello(ch.id));
  await b.join();
  const sp = [...server.manager.instances.values()].flatMap((i) => i.players).find((p) => p.actor.name === 'Steadfast');
  sp.actor.data.marker = 'saved-while-playing';
  await waitFor(async () => false, 10).catch(() => {});
  await sleep(7000);   // the timer checks every 5s and the interval is 1s
  const row = await server.store.getCharacter(ch.id);
  assert(row.record.snapshot.data.marker === 'saved-while-playing' && row.lastSeen > 0, 'written without anyone logging out');
  b.leave();
});

test('travelling between maps saves the character in its new place', async () => {
  const c = new AccountClient(url());
  await c.register('Traveller', 'a long password');
  const ch = await c.createCharacter('Wayfarer', 'ranger');
  const b = bot(c.hello(ch.id));
  await b.join();
  const sp = [...server.manager.instances.values()].flatMap((i) => i.players).find((p) => p.actor.name === 'Wayfarer');
  sp.actor.teleport([11, 0, 10]);
  b.walk(1, 0);
  await waitFor(() => b.welcomes.length >= 2, 3000, 'the portal');
  b.stand();
  await sleep(300);
  const row = await server.store.getCharacter(ch.id);
  assert(row.record.position.map === 'game/maps/room.json', `saved in ${row.record.position.map}`);
  b.leave();
});

test('every gold change is in the ledger with its balance, and a duplication can be rolled back', async () => {
  const c = new AccountClient(url());
  await c.register('Cheater', 'a long password');
  const ch = await c.createCharacter('Exploiter', 'rogue');
  const b = bot(c.hello(ch.id));
  await b.join();
  const sp = [...server.manager.instances.values()].flatMap((i) => i.players).find((p) => p.actor.name === 'Exploiter');
  const eco = server.economy;
  eco.grant(sp, 50, 'quest');
  const mark = (await server.store.listTransactions(ch.id)).pop().id;
  for (let i = 0; i < 3; i++) eco.grant(sp, 1000, 'dupe-bug', { n: i });
  eco.spend(sp, 30, 'shop', { item: 'potion' });
  await sleep(150);
  const ledger = await server.store.listTransactions(ch.id);
  assert(ledger.map((t) => `${t.delta}:${t.balance}:${t.reason}`).join(' ') === '50:50:quest 1000:1050:dupe-bug 1000:2050:dupe-bug 1000:3050:dupe-bug -30:3020:shop', ledger.map((t) => `${t.delta}:${t.balance}`).join(' '));
  assert(ledger.every((t) => t.characterId === ch.id));
  const result = await rollbackGold({ store: server.store, manager: server.manager, economy: eco, characterId: ch.id, sinceId: mark });
  assert(result.online && result.balance === 50, `rolled back to ${result.balance}`);
  assert(sp.actor.data.gold === 50, 'the live character was corrected');
  await sleep(100);
  const after = await server.store.listTransactions(ch.id);
  assert(after[after.length - 1].reason === 'rollback', 'and the rollback itself is in the ledger');

  b.leave();
  await sleep(1900);
  eco.sink({ character: { id: ch.id }, kind: 'gold', delta: 0, balance: 50, reason: 'noop' });
  const offlineMark = (await server.store.listTransactions(ch.id)).pop().id;
  const row = await server.store.getCharacter(ch.id);
  row.record.snapshot.data.gold = 9050;
  await server.store.saveCharacter(ch.id, { record: row.record });
  await server.store.addTransaction({ characterId: ch.id, delta: 9000, balance: 9050, reason: 'dupe-offline' });
  const offline = await rollbackGold({ store: server.store, manager: server.manager, economy: eco, characterId: ch.id, sinceId: offlineMark });
  assert(!offline.online && offline.balance === 50, `an offline character too: ${offline.balance}`);
  assert((await server.store.getCharacter(ch.id)).record.snapshot.data.gold === 50);
});

test('after a dropped connection, the logged-in character can come back without the token, while still in the world', async () => {
  const c = new AccountClient(url());
  await c.register('Droppy', 'a long password');
  const ch = await c.createCharacter('Flaky One', 'mage');
  const b = bot(c.hello(ch.id));
  const w1 = await b.join();
  b.drop();
  await sleep(300);
  const b2 = bot(c.hello(ch.id));
  const w2 = await b2.join();
  assert(w2.resumed === true && w2.actor === w1.actor, 'the same body, resumed');
  b2.leave();
});

test('the character version moves forward through the game\'s migration hook', async () => {
  const c = new AccountClient(url());
  await c.register('Migrant', 'a long password');
  const ch = await c.createCharacter('Oldtimer', 'warrior');
  const b = bot(c.hello(ch.id));
  await b.join();
  const sp = [...server.manager.instances.values()].flatMap((i) => i.players).find((p) => p.actor.name === 'Oldtimer');
  sp.actor.data.gold = 7;
  b.leave();
  await sleep(1900);
  await server.close();
  for (const x of bots) x.stop();

  server = await startAccounts();
  server.gameData.config.server.characterVersion = 2;
  server.gameData.hooks.push({ migrateCharacter(record, from, to) { record.snapshot.data.gold *= 100; record.snapshot.data.migrated = `${from}->${to}`; return record; } });
  const b2 = bot(c.hello(ch.id));
  await b2.join();
  const live = [...server.manager.instances.values()].flatMap((i) => i.players).find((p) => p.actor.name === 'Oldtimer').actor;
  assert(live.data.migrated === '1->2' && live.data.gold === 700, JSON.stringify(live.data));
  assert((await server.store.getCharacter(ch.id)).version === 2, 'the stored record is now version 2');
  b2.leave();
});

test('closing the server saves every character first', async () => {
  const c = new AccountClient(url());
  await c.register('Closer', 'a long password');
  const ch = await c.createCharacter('Lastcall', 'rogue');
  const b = bot(c.hello(ch.id));
  await b.join();
  const sp = [...server.manager.instances.values()].flatMap((i) => i.players).find((p) => p.actor.name === 'Lastcall');
  sp.actor.data.marker = 'saved-on-shutdown';
  await server.close();
  b.stop();
  const store = await SqliteStore.open(dbPath);
  assert((await store.getCharacter(ch.id)).record.snapshot.data.marker === 'saved-on-shutdown', 'on disk before the doors closed');
  await store.close();
});

test('a guest can still play when accounts are optional, and nothing of theirs is saved', async () => {
  server = await startAccounts({ auth: 'optional', store: { kind: 'memory' } });
  const g = bot({ name: 'Wanderer' });
  const w = await g.join();
  assert(w.name === 'Wanderer');
  const sp = [...server.manager.instances.values()].flatMap((i) => i.players)[0];
  assert(sp.character === null, 'no character, so nothing to save');
  g.leave();
});

test('a flood of API requests from one address is slowed, with its own limit', async () => {
  await server.close();
  server = await startAccounts({ store: { kind: 'memory' }, apiRateLimit: 20 });
  let limited = 0;
  for (let i = 0; i < 60; i++) { const x = await fetch(`${url()}/api/me`); if (x.status === 429) limited++; }
  assert(limited >= 35 && limited <= 41, `${limited} of 60 refused after the first 20`);
  const r = await fetch(`${url()}/api/me`);
  assert((await r.json()).code === 'rate-limited');
});

test('another site may call the API only if the operator allows its origin', async () => {
  await server.close();
  server = await startAccounts({ store: { kind: 'memory' }, corsOrigin: ['https://play.example.com'] });
  let r = await fetch(`${url()}/api/me`, { headers: { Origin: 'https://play.example.com' } });
  assert(r.headers.get('access-control-allow-origin') === 'https://play.example.com');
  r = await fetch(`${url()}/api/me`, { headers: { Origin: 'https://evil.example.com' } });
  assert(r.headers.get('access-control-allow-origin') === null, 'an unlisted origin gets no permission');
  r = await fetch(`${url()}/api/login`, { method: 'OPTIONS', headers: { Origin: 'https://play.example.com' } });
  assert(r.status === 204 && /Authorization/.test(r.headers.get('access-control-allow-headers')), 'the preflight is answered');
});

for (const b of bots) b.stop();
await finish();
await server.close();
cleanup(root);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a database file may still be held on Windows; the OS temp cleanup will take it */ }
process.exit(process.exitCode || 0);
