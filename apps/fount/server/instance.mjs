// An Instance is one running copy of one map: its collision, its actors, its
// entities (server halves), and the players in it. It is the authoritative
// simulation. Clients send intents; the instance validates and applies them,
// runs the world at the same fixed 1/120 s step the offline game uses, and
// hands each player a snapshot every 1/30 s.
//
// Nothing here knows about sockets. A player has a `session` with a send()
// method, which makes the whole class testable by calling tick() in a loop.

import { performance } from 'node:perf_hooks';
import { buildMap } from '../engine/map.js';
import { ActorSystem } from '../engine/actors.js';
import { EntityWorld } from '../engine/entity.js';
import { Emitter } from '../engine/events.js';
import { createPlayer, ActorPlayer } from '../engine/rpg_player.js';
import { makeRandom } from '../engine/math.js';
import { SIM_DT, STEPS_PER_COMMAND, COMMAND_HZ, LIMITS, round2 } from '../engine/protocol.js';
import '../engine/entities.js';
import '../engine/entities_rpg.js';
import { Replicator, ClientView } from './replication.mjs';
import { SpatialInterest } from './interest.mjs';
import { Encounters } from './encounters.mjs';

const MAX_REACH = 60;          // an aim point or target further than this from the caster is ignored
const MAX_ABILITIES_PER_SECOND = 10;

/** A player on a server: an ActorPlayer plus the network state around it. */
export class ServerPlayer extends ActorPlayer {
  constructor(actor, cfg, instance, session) {
    super(actor, cfg);
    this.instance = instance;
    this.session = session;
    this.queue = [];
    this.lastCmd = { mv: [0, 0], f: null };
    this.ack = -1;
    this.repeats = 0;
    this.pendingEvents = [];
    this.view = new ClientView();
    this.abilityTimes = [];
    this.actionLog = [];
    this.disconnectedAt = null;
    this.active = false;       // has sent at least one movement command
    this.owed = 0;             // ticks already played by repeating a command that was late
  }

  /** Queue a notification for this player alone: it rides their next snapshot. */
  notify(name, payload) {
    this.pendingEvents.push({ ty: 'note', n: name, d: payload });
  }

  send(msg) { if (this.session) this.view.bytes += this.session.send(msg) || 0; }

  /**
   * The command number the player's state corresponds to. Command numbers are
   * consecutive, so a tick that was played by repeating (because the real command
   * was late) stands in for the next number: the state already includes it.
   */
  get ackReported() { return this.ack + this.owed; }

  enqueue(cmd) {
    this.queue.push(cmd);
    // A client running ahead of the server by more than a few commands is
    // dropped back, oldest first: the newest intent is the one that matters.
    while (this.queue.length > LIMITS.maxQueuedCommands) this.queue.shift();
  }

  /**
   * Start of a tick: take the next command. If none has arrived, play the last one
   * again rather than freeze (a late packet should not stutter the player), and
   * remember that this tick has been played. When the late command does turn up
   * it is acknowledged but not played a second time, so the server never runs
   * the player further than the client has told it to. Without this, every late
   * packet leaves the server one command ahead and the client rubber-bands.
   */
  consumeCommand() {
    const cmd = this.queue.shift();
    this.actor.movementPaused = false;
    if (cmd) {
      this.lastCmd = cmd;
      this.ack = cmd.q;
      this.repeats = 0;
      this.active = true;
      if (this.owed > 0) { this.owed--; this.actor.movementPaused = true; }
    } else if (this.active) {
      if (++this.repeats > 8) {
        // About a quarter of a second of silence: stop rather than run on forever.
        this.lastCmd = { mv: [0, 0], f: lastFacing(this.lastCmd) };
      } else if (this.lastCmd.mv[0] !== 0 || this.lastCmd.mv[1] !== 0) {
        this.owed = Math.min(3, this.owed + 1);
      }
    }
    this.actor.intent.move = this.lastCmd.mv;
    this.actor.intent.face = this.lastCmd.f;
  }

  /** Per physics step. */
  stepServer(dt) {
    if (this.actor.dead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.instance.respawnPlayer(this);
    }
  }
}

const lastFacing = (cmd) => cmd.f;

export class Instance {
  static async create(manager, options) {
    const inst = new Instance(manager, options);
    await inst.load();
    return inst;
  }

