import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, finish } from './harness.mjs';
import { startServer, optionsFromEnv } from '../server/mmo.mjs';
import { createStore } from '../server/store.mjs';
import { restoreBackup, listBackups } from '../server/backup.mjs';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

const root = makeGameFolder({ config: { server: { startMap: 'game/maps/arena.json' } } });
const TOKEN = 'a-long-test-admin-token-123';
let exited = 0;
const server = await startServer({
  root, port: 0, quiet: true, host: '127.0.0.1', auth: 'optional', adminToken: TOKEN, backupIntervalMinutes: 0, backupKeep: 2,
  store: { kind: 'file', path: path.join(root, 'data', 'store') }, onExit: () => { exited++; },
});
const base = `http://127.0.0.1:${server.port}`;
const admin = async (line, token = TOKEN) => {
  const res = await fetch(`${base}/admin`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ line }) });
  return { status: res.status, body: await res.json() };
};
const bots = [];
const bot = (name) => { const b = new Bot(server.port, root, { name }); bots.push(b); return b; };

const a = bot('Alice'), b = bot('Bob');
await a.join(); await b.join();

test('the admin API needs the right token, and an empty one is refused at startup', async () => {
  assert((await admin('players', 'wrong')).status === 401);
  const none = await fetch(`${base}/admin`, { method: 'POST', body: '{}' });
  assert(none.status === 401);
  let err = null;
  try { await startServer({ root, port: 0, quiet: true, host: '127.0.0.1', adminToken: 'short' }); } catch (e) { err = e; }
  assert(err && /16 characters/.test(err.message), 'a weak token is refused');
  const r = await admin('players');
  assert(r.status === 200 && r.body.ok && r.body.data.some((p) => p.name === 'Alice'));
});

test('say, mute, tp, kick and gold work through the admin API, and are audited', async () => {
  await admin('say hello everyone');
  await waitFor(() => a.chats.some((c) => c.text === '[server] hello everyone'), 2000, 'broadcast');
  const bobName = b.session.self.name;
  assert((await admin(`mute ${bobName} 30`)).body.ok);
  assert(server.social.isMuted(server.social.byName(bobName)));
  assert((await admin(`unmute ${bobName}`)).body.ok);
  assert((await admin(`tp ${bobName} 3 4`)).body.ok);
  const bp = server.social.byName(bobName).actor.controller.position;
  assert(bp[0] === 3 && bp[2] === 4);
  const g = await admin(`gold ${bobName} 50`);
  assert(g.body.ok, g.body.text);
  assert(server.manager.economy.balance(server.social.byName(bobName)) === 50);
  const bad = await admin('tp Nobody 1 1');
  assert(!bad.body.ok && /not online/.test(bad.body.text));
  const unknown = await admin('explode');
  assert(!unknown.body.ok);
  const audit = (await admin('audit 20')).body.data;
  assert(audit.some((x) => x.action === 'gold') && audit.some((x) => x.action === 'kick') === false);
  assert((await admin(`kick ${bobName} bye`)).body.ok);
  await waitFor(() => b.session.closed || b.denied.length || true, 500);
  await waitFor(() => !server.social.byName(bobName) || server.social.byName(bobName).disconnectedAt !== null, 3000, 'Bob removed');
});

test('/metrics is Prometheus text and needs the token (or localhost)', async () => {
  const res = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  assert(res.status === 200 && /^fount_players \d+/m.test(text) && /fount_tick_ms\{stat="avg"\}/.test(text) && /fount_bytes_sent_total \d+/.test(text), text.slice(0, 200));
  assert(/fount_instance_players\{instance="arena-1"/.test(text));
});

test('backups are consistent, pruned to the newest few, and restorable', async () => {
  await server.store.createAccount({ name: 'ops-test', hash: 'x' });
  const r1 = await admin('backup'); await sleep(1100);
  const r2 = await admin('backup'); await sleep(1100);
  const r3 = await admin('backup');
  assert(r1.body.ok && r2.body.ok && r3.body.ok, r3.body.text);
  const dir = path.join(root, 'data', 'backups');
  assert(listBackups(dir).length === 2, `kept the newest two (${listBackups(dir).length})`);
  const newest = listBackups(dir).at(-1).path;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'fount-restore-'));
  const placed = restoreBackup({ backup: newest, dataDir: target });
  const restored = await createStore({ kind: 'file', path: placed });
  assert(await restored.findAccount('ops-test'), 'the account is in the restored store');
  // Restoring over existing data keeps the old copy.
  restoreBackup({ backup: newest, dataDir: target });
  assert(fs.readdirSync(target).some((n) => n.includes('before-restore')), 'previous data moved aside, not deleted');
  fs.rmSync(target, { recursive: true, force: true });
});

test('a shutdown counts down, warns players, refuses new joins, and can be cancelled', async () => {
  const r = await admin('shutdown 2');
  assert(r.body.ok);
  const late = bot('Late');
  let rejected = null;
  late.session.on('reject', (m) => { rejected = m; });
  await late.session.connect().catch(() => {});
  await waitFor(() => rejected, 2000, 'new joins refused');
  assert(/restarting/.test(rejected));
  assert((await admin('cancel')).body.ok);
  assert(exited === 0, 'cancelled before it fired');
  await admin('shutdown 1');
  await waitFor(() => exited === 1, 4000, 'exit requested when the countdown ends');
});

test('settings can come from the environment', () => {
  const o = optionsFromEnv({ FOUNT_PORT: '9001', FOUNT_AUTH: 'required', FOUNT_ADMIN_TOKEN: 'x'.repeat(20), FOUNT_LOG_JSON: 'true', FOUNT_MAX_PLAYERS: '40', FOUNT_DATA: '/tmp/fount-data' });
  assert(o.port === 9001 && o.auth === 'required' && o.logJson === true && o.maxPlayers === 40 && o.adminToken.length === 20);
  assert(o.store.path.endsWith('fount-data'));
});

for (const x of bots) x.stop();
await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
