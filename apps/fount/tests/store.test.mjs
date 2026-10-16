import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, finish } from './harness.mjs';
import { runStoreContract } from './store-contract.mjs';
import { MemoryStore, FileStore, SqliteStore, createStore } from '../server/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fount-store-'));
const dirs = [];
const dir = () => { const d = tmp(); dirs.push(d); return d; };

runStoreContract('memory', async () => new MemoryStore());

{
  let d;
  runStoreContract('file', async () => { d = dir(); return new FileStore(d); }, {
    persistent: true, reopen: async () => new FileStore(d),
    backup: async (s) => { const out = path.join(dir(), 'copy'); await s.backup(out); assert(new FileStore(out).accounts.size === 1, 'the copy opens and has the data'); },
  });
}

let hasSqlite = true;
try { await import('node:sqlite'); } catch { hasSqlite = false; }
if (hasSqlite) {
  let f;
  runStoreContract('sqlite', async () => { f = path.join(dir(), 'x.db'); return SqliteStore.open(f); }, {
    persistent: true, reopen: async () => SqliteStore.open(f),
    backup: async (s) => {
      const out = path.join(dir(), 'backup.db');
      await s.backup(out);
      const copy = await SqliteStore.open(out);
      assert((await copy.findAccount('backup')) && (await copy.findCharacterByName('Saved')).record.ok === true, 'the backup opens and has the data');
      await copy.close();
    },
  });
}

test('the default store is SQLite where the runtime has it, files where it does not', async () => {
  const s = await createStore({ path: dir() + '/data' });
  assert(s.kind === (hasSqlite ? 'sqlite' : 'file'), s.kind);
  assert(s.info().schema === 1);
  await s.close();
});

test('a file store refuses to run over a corrupt file instead of silently starting empty', async () => {
  const d = dir();
  const s = new FileStore(d);
  await s.createAccount({ name: 'A', hash: 'h' });
  fs.writeFileSync(path.join(d, 'accounts.json'), '{ not json');
  let message = '';
  try { new FileStore(d); } catch (e) { message = e.message; }
  assert(/accounts\.json/.test(message) && /backup/i.test(message), message);
});

test('a store written by a newer engine is refused rather than misread', async () => {
  const d = dir();
  new FileStore(d);
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ schema: 99, seq: {} }));
  let code = '';
  try { new FileStore(d); } catch (e) { code = e.code; }
  assert(code === 'too-new');
});

test('a custom store module is loaded by path', async () => {
  const d = dir();
  const file = path.join(d, 'custom.mjs');
  fs.writeFileSync(file, "import { MemoryStore } from '" + new URL('../server/store.mjs', import.meta.url).href + "'; export function createStore() { const s = new MemoryStore(); s.kind = 'custom'; return s; }");
  const s = await createStore({ kind: 'custom', module: file });
  assert(s.kind === 'custom');
});

await finish();
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