  constructor(manager, options) {
    this.manager = manager;
    this.gameData = manager.gameData;
    this.id = options.id;
    this.mapPath = options.mapPath;
    this.policy = options.policy || 'shared';
    this.cap = options.cap || 30;
    this.partyId = options.partyId || null;
    this.ownerId = options.ownerId || null;
    this.seed = options.seed ?? (Math.random() * 0xffffffff) >>> 0;
    this.createdAt = Date.now();
    this.emptySince = Date.now();
    this.tickNo = 0;
    this.lastTickMs = 0;
    this.tickMsMax = 0;
    this.players = [];
    this.tickEvents = [];
    this.interest = options.interest || null;     // built in load() from the config unless given
    this.closed = false;
  }

  async load() {
    const entry = await this.gameData.map(this.mapPath);
    this.doc = entry.doc;
    this.config = entry.config;
    this.built = buildMap(this.doc);
    this.collision = this.built.collision;
    this.dynamicBrushes = [];
    this.collision.setDynamicBrushes(this.dynamicBrushes);

    this.bus = new Emitter();
    this.rng = makeRandom(this.seed);   // combat rolls come from here: reproducible for a given seed
    const entities = this.built.entities || [];
    const start = entities.find((e) => e.classname === 'info_player_start');
    this.actors = new ActorSystem({
      collision: this.collision, sprites: this.gameData.sprites, bus: this.bus,
      abilityDefs: this.gameData.abilityDefs, relations: this.gameData.relations, rng: this.rng,
      nav: { top: (start ? start.origin[1] : 0) + 2.5, ...(this.config.nav || {}) },
    });

    this.encounters = new Encounters(this);
    this.worldState = {};          // free-form per-instance state for the game's scripts (a season, a boss flag)
    const instance = this;
    const particles = {
      count: 0,
      define() {},
      burst(preset, pos, options = {}) { instance.emitFx(preset, pos, options.count); },
      emitter() { return { stop() {}, alive: false }; },
    };
    this.gameFacade = {
      mode: 'topdown', online: true, side: 'server', instance,
      get transitioning() { return false; },
      events: this.bus, particles, actors: this.actors,
      get worldState() { return instance.worldState; },
      set worldState(v) { instance.worldState = v; },
      get renderTime() { return instance.worldTime(); },
      cameraYaw: 0,
      travel: () => { throw new Error('On a server, send a player to another map with world.context.travel(player, map, landmark)'); },
    };
    this.world = new EntityWorld({
      collision: this.collision,
      actors: this.actors,
      economy: this.manager.economy,
      parties: this.manager.social,
      encounters: this.encounters,
      particles,
      sprites: this.gameData.sprites,
      events: this.bus,
      materialIndex: this.built.materialIndex,
      player: null,                // there is no single local player on a server: use players
      players: this.players,
      travel: (player, map, landmark) => this.manager.requestTravel(player, map, landmark),
      listener: () => [0, 0, 0],
      registerDynamicBrush: (b) => this.dynamicBrushes.push(b),
      findTriggerBrush: (name) => this.built.triggerBrushes.find((t) => t.name === name),
      game: this.gameFacade,
      instance,
    }, { side: 'server' });

    entities.forEach((data, i) => this.world.spawn(data, { id: i + 1 }));
    this.world.finishMapSpawn();
    this.entityStart = start;
    this.landmarks = entities.filter((e) => e.classname === 'info_landmark');

    const srv = this.config.server || {};
    const block = (this.doc && this.doc.instance) || {};
    const radius = block.viewRadius ?? srv.viewRadius ?? 45;
    const bandwidth = block.bandwidth ?? srv.bandwidth ?? 0;         // bytes per second per client; 0 = unlimited
    if (!this.interest) this.interest = new SpatialInterest({ radius, margin: block.interestMargin ?? srv.interestMargin ?? 1.15 });
    this.replicator = new Replicator(this, this.interest, { bytesPerTick: bandwidth > 0 ? bandwidth / 30 : Infinity });
    this.wireEvents();
    this.gameData.callHook('instanceCreated', this);
  }

  // ---- time ---------------------------------------------------------------------

  serverTimeMs() { return this.manager.nowMs(); }
  worldTime() { return this.manager.worldTime(); }

  // ---- events ---------------------------------------------------------------------

  pushEvent(ev, at = null, only = undefined) {
    this.tickEvents.push({ ev, at: at ? [at[0], at[2]] : null, only });
  }

  emitFx(preset, pos, count) {
    this.pushEvent({ ty: 'fx', p: preset, at: pos.map(round2), n: count }, pos);
  }

