// Backups of the character store: taking them on a schedule, pruning old ones,
// and putting one back.
//
//   a running server:   store.backup() is consistent while the game runs (SQLite VACUUM INTO,
//                       or a copy of the file store's folder), so a backup never needs downtime.
//   restoring:          node server/mmo.mjs --restore <backup> [--data <dir>]
//                       with the server stopped. The data that was there is moved aside, never deleted.

import fs from 'node:fs';
import path from 'node:path';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

/** Take a backup into `dir`, then delete all but the newest `keep`. Returns the path written. */
export async function makeBackup(store, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true });
  const kind = store.info().kind;
  const name = `backup-${stamp()}${kind === 'sqlite' ? '.db' : ''}`;
  const out = await store.backup(path.join(dir, name));
  prune(dir, keep);
  return out;
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith('backup-')).sort().map((n) => {
    const full = path.join(dir, n);
    return { name: n, path: full, bytes: fs.statSync(full).isDirectory() ? null : fs.statSync(full).size };
  });
}

function prune(dir, keep) {
  const all = listBackups(dir);
  for (const b of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(b.path, { recursive: true, force: true });
}

/** Put a backup in place as the live store. The server must not be running. Returns where it went. */
export function restoreBackup({ backup, dataDir }) {
  const src = path.resolve(backup);
  if (!fs.existsSync(src)) throw new Error(`There is no backup at ${src}.`);
  const isDir = fs.statSync(src).isDirectory();
  const target = isDir ? path.join(dataDir, 'store') : path.join(dataDir, 'fount.db');
  fs.mkdirSync(dataDir, { recursive: true });
  const suffix = `.before-restore-${stamp()}`;
  for (const extra of isDir ? [''] : ['', '-wal', '-shm']) {
    const old = target + extra;
    if (fs.existsSync(old)) fs.renameSync(old, old + suffix);
  }
  if (isDir) fs.cpSync(src, target, { recursive: true }); else fs.copyFileSync(src, target);
  return target;
}
