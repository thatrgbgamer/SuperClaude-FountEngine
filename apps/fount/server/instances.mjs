// Many instances in one process. The manager decides which copy of a map a
// player lands in, creates copies on demand, ticks them all, moves players
// between them through portals, keeps a dropped player's body around for a
// grace period so a reconnect returns them to the same place, and tears down
// copies nobody is using.
//
// A map chooses its policy in its own JSON:
//
//   "instance": { "policy": "shared", "cap": 30, "fill": "fullest", "idleTimeout": 60 }
//
//   shared  everyone shares copies of up to `cap` players; a full copy overflows into a new one.
//           `fill: "fullest"` (default) packs players together so populated copies stay lively;
//           `"emptiest"` spreads them out, which is what a hub wants.
//   static  like shared, spread by lowest population, and a copy is never torn down.
//   party   one private copy per party (a player with no party is a party of one).
//   solo    one private copy per player.

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Instance } from './instance.mjs';
import { ClientView } from './replication.mjs';
import { COMMAND_HZ } from '../engine/protocol.js';

export class InstanceManager {
  constructor({ gameData, options = {}, log = console.log }) {
    this.gameData = gameData;
    this.log = log;
    this.options = {
      defaultCap: 30,
      idleTimeoutSeconds: 60,
      reconnectGraceSeconds: 20,
      ...options,
    };
    this.startedAt = Date.now();
    this.worldEpoch = options.worldEpoch ?? this.startedAt;
    this.instances = new Map();
    this.counter = 0;
    this.lingering = new Map();     // resume token -> player whose connection dropped
    this.chain = Promise.resolve();
    this.tickCount = 0;
    this.stats = { tickMsLast: 0, tickMsMax: 0, tickMsAvg: 0 };
  }

  nowMs() { return Date.now() - this.startedAt; }
  worldTime() { return (Date.now() - this.worldEpoch) / 1000; }

  /** Run joins and moves one at a time, so two players asking for "a copy with room" never both get the last slot. */
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---- choosing and creating an instance ---------------------------------------

  async policyOf(mapPath) {
    const entry = await this.gameData.map(mapPath);
    const inst = entry.config.instance || {};
    return {
      policy: inst.policy || 'shared',
      cap: inst.cap || this.options.defaultCap,
      fill: inst.fill || (inst.policy === 'static' ? 'emptiest' : 'fullest'),
      idleTimeout: (inst.idleTimeout ?? this.options.idleTimeoutSeconds),
    };
  }

  /** Find or create the copy of `mapPath` that `ctx` ({ playerId, partyId }) should join. */
  async instanceFor(mapPath, ctx = {}) {
    const p = await this.policyOf(mapPath);
    const live = [...this.instances.values()].filter((i) => i.mapPath === mapPath && !i.closed);

    if (p.policy === 'solo') {
      const own = live.find((i) => i.ownerId === ctx.playerId);
      return own || this.create(mapPath, { ...p, ownerId: ctx.playerId });
    }
    if (p.policy === 'party') {
      const key = ctx.partyId || `solo:${ctx.playerId}`;
      const own = live.find((i) => i.partyId === key);
      return own || this.create(mapPath, { ...p, partyId: key });
    }
    // shared and static
    const open = live.filter((i) => i.policy === p.policy && i.players.length < i.cap);
    if (open.length) {
      open.sort((a, b) => (p.fill === 'emptiest' ? a.players.length - b.players.length : b.players.length - a.players.length));
      return open[0];
    }
    return this.create(mapPath, p);
  }

  async create(mapPath, p) {
    const id = `${mapPath.replace(/^.*\//, '').replace(/\.json$/, '')}-${++this.counter}`;
    const inst = await Instance.create(this, {
      id, mapPath, policy: p.policy, cap: p.cap, partyId: p.partyId, ownerId: p.ownerId,
      interest: this.options.interest,
    });
    inst.idleTimeout = p.idleTimeout;
    this.instances.set(id, inst);
    this.log(`instance ${id} created (${p.policy}, cap ${p.cap})`);
    return inst;
  }

  // ---- joining, travelling, leaving ------------------------------------------------

  /**
   * Put a session's player into the right copy of a map and send them the welcome.
   * params: { mapPath, landmark, carry, config, partyId }
   */
  join(session, params) {
    return this.serial(async () => {
      const inst = await this.instanceFor(params.mapPath, { playerId: session.playerId, partyId: params.partyId });
      const player = inst.addPlayer({ session, id: session.playerId, config: params.config, landmark: params.landmark, carry: params.carry });
      player.resumeToken = crypto.randomBytes(16).toString('hex');
      session.player = player;
      session.instance = inst;
      const welcome = inst.welcome(player);
      welcome.resume = player.resumeToken;
      session.send(welcome);
      return player;
    });
  }