  /** Turn the simulation's own events into protocol events for clients. */
  wireEvents() {
    const bus = this.bus;
    const sid = (s) => (s ? s.id : 0);
    bus.on('damage', (e) => {
      if (!e.target || e.final <= 0) return;
      this.pushEvent({ ty: 'dmg', a: e.target.id, s: sid(e.source), v: e.final, k: e.type, c: e.crit ? 1 : 0, p: e.point ? e.point.map(round2) : null, kd: e.kind }, e.target.feet);
    });
    bus.on('heal', (e) => this.pushEvent({ ty: 'heal', a: e.target.id, s: sid(e.source), v: Math.round(e.amount * 10) / 10, c: e.crit ? 1 : 0 }, e.target.feet));
    bus.on('death', (a, cause) => this.pushEvent({ ty: 'death', a: a.id, s: cause && cause.source ? cause.source.id : 0 }, a.feet));
    bus.on('fx', (e) => this.emitFx(e.preset, e.pos, e.count));
    bus.on('sound', (e) => this.pushEvent({ ty: 'snd', n: e.name, at: e.pos ? e.pos.map(round2) : null }, e.pos));
    bus.on('melee', (e) => this.pushEvent({ ty: 'melee', a: e.source.id, d: [round2(e.dir[0]), round2(e.dir[1])] }, e.source.feet));
    bus.on('cast-start', (a, def) => this.pushEvent({ ty: 'cs', a: a.id, ab: def.id }, a.feet));
    bus.on('cast-cancel', (a, def, reason) => this.pushEvent({ ty: 'cc', a: a.id, ab: def.id, r: reason }, a.feet));
    bus.on('ability', (a, def) => this.pushEvent({ ty: 'ab', a: a.id, ab: def.id }, a.feet));
    bus.on('aggro', (a, t) => this.pushEvent({ ty: 'aggro', a: a.id, t: t.id }, a.feet));
    bus.on('status', (a, st, op) => this.pushEvent({ ty: 'stt', a: a.id, id: st.def.id, op }, a.feet));
    bus.on('respawn', (a) => this.pushEvent({ ty: 'resp', a: a.id }, a.feet));
    // A script that broadcasts a toast or floating text to everyone in the instance.
    bus.on('toast', (e) => this.pushEvent({ ty: 'note', n: 'toast', d: e }, e.pos || null));
    bus.on('floatText', (e) => this.pushEvent({ ty: 'note', n: 'floatText', d: e }, e.pos || null));
  }

  // ---- players ---------------------------------------------------------------------

  /** Where a player arriving by `landmark` (or fresh) should stand, and which way they face. */
  spawnFor(landmark) {
    const lm = landmark ? this.landmarks.find((l) => l.name === landmark) : null;
    if (landmark && !lm) console.warn(`[fount] ${this.mapPath} has no info_landmark "${landmark}"; using the player start`);
    const e = lm || this.entityStart;
    return {
      feet: e ? [e.origin[0], e.origin[1] + 0.05, e.origin[2]] : [0, 1, 0],
      yaw: e && e.angles ? e.angles[1] : 0,
    };
  }

  /**
   * Put a player in this instance. `info`: { session, id, config (player config for this character),
   * landmark, carry (an actor snapshot to restore) }. Returns the ServerPlayer.
   */
  addPlayer(info) {
    let { feet, yaw } = this.spawnFor(info.landmark);
    // A returning character stands where they were saved, unless that spot is now inside a wall.
    if (info.feet && !this.collision.pointInSolid([info.feet[0], info.feet[1] + 0.9, info.feet[2]], [0.35, 0.85, 0.35])) {
      feet = [info.feet[0], info.feet[1], info.feet[2]];
      yaw = info.yaw ?? yaw;
    }
    const cfg = { ...(this.config.player || {}), ...(info.config || {}) };
    const player = createPlayer(this.actors, cfg, feet, yaw, info.carry, (actor, c) => new ServerPlayer(actor, c, this, info.session));
    player.id = info.id;
    player.name = cfg.name;
    player.character = info.character || null;      // { id, accountId, name }: set when the player is logged in
    this.players.push(player);
    this.emptySince = null;
    this.encounters.sidekickPlayer(player);
    this.encounters.refresh();
    this.gameData.callHook('playerJoined', this, player, info);
    this.manager.events.emit('player-joined', player, this);
    return player;
  }

