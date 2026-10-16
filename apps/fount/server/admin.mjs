// Running the server while it runs: one set of commands, reachable from the
// terminal the server was started in and from an authenticated HTTP endpoint.
// Every command is written to the audit log with who ran it.
//
//   help                              list the commands
//   status                            players, instances, tick time, uptime
//   players                           who is on, where
//   instances                         every running copy of every map
//   dump <instance-id>                one instance in detail
//   kick <name> [reason...]
//   ban <account> [reason...]         ban the account and kick whoever is playing it
//   unban <account>
//   mute <name> [seconds]  |  unmute <name>
//   say <text...>                     a message to everyone
//   tp <name> <x> <z>                 move within the map
//   tp <name> <map> [landmark]        send to another map
//   spawn <classname> near <name> [json]   put an entity next to a player; the JSON holds its keyvalues
//   gold <name> <amount>              grant gold through the audited economy (negative takes it)
//   give <name> <args...>             handed to the game's adminGive(player, args) hook
//   rollback-gold <characterId> <transactionId>   undo gold changes since a ledger entry
//   save                              write every character to the store now
//   backup                            take a backup now
//   audit [n]                         the last n audit entries
//   shutdown [seconds]  |  cancel     restart safely: warn, stop joins, save, exit

import { rollbackGold } from './characters.mjs';
import { makeBackup } from './backup.mjs';

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

export class AdminError extends Error {}

