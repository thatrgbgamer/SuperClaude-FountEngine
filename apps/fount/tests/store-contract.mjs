// The conformance suite for a Store. Run it against any backend:
//
//   import { runStoreContract } from './store-contract.mjs';
//   runStoreContract('postgres', async () => createMyStore(), { persistent: true, reopen: async () => createMyStore() });
//
// A store that passes all of this works with the server. Nothing here knows
// which backend it is talking to.

import { test, assert } from './harness.mjs';

const rejects = async (fn, code) => {
  try { await fn(); } catch (err) {
    if (code && err.code !== code) throw new Error(`rejected with "${err.code}", expected "${code}": ${err.message}`);
    return;
  }
  throw new Error('expected a rejection');
};

/**
 * @param label     shown in test names
 * @param make      async () => a fresh, empty store
 * @param options   { persistent: true } if data must survive close()+reopen(); `reopen` returns the same store again;
 *                  { backup: async (store) => path } to exercise backups
 */
export function runStoreContract(label, make, options = {}) {
  const t = (name, fn) => test(`${label}: ${name}`, fn);

  t('accounts: names are unique ignoring case, and can be found and updated', async () => {
    const s = await make();
    const a = await s.createAccount({ name: 'Alice', hash: 'h1' });
    assert(a.id && a.name === 'Alice' && a.banned === false && a.created > 0);
    await rejects(() => s.createAccount({ name: 'ALICE', hash: 'h2' }), 'name-taken');
    assert((await s.findAccount('alice')).id === a.id, 'found by any case');
    assert((await s.getAccount(a.id)).name === 'Alice');
    assert(await s.findAccount('nobody') === null && await s.getAccount(999) === null);
    const u = await s.updateAccount(a.id, { lastLogin: 5, banned: true, banReason: 'test', data: { x: [1, 2] } });
    assert(u.banned === true && u.banReason === 'test' && u.data.x[1] === 2 && u.lastLogin === 5);
    assert((await s.getAccount(a.id)).banned === true, 'and it is kept');
    await s.createAccount({ name: 'Bob', hash: 'h3' });
    assert((await s.listAccounts()).length === 2 && (await s.listAccounts({ limit: 1 })).length === 1);
    await rejects(() => s.updateAccount(999, {}), 'no-such-account');
    await s.close();
  });

  t('sessions expire; magic tokens work once', async () => {
    const s = await make();
    const a = await s.createAccount({ name: 'Eve', hash: 'h' });
    await s.putSession('tok', a.id, Date.now() + 60000);
    assert((await s.getSession('tok')).accountId === a.id);
    await s.putSession('old', a.id, Date.now() - 1);
    assert(await s.getSession('old') === null, 'an expired session is not returned');
    await s.deleteSession('tok');
    assert(await s.getSession('tok') === null);
    await s.putSession('a', a.id, Date.now() + 60000); await s.putSession('b', a.id, Date.now() + 60000);
    await s.deleteSessionsFor(a.id);
    assert(await s.getSession('a') === null && await s.getSession('b') === null);
    await s.putMagic('m', a.id, Date.now() + 60000);
    assert((await s.takeMagic('m')).accountId === a.id);
    assert(await s.takeMagic('m') === null, 'second use fails');
    await s.putMagic('m2', a.id, Date.now() - 1);
    assert(await s.takeMagic('m2') === null, 'an expired one fails');
    await s.close();
  });

  t('characters: unique names, nested JSON survives, ordered by last seen', async () => {
    const s = await make();
    const a = await s.createAccount({ name: 'Owner', hash: 'h' });
    const record = { snapshot: { health: 50, data: { gold: 7, keys: { ember: true }, hotbar: ['a', 'b'] } }, position: { map: 'm', feet: [1, 2, 3] } };
    const c1 = await s.createCharacter({ accountId: a.id, name: 'Zed', class: 'mage', version: 2, record });
    const c2 = await s.createCharacter({ accountId: a.id, name: 'Yara', class: 'rogue' });
    await rejects(() => s.createCharacter({ accountId: a.id, name: 'zed' }), 'name-taken');
    const got = await s.getCharacter(c1.id);
    assert(JSON.stringify(got.record) === JSON.stringify(record) && got.class === 'mage' && got.version === 2 && got.accountId === a.id);
    assert((await s.findCharacterByName('ZED')).id === c1.id);
    await s.saveCharacter(c1.id, { record: { ...record, snapshot: { ...record.snapshot, health: 10 } }, lastSeen: 100 });
    await s.saveCharacter(c2.id, { record: {}, lastSeen: 200 });
    assert((await s.getCharacter(c1.id)).record.snapshot.health === 10);
    assert((await s.listCharacters(a.id)).map((c) => c.name).join() === 'Yara,Zed', 'most recently played first');
    await rejects(() => s.saveCharacter(999, { record: {} }), 'no-such-character');
    const other = await s.createAccount({ name: 'Other', hash: 'h' });
    assert((await s.listCharacters(other.id)).length === 0, 'characters belong to their account');
    await s.close();
  });

  t('characters: deleting frees the name and hides the record; an admin can restore it', async () => {
    const s = await make();
    const a = await s.createAccount({ name: 'O', hash: 'h' });
    const c = await s.createCharacter({ accountId: a.id, name: 'Gone', record: { v: 1 } });
    assert(await s.deleteCharacter(c.id) === true && await s.deleteCharacter(c.id) === false);
    assert(await s.getCharacter(c.id) === null && (await s.listCharacters(a.id)).length === 0 && await s.findCharacterByName('Gone') === null);
    const again = await s.createCharacter({ accountId: a.id, name: 'Gone' });
    assert(again.id !== c.id, 'the name is free to use again');
    await rejects(() => s.restoreCharacter(c.id), 'name-taken');
    await s.deleteCharacter(again.id);
    const back = await s.restoreCharacter(c.id);
    assert(back.name === 'Gone' && back.record.v === 1, 'restored with its record');
    await s.close();
  });

  t('transactions: ordered, filterable by id, limited to the latest', async () => {
    const s = await make();
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(await s.addTransaction({ characterId: 1, delta: i, balance: i * 10, reason: `r${i}`, meta: { n: i } }));
    await s.addTransaction({ characterId: 2, delta: 99, balance: 99, reason: 'other' });
    const all = await s.listTransactions(1);
    assert(all.map((x) => x.delta).join() === '1,2,3,4,5' && all[2].meta.n === 3 && all[0].reason === 'r1' && all.every((x) => x.characterId === 1));
    assert((await s.listTransactions(1, { limit: 2 })).map((x) => x.delta).join() === '4,5', 'the latest two, still in order');
    assert((await s.listTransactions(1, { sinceId: ids[2] })).map((x) => x.delta).join() === '4,5');
    assert(ids.every((id, i) => i === 0 || id > ids[i - 1]), 'ids only go up');
    await s.close();
  });

  t('audit log and free-form collections', async () => {
    const s = await make();
    await s.addAudit({ actor: 'admin', action: 'ban', detail: { who: 'x' } });
    await s.addAudit({ action: 'save' });
    const log = await s.listAudit();
    assert(log.length === 2 && log[0].action === 'ban' && log[0].actor === 'admin' && log[0].detail.who === 'x' && log[1].actor === 'server');
    await s.putRecord('guilds', 'g1', { name: 'Ash', members: [1, 2] });
    await s.putRecord('guilds', 'g2', { name: 'Bone' });
    await s.putRecord('mail', 'g1', { text: 'not a guild' });
    assert((await s.getRecord('guilds', 'g1')).members[1] === 2 && await s.getRecord('guilds', 'zz') === null && await s.getRecord('nothing', 'g1') === null);
    assert((await s.listRecords('guilds')).map((r) => r.key).join() === 'g1,g2');
    assert((await s.listRecords('guilds', { prefix: 'g2' })).length === 1 && (await s.listRecords('empty')).length === 0);
    await s.putRecord('guilds', 'g1', { name: 'Ash II' });
    assert((await s.getRecord('guilds', 'g1')).name === 'Ash II', 'overwrite');
    await s.deleteRecord('guilds', 'g1');
    assert(await s.getRecord('guilds', 'g1') === null && await s.getRecord('mail', 'g1') !== null, 'collections do not share keys');
    await s.close();
  });

  t('what comes back is a copy: changing it does not change the store', async () => {
    const s = await make();
    const a = await s.createAccount({ name: 'Copy', hash: 'h' });
    const c = await s.createCharacter({ accountId: a.id, name: 'Cp', record: { list: [1] } });
    const got = await s.getCharacter(c.id);
    got.record.list.push(2);
    assert((await s.getCharacter(c.id)).record.list.length === 1);
    await s.close();
  });

  if (options.persistent) {
    t('everything survives closing and reopening, and ids carry on without reuse', async () => {
      const s = await make();
      const a = await s.createAccount({ name: 'Keep', hash: 'hh' });
      const c = await s.createCharacter({ accountId: a.id, name: 'Kept', record: { snapshot: { data: { gold: 3 } } } });
      await s.addTransaction({ characterId: c.id, delta: 3, balance: 3, reason: 'x' });
      await s.putRecord('guilds', 'g', { n: 1 });
      await s.putSession('t', a.id, Date.now() + 60000);
      await s.close();
      const r = await options.reopen();
      assert((await r.findAccount('keep')).hash === 'hh');
      assert((await r.getCharacter(c.id)).record.snapshot.data.gold === 3);
      assert((await r.listTransactions(c.id)).length === 1 && (await r.getRecord('guilds', 'g')).n === 1 && (await r.getSession('t')).accountId === a.id);
      const a2 = await r.createAccount({ name: 'New', hash: 'h' });
      const c2 = await r.createCharacter({ accountId: a2.id, name: 'Newer' });
      assert(a2.id > a.id && c2.id > c.id, 'new rows do not reuse ids');
      await r.close();
    });
  }

  if (options.backup) {
    t('a backup can be taken while open and holds the same data', async () => {
      const s = await make();
      const a = await s.createAccount({ name: 'Backup', hash: 'h' });
      await s.createCharacter({ accountId: a.id, name: 'Saved', record: { ok: true } });
      await options.backup(s);
      await s.close();
    });
  }
}