  removePlayer(player) {
    const i = this.players.indexOf(player);
    if (i < 0) return;
    // Told while the actor still exists, so the character can be saved as it is.
    this.manager.events.emit('player-left', player, this);
    this.gameData.callHook('playerLeft', this, player);
    this.encounters.playerLeft(player);
    this.players.splice(i, 1);
    this.encounters.refresh();
    this.world.forgetPlayer(player.id);
    this.actors.remove(player.actor);
    if (!this.players.length) this.emptySince = Date.now();
  }

  respawnPlayer(player) {
    player.respawn();
    this.bus.emit('respawn', player.actor);
    this.gameData.callHook('playerRespawned', this, player);
  }

  welcome(player) {
    const c = player.actor.controller;
    return {
      t: 'welcome',
      id: player.id,
      actor: player.actor.id,
      name: player.actor.name,
      serverTime: Math.round(this.serverTimeMs()),
      worldTime: round2(this.worldTime()),
      tickHz: COMMAND_HZ,
      map: this.mapPath,
      instance: this.id,
      spawn: player.actor.feet,
      body: { hx: c.halfExtents[0], hy: c.halfExtents[1], hz: c.halfExtents[2], acc: c.acceleration, fr: c.friction, g: c.gravity, step: c.stepHeight, speed: player.actor.speed },
    };
  }

  // ---- intents from clients --------------------------------------------------------

  handleAbility(player, msg) {
    const A = player.actor;
    const now = performance.now();
    player.abilityTimes = player.abilityTimes.filter((t) => now - t < 1000);
    if (player.abilityTimes.length >= MAX_ABILITIES_PER_SECOND) return;       // spam: ignore, do not even reply
    player.abilityTimes.push(now);
    player.actionLog.push({ at: Date.now(), id: msg.id });
    if (player.actionLog.length > 50) player.actionLog.shift();

    const deny = (reason) => player.send({ t: 'denied', id: msg.id, reason });
    if (A.dead) return deny('cannot-act');
    // A client may only use what is on its bar (plus anything the game opens up): it cannot name any ability in the file.
    const allowed = player.hotbar.includes(msg.id) || this.config.server?.openAbilities === true || A.data.abilities?.includes?.(msg.id);
    if (!allowed) return deny('not-allowed');

    const feet = A.feet;
    const aim = {};
    if (msg.aim.dir) aim.dir = msg.aim.dir;
    if (msg.aim.point && Math.hypot(msg.aim.point[0] - feet[0], msg.aim.point[2] - feet[2]) <= MAX_REACH) aim.point = msg.aim.point;
    if (msg.aim.targetId !== undefined) {
      const t = this.actors.getById(msg.aim.targetId);
      if (t && !t.removed && Math.hypot(t.feet[0] - feet[0], t.feet[2] - feet[2]) <= MAX_REACH) aim.target = t;
    }
    const res = this.actors.abilities.use(A, msg.id, aim);
    if (!res.ok) deny(res.reason);
  }

  handleInteract(player, msg) {
    const e = this.world.findById(msg.entityId);
    if (!e || e.removed) return;
    const f = player.actor.feet;
    if (Math.hypot(e.origin[0] - f[0], e.origin[2] - f[2]) > e.get('interactRadius', 2) + 1) return; // too far to be honest
    this.world.interactWith(e, player);
  }

  // ---- the tick ----------------------------------------------------------------------

  /** Advance the world by one network tick (four physics steps) and send every player a snapshot. */
  tick() {
    const t0 = performance.now();
    this.tickNo++;
    for (const p of this.players) p.consumeCommand();
    for (let k = 0; k < STEPS_PER_COMMAND; k++) {
      for (const p of this.players) p.stepServer(SIM_DT);
      this.world.update(SIM_DT);
      this.actors.update(SIM_DT);
    }
    this.encounters.update(STEPS_PER_COMMAND * SIM_DT);
    this.replicator.beginTick(this.tickNo);
    for (const p of this.players) {
      if (p.disconnectedAt !== null) continue;       // lingering after a dropped connection: nobody to send to
      p.send(this.replicator.snapshot(p, this.tickEvents));
    }
    this.tickEvents.length = 0;
    this.lastTickMs = performance.now() - t0;
    if (this.lastTickMs > this.tickMsMax) this.tickMsMax = this.lastTickMs;
  }

  get playerCount() { return this.players.length; }

  close() {
    this.closed = true;
    this.gameData.callHook('instanceClosed', this);
  }
}