  /**
   * A portal: move a player to another map. Their character is serialised, they leave
   * this copy, and join the right copy of the destination, arriving at `landmark`.
   */
  requestTravel(player, mapPath, landmark) {
    if (player.traveling) return Promise.resolve(null);
    if (!this.gameData.mapExists(mapPath)) {
      player.notify('toast', { text: 'THE WAY IS BLOCKED', color: [1, 0.5, 0.4] });
      this.log(`travel refused: no map "${mapPath}"`);
      return Promise.resolve(null);
    }
    player.traveling = true;
    return this.serial(async () => {
      const session = player.session;
      const from = player.instance;
      try {
        const carry = player.actor.snapshot();
        const config = player.config;
        const partyId = player.partyId || null;
        const inst = await this.instanceFor(mapPath, { playerId: player.id, partyId });
        from.removePlayer(player);
        if (session) session.send({ t: 'travel', map: mapPath, instance: inst.id, landmark: landmark || null });
        const next = inst.addPlayer({ session, id: player.id, config, landmark, carry });
        next.resumeToken = player.resumeToken;
        next.partyId = partyId;
        next.config = config;
        if (session) {
          session.player = next;
          session.instance = inst;
          const w = inst.welcome(next);
          w.resume = next.resumeToken;
          session.send(w);
        }
        if (player.lingerKey) { this.lingering.set(player.lingerKey, next); }
        this.log(`${player.actor.name} -> ${inst.id}`);
        return next;
      } catch (err) {
        player.traveling = false;
        this.log(`travel failed for ${player.actor.name}: ${err.message}`);
        player.notify('toast', { text: 'THE WAY IS BLOCKED', color: [1, 0.5, 0.4] });
        return null;
      }
    });
  }

  /** A connection dropped. Keep the player in the world for a grace period so they can reconnect. */
  disconnect(session) {
    const player = session.player;
    if (!player || !player.instance) return;
    const inst = player.instance;
    if (this.options.reconnectGraceSeconds <= 0) { inst.removePlayer(player); return; }
    player.session = null;
    player.disconnectedAt = Date.now();
    player.actor.intent.move = [0, 0];
    player.queue.length = 0;
    player.lingerKey = player.resumeToken;
    this.lingering.set(player.resumeToken, player);
  }

  /** A hello carrying a resume token: reattach the new connection to the player who was dropped, if still here. */
  resume(session, token) {
    const player = this.lingering.get(token);
    if (!player || player.disconnectedAt === null || !player.instance || player.instance.closed) return null;
    this.lingering.delete(token);
    player.session = session;
    player.disconnectedAt = null;
    player.view = new ClientView();      // the client has forgotten everything: send it all again
    session.player = player;
    session.instance = player.instance;
    const welcome = player.instance.welcome(player);
    welcome.resume = token;
    welcome.resumed = true;
    session.send(welcome);
    return player;
  }

  // ---- the loop -------------------------------------------------------------------

  tickAll() {
    const t0 = performance.now();
    this.tickCount++;
    for (const inst of this.instances.values()) {
      try { inst.tick(); } catch (err) { this.log(`instance ${inst.id} tick failed: ${err.stack || err.message}`); }
    }
    const now = Date.now();
    // Drop the bodies of players who never came back.
    for (const [token, player] of this.lingering) {
      if (player.disconnectedAt !== null && now - player.disconnectedAt > this.options.reconnectGraceSeconds * 1000) {
        if (player.instance) player.instance.removePlayer(player);
        this.lingering.delete(token);
        this.log(`${player.actor.name} timed out`);
      }
    }
    // Tear down copies nobody has used for a while.
    if (this.tickCount % COMMAND_HZ === 0) this.collectIdle(now);
    const ms = performance.now() - t0;
    this.stats.tickMsLast = ms;
    this.stats.tickMsMax = Math.max(this.stats.tickMsMax, ms);
    this.stats.tickMsAvg = this.stats.tickMsAvg * 0.95 + ms * 0.05;
  }

  collectIdle(now) {
    for (const [id, inst] of this.instances) {
      if (inst.players.length || inst.policy === 'static' || inst.emptySince === null) continue;
      if (now - inst.emptySince > (inst.idleTimeout ?? this.options.idleTimeoutSeconds) * 1000) {
        inst.close();
        this.instances.delete(id);
        this.log(`instance ${id} closed (idle)`);
      }
    }
  }

  get playerCount() {
    let n = 0;
    for (const i of this.instances.values()) n += i.players.length;
    return n;
  }
}