export class Admin {
  /**
   * deps: { manager, social, auth, store, persistence, gameData, statusFn(), log(), backupDir, backupKeep,
   *         requestExit(): called when a shutdown countdown finishes }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.shuttingDown = null;       // { at, timer }
    this.commands = {
      help: () => this.help(), status: () => this.status(), players: () => this.players(), instances: () => this.instances(),
      dump: (a) => this.dump(a), kick: (a) => this.kick(a), ban: (a) => this.ban(a), unban: (a) => this.unban(a),
      mute: (a) => this.mute(a), unmute: (a) => this.unmute(a), say: (a) => this.say(a), tp: (a) => this.tp(a),
      spawn: (a) => this.spawn(a), gold: (a) => this.gold(a), give: (a) => this.give(a), 'rollback-gold': (a) => this.rollback(a),
      save: () => this.save(), backup: () => this.backup(), audit: (a) => this.audit(a), shutdown: (a) => this.shutdown(a), cancel: () => this.cancel(),
    };
  }

  /** Run a command line. Returns { ok, text, data } and never throws. */
  async run(line, who = 'console') {
    const args = tokenize(String(line || '').trim());
    const name = (args.shift() || '').toLowerCase();
    if (!name) return { ok: true, text: '' };
    const fn = this.commands[name];
    if (!fn) return { ok: false, text: `Unknown command "${name}". Try help.` };
    try {
      const data = await fn(args);
      if (this.store && name !== 'help' && name !== 'status' && name !== 'players' && name !== 'audit') {
        await this.store.addAudit({ actor: `admin:${who}`, action: name, detail: { args } }).catch(() => {});
      }
      return { ok: true, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2), data: typeof data === 'string' ? undefined : data };
    } catch (err) {
      if (!(err instanceof AdminError)) this.log(`admin command failed: ${err.stack || err.message}`);
      return { ok: false, text: err instanceof AdminError ? err.message : `That failed: ${err.message}` };
    }
  }

  // ---- finding things --------------------------------------------------------------

  player(name) {
    if (!name) throw new AdminError('Name a player.');
    const p = this.social.byName(name);
    if (!p) throw new AdminError(`${name} is not online.`);
    return p;
  }

  num(s, what) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new AdminError(`${what} must be a number.`);
    return n;
  }

  // ---- information -----------------------------------------------------------------

  help() {
    return [
      'status | players | instances | dump <instance> | audit [n]',
      'kick <name> [reason] | ban <account> [reason] | unban <account> | mute <name> [seconds] | unmute <name>',
      'say <text> | tp <name> <x> <z> | tp <name> <map> [landmark] | spawn <class> near <name> [json]',
      'gold <name> <amount> | give <name> <args> | rollback-gold <characterId> <transactionId>',
      'save | backup | shutdown [seconds] | cancel',
    ].join('\n');
  }

  status() { return { ...this.statusFn(), shuttingDown: this.shuttingDown ? Math.max(0, Math.round((this.shuttingDown.at - Date.now()) / 1000)) : null }; }

  players() {
    const out = [];
    for (const inst of this.manager.instances.values()) {
      for (const p of inst.players) {
        const f = p.actor.feet;
        out.push({
          id: p.id, name: p.actor.name, instance: inst.id, map: inst.mapPath, x: Math.round(f[0] * 10) / 10, z: Math.round(f[2] * 10) / 10,
          hp: Math.ceil(p.actor.health), character: p.character ? p.character.id : null, online: p.disconnectedAt === null,
          party: p.partyId || null, muted: this.social.isMuted(p),
        });
      }
    }
    return out;
  }

  instances() {
    return [...this.manager.instances.values()].map((i) => ({
      id: i.id, map: i.mapPath, policy: i.policy, players: i.players.length, cap: i.cap, actors: i.actors.actors.length, tickMs: Math.round(i.lastTickMs * 100) / 100,
    }));
  }

  dump(args) {
    const inst = this.manager.instances.get(args[0]);
    if (!inst) throw new AdminError(`No instance "${args[0] || ''}". Try instances.`);
    return {
      id: inst.id, map: inst.mapPath, policy: inst.policy, cap: inst.cap, tick: inst.tickNo, lastTickMs: inst.lastTickMs, maxTickMs: inst.tickMsMax,
      pvp: inst.encounters.mode, worldState: inst.worldState,
      players: inst.players.map((p) => ({ id: p.id, name: p.actor.name, hp: p.actor.health, bytes: p.view.bytes, deferred: p.view.deferred, queue: p.queue.length, lastActions: p.actionLog.slice(-5) })),
      actors: inst.actors.actors.filter((a) => a.kind !== 'player').map((a) => ({ id: a.id, name: a.name, hp: a.health, dead: a.dead, ai: a.ai ? a.ai.state : null, at: a.feet.map((n) => Math.round(n * 10) / 10) })),
      entities: inst.world.entities.length,
    };
  }

  audit(args) {
    if (!this.store) throw new AdminError('There is no store, so there is no audit log.');
    return this.store.listAudit({ limit: Math.min(500, Number(args[0]) || 25) });
  }

  // ---- people ----------------------------------------------------------------------

  kick(args) {
    const p = this.player(args[0]);
    const reason = args.slice(1).join(' ') || 'Removed by an administrator.';
    if (p.session) p.session.kick(reason); else p.instance.removePlayer(p);
    return `Kicked ${p.actor.name}.`;
  }

  async ban(args) {
    if (!this.auth) throw new AdminError('Accounts are off, so there is nothing to ban. Kick instead.');
    const reason = args.slice(1).join(' ') || 'Banned by an administrator.';
    const account = await this.auth.ban(args[0], reason);
    let kicked = 0;
    for (const p of this.social.allPlayers()) {
      if (p.character && p.character.accountId === account.id) { if (p.session) p.session.kick(reason); else p.instance.removePlayer(p); kicked++; }
    }
    return `Banned ${account.name}${kicked ? ` and removed ${kicked} playing character${kicked > 1 ? 's' : ''}` : ''}.`;
  }

  async unban(args) {
    if (!this.auth) throw new AdminError('Accounts are off.');
    const a = await this.auth.unban(args[0]);
    return `Unbanned ${a.name}.`;
  }

  mute(args) {
    const p = this.player(args[0]);
    this.social.mute(p, args[1] ? this.num(args[1], 'Seconds') : 600);
    return `Muted ${p.actor.name}.`;
  }

  unmute(args) { const p = this.player(args[0]); this.social.unmute(p); return `Unmuted ${p.actor.name}.`; }

  say(args) {
    if (!args.length) throw new AdminError('Say what?');
    this.social.broadcast(`[server] ${args.join(' ')}`);
    return 'Sent.';
  }

  async tp(args) {
    const p = this.player(args[0]);
    if (args.length >= 3 && Number.isFinite(Number(args[1])) && Number.isFinite(Number(args[2]))) {
      const pos = p.actor.controller.position;
      pos[0] = Number(args[1]); pos[2] = Number(args[2]);
      return `Moved ${p.actor.name}.`;
    }
    if (!args[1]) throw new AdminError('tp <name> <x> <z>  or  tp <name> <map> [landmark]');
    if (!this.gameData.mapExists(args[1])) throw new AdminError(`There is no map "${args[1]}".`);
    await this.manager.requestTravel(p, args[1], args[2] || null);
    return `Sent ${p.actor.name} to ${args[1]}.`;
  }

  spawn(args) {
    const [classname, ...rest] = args;
    if (!classname) throw new AdminError('spawn <classname> <x> <z> [json]  or  spawn <classname> near <name> [json]');
    let inst, x, z, jsonAt;
    if (rest[0] === 'near') {
      const p = this.player(rest[1]);
      inst = p.instance; x = p.actor.feet[0] + 2; z = p.actor.feet[2]; jsonAt = 2;
    } else {
      throw new AdminError('Say where: spawn <classname> near <player> [json]');
    }
    let extra = {};
    if (rest[jsonAt]) { try { extra = JSON.parse(rest.slice(jsonAt).join(' ')); } catch { throw new AdminError('The keyvalues must be JSON.'); } }
    const y = inst.players.find((q) => q.actor.name === rest[1]).actor.feet[1];
    const e = inst.world.spawn({ classname, origin: [x, y, z], ...extra });
    return e ? `Spawned ${classname} in ${inst.id}.` : `Could not spawn ${classname}.`;
  }

  gold(args) {
    const p = this.player(args[0]);
    const n = Math.trunc(this.num(args[1], 'The amount'));
    if (!n) throw new AdminError('A non-zero amount, please.');
    const eco = this.manager.economy;
    const ok = n > 0 ? eco.grant(p, n, 'admin') : eco.spend(p, -n, 'admin');
    if (ok === false) throw new AdminError(`${p.actor.name} does not have that much.`);
    return `${p.actor.name} now has ${eco.balance(p)}.`;
  }

  give(args) {
    const p = this.player(args[0]);
    const r = this.gameData.callHook('adminGive', p, args.slice(1));
    if (r === undefined) throw new AdminError('This game defines no adminGive hook, so the engine does not know what an item is.');
    return typeof r === 'string' ? r : 'Done.';
  }

  async rollback(args) {
    if (!this.store) throw new AdminError('There is no ledger without a store.');
    const r = await rollbackGold({
      store: this.store, manager: this.manager, economy: this.manager.economy, characterId: Number(args[0]), sinceId: Number(args[1]),
      goldField: this.gameData.config.server?.goldField, reason: 'admin-rollback',
    });
    return r;
  }

  // ---- the server ------------------------------------------------------------------

  async save() {
    if (!this.persistence) throw new AdminError('Nothing to save: accounts are off.');
    await this.persistence.saveAll('admin');
    return 'Everyone is saved.';
  }

  async backup() {
    if (!this.store) throw new AdminError('There is nothing to back up: accounts are off.');
    const out = await makeBackup(this.store, this.backupDir, this.backupKeep);
    return `Backup written to ${out}`;
  }

  shutdown(args) {
    const seconds = args[0] === undefined ? 30 : Math.max(0, Math.min(3600, this.num(args[0], 'Seconds')));
    if (this.shuttingDown) throw new AdminError('A shutdown is already counting down. Use cancel to stop it.');
    this.shuttingDown = { at: Date.now() + seconds * 1000, timer: null };
    const warn = new Set([3600, 1800, 600, 300, 120, 60, 30, 15, 10, 5, 4, 3, 2, 1]);
    const tick = () => {
      const left = Math.round((this.shuttingDown.at - Date.now()) / 1000);
      if (left <= 0) { this.shuttingDown.timer = null; this.requestExit(); return; }
      if (warn.has(left)) this.social.broadcast(`The server is restarting in ${left >= 60 ? `${Math.round(left / 60)} minute${left >= 120 ? 's' : ''}` : `${left} second${left > 1 ? 's' : ''}`}. Your progress is saved.`);
      this.shuttingDown.timer = setTimeout(tick, 1000);
    };
    this.social.broadcast(`The server will restart in ${seconds} seconds.`);
    this.shuttingDown.timer = setTimeout(tick, 1000);
    return `Shutting down in ${seconds} seconds.`;
  }

  cancel() {
    if (!this.shuttingDown) throw new AdminError('No shutdown is pending.');
    clearTimeout(this.shuttingDown.timer);
    this.shuttingDown = null;
    this.social.broadcast('The restart was cancelled.');
    return 'Cancelled.';
  }
}
