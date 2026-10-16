// Playing online from the browser: the glue between a NetSession (which speaks
// the protocol) and a Game (which draws, listens to input and shows the HUD).
//
// Online, the Game does not simulate actors. It draws what the server says
// exists, with the actor system replaced by ReplicaActors (same drawing and
// lookup surface, no simulation), the player by an OnlinePlayer (same surface as
// ActorPlayer, but abilities go to the server), and entities run only their
// client halves. Everything else the Game does (camera, hover, particles,
// floating numbers, the HUD) is the same code as offline, because the replicas
// look like the real thing.

import { NetSession } from './netcode.js';
import { SpriteInstance } from './sprites.js';
import { getStatusDef } from './actor.js';
import { clamp } from './math.js';

// ---------------------------------------------------------------------------
// Abilities, as far as a client can know them
// ---------------------------------------------------------------------------

/** The read-only half of the ability system: definitions and cooldown state, for the HUD. */
class ReplicaAbilities {
  constructor(game) { this.game = game; }
  get(id) { return this.game.abilityDefs.get(id) || null; }
  has(id) { return this.game.abilityDefs.has(id); }

  cooldownFraction(actor, id) {
    const def = this.get(id);
    if (!def || !(def.cooldown > 0)) return 0;
    return Math.min(1, actor.cooldownRemaining(id) / def.cooldown);
  }

  isReady(actor, id) {
    const def = this.get(id);
    return !!def && !actor.dead && actor.cooldownRemaining(id) <= 0 && actor.canAfford(def.cost);
  }
}

// ---------------------------------------------------------------------------
// The actor system, with nothing to simulate
// ---------------------------------------------------------------------------

export class ReplicaActors {
  constructor(game, session) {
    this.game = game;
    this.session = session;
    this.sprites = game.sprites;
    this.abilities = new ReplicaAbilities(game);
    this.combat = { projectiles: [], modifiers: [] };
    this.nav = null;                      // navigation is the server's business
    this.bus = game.events;
    this.relations = game.relations;
    this.collision = game.collision;
    this.projectileSprites = new Map();
    this.time = 0;
  }

  get actors() { return [...this.session.actors.values()]; }
  getById(id) { return this.session.actors.get(id) || null; }
  byName(name) { return this.actors.filter((a) => a.name === name); }

  inRadius(point, radius, filter = null) {
    return this.actors.filter((a) => !a.dead && Math.hypot(a.feet[0] - point[0], a.feet[2] - point[2]) - a.radius <= radius && (!filter || filter(a)));
  }

  nearestHostile(actor, radius = Infinity) {
    let best = null, bestD = radius;
    for (const o of this.session.actors.values()) {
      if (o.dead || !actor.isHostile(o)) continue;
      const d = Math.hypot(o.feet[0] - actor.feet[0], o.feet[2] - actor.feet[2]) - o.radius;
      if (d < bestD) { best = o; bestD = d; }
    }
    return best;
  }

  /** Sprite animation, driven by what the server last said about each actor. */
  update(dt) {
    this.time += dt;
    for (const ra of this.session.actors.values()) {
      if (!ra.sprite && ra.spriteName && this.sprites.has(ra.spriteName)) {
        ra.sprite = new SpriteInstance(this.sprites, ra.spriteName, { scale: ra.spriteScale });
        ra._seenAction = ra.actionSeq;
        ra._wasDead = ra.dead;
      }
      const s = ra.sprite;
      if (!s) continue;
      s.setHeading(ra.facing[0], ra.facing[1]);
      s.update(dt);

      // A one-shot the server started (or one we started optimistically ourselves).
      if (ra.actionSeq !== ra._seenAction) {
        ra._seenAction = ra.actionSeq;
        if (ra.actionName && !ra.dead) { s.play(ra.actionName, { restart: true }); ra._playing = ra.actionName; }
      }
      if (ra.localAction) { s.play(ra.localAction, { restart: true }); ra._playing = ra.localAction; ra.localAction = null; }

      if (ra.dead) {
        ra.deadFor += dt;
        if (!ra._wasDead) { s.play('death', { restart: true }); ra._wasDead = true; }
      } else {
        if (ra._wasDead) { ra._wasDead = false; ra.deadFor = 0; s.play('idle', { restart: true }); ra._playing = null; }
        if (ra._playing && (s.animName !== ra._playing || s.finished)) ra._playing = null;
        if (!ra._playing) s.play(ra.moving && s.has('walk') ? 'walk' : 'idle');
      }
    }
  }

  groundBelow(feet) {
    if (!this.collision) return feet[1];
    const t = this.collision.traceRay([feet[0], feet[1] + 0.3, feet[2]], [feet[0], feet[1] - 30, feet[2]]);
    return t.hit ? t.endPos[1] : feet[1];
  }

  draw(renderer, cameraYaw) {
    for (const ra of this.session.actors.values()) {
      if (!ra.sprite) continue;
      const pos = ra.pos;
      const fade = ra.dead && ra.corpseTime > 0 ? clamp((ra.corpseTime - ra.deadFor) / 1.5, 0, 1) : 1;
      if (fade <= 0) continue;
      if (!ra.dead) renderer.drawBlobShadow([pos[0], pos[1], pos[2]], ra.radius * 1.3, 0.75);
      let tint = ra.sprite.tint;
      for (const st of ra.statuses) {
        const def = getStatusDef(st.id);
        if (def && def.tint) tint = [tint[0] * def.tint[0], tint[1] * def.tint[1], tint[2] * def.tint[2]];
      }
      ra.sprite.draw(renderer, pos, cameraYaw, { tint, alpha: fade });
    }

    // Projectiles, moved on from the last snapshot by their velocity so they glide at the frame rate.
    const age = Math.min(0.1, (this.session.now() - this.session.lastSnapshotAt) / 1000);
    const seen = new Set();
    for (const p of this.session.projectiles) {
      seen.add(p.id);
      if (!p.sprite) continue;
      let inst = this.projectileSprites.get(p.id);
      if (!inst) {
        if (!this.sprites.has(p.sprite)) continue;
        inst = new SpriteInstance(this.sprites, p.sprite, { scale: p.scale, tint: p.tint || undefined });
        this.projectileSprites.set(p.id, inst);
      }
      inst.setHeading(p.vel[0], p.vel[1]);
      inst.update(1 / 60);
      inst.draw(renderer, [p.pos[0] + p.vel[0] * age, p.pos[1], p.pos[2] + p.vel[1] * age], cameraYaw);
    }
    for (const id of this.projectileSprites.keys()) if (!seen.has(id)) this.projectileSprites.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

/** The local player, as the controller and HUD expect it, with abilities sent to the server. */
export class OnlinePlayer {
  constructor(game, session, config) {
    this.game = game;
    this.session = session;
    this.config = config || {};
    this.id = session.playerId;
    this.angles = [0, 0, 0];
    this.kills = 0;
    this.ammo = 0;
    this.noclip = false;
    this.damageFlash = 0;
    this.respawnTimer = 0;
    this.target = null;
    this.moveTarget = null;
    this.entity = null;
    this.pathTimer = 0;
    this.path = null;
    this.pathIndex = 0;
  }

  get actor() { return this.session.self; }
  get hotbar() { return this.session.hotbar || []; }
  set hotbar(v) { this.session.hotbar = v; }
  get controller() { return this.session.predictor ? this.session.predictor.controller : { position: this.actor.position, velocity: [0, 0, 0], halfExtents: [0.35, 0.85, 0.35] }; }
  get position() { return this.actor.position; }
  get eyePosition() { const f = this.actor.pos; return [f[0], f[1] + this.actor.height * 0.9, f[2]]; }
  get dead() { return this.actor.dead; }
  get health() { return this.actor.health; }
  get maxHealth() { return this.actor.maxHealth; }
  get godMode() { return false; }
  set godMode(v) { /* the server owns invulnerability */ }
  get forward() { const f = this.actor.facing; return [f[0], 0, f[1]]; }
  get prevPosition() { return this.actor.pos; }
  set prevPosition(v) {}
  interpolatedEye() { return this.eyePosition; }
  teleport() { /* movement belongs to the server */ }
  respawn() { /* so does coming back to life */ }
  takeDamage() {}
  notify(name, payload) { this.game.events.emit(name, payload); }

  useSlot(game, slot) {
    const id = this.hotbar[slot];
    return id ? this.useAbility(game, id) : { ok: false, reason: 'empty' };
  }

  useAbility(game, id) {
    const A = this.actor;
    const def = game.abilityDefs.get(id);
    if (!def) return { ok: false, reason: 'unknown' };
    // Mirror the cheap checks locally so a slot the player cannot use does not flood the server,
    // and the server remains the one that decides.
    if (A.dead) return { ok: false, reason: 'cannot-act' };
    if (A.cooldownRemaining(id) > 0) return { ok: false, reason: 'cooldown' };
    if (!A.canAfford(def.cost)) { game.events.emit('ability-failed', { id, reason: 'resource', actor: A }); return { ok: false, reason: 'resource' }; }
    if (A.casting) return { ok: false, reason: 'busy' };
    const aim = game.aimFor(this);
    const rooting = def.castTime > 0 && !def.moveWhileCasting;
    this.session.useAbility(id, aim, def.castTime, rooting);
    // Start the swing now; the server confirms it a round trip later.
    A.localAction = def.anim || (def.castTime > 0 ? 'cast' : 'attack');
    if (aim.dir) A.facing = aim.dir;
    return { ok: true, reason: null };
  }
}

// ---------------------------------------------------------------------------
// The connection, as the game sees it
// ---------------------------------------------------------------------------

/**
 * Owns one online session for a Game: connecting, loading each map the server
 * sends (the first, and every portal after), turning server events into
 * game.events, replicated entity state into entity updates, and reconnecting
 * after a dropped connection.
 */
export class OnlineLink {
  constructor(game, options = {}) {
    this.game = game;
    this.options = options;
    this.session = null;
    this.ready = false;
    this.queue = [];             // events and entity updates that arrive while a map is loading
    this.resumeToken = null;
    this.reconnects = 0;
    this.closedByUs = false;
  }

  /** Connect, load the map the server puts us in, and resolve once there is a world to play in. */
  async connect(hello = {}) {
    const game = this.game;
    this.hello = { game: game.config.name, ...this.options.hello, ...hello };
    const session = new NetSession({
      url: this.options.url, hello: this.hello, relations: game.relations,
      abilityLookup: (id) => game.abilityDefs.get(id),
    });
    this.session = session;
    this.bind(session);
    const firstWelcome = new Promise((resolve, reject) => {
      session.once('map-ready', resolve);
      session.once('reject', reject);
      session.once('close', (info) => { if (!this.ready) reject(new Error(info.reason || 'The connection closed before the game started.')); });
    });
    await session.connect();
    await firstWelcome;
  }

  bind(session) {
    const game = this.game;
    session.on('welcome', (w) => { this.resumeToken = w.resume || this.resumeToken; this.loadFor(w); });
    session.on('travel', () => { this.ready = false; game.fadeTo(1, 0.25); });
    session.on('net-event', (ev) => this.deliver(() => this.onEvent(ev)));
    session.on('entity-state', (id, state, extra) => this.deliver(() => this.onEntityState(id, state, extra)));
    session.on('entity-spawn', (e) => this.deliver(() => this.onEntitySpawn(e)));
    session.on('entity-remove', (id) => this.deliver(() => this.onEntityRemove(id)));
    session.on('denied', (m) => game.events.emit('ability-failed', { id: m.id, reason: m.reason, actor: session.self }));
    session.on('close', (info) => this.onClose(info));
  }

  /** Run now if a world is up; otherwise hold until it is. */
  deliver(fn) {
    if (this.ready) fn(); else this.queue.push(fn);
  }

  async loadFor(welcome) {
    this.ready = false;
    try {
      await this.game.loadOnlineMap(this, welcome);
    } catch (err) {
      console.error('[fount] could not load the online map:', err);
      this.session.emit('reject', `Could not load ${welcome.map}: ${err.message}`);
      return;
    }
    this.ready = true;
    for (const fn of this.queue.splice(0)) fn();
    this.session.emit('map-ready', welcome);
    this.game.fadeTo(0, 0.3);
  }

  // ---- server -> game ----------------------------------------------------------

  onEvent(ev) {
    const game = this.game, events = game.events, R = (id) => this.session.actors.get(id) || null;
    switch (ev.ty) {
      case 'dmg': {
        const target = R(ev.a);
        if (!target) return;
        if (target.sprite) target.sprite.flash(0.14);
        events.emit('damage', { target, source: R(ev.s), final: ev.v, amount: ev.v, type: ev.k, crit: !!ev.c, point: ev.p, kind: ev.kd });
        break;
      }
      case 'heal': if (R(ev.a)) events.emit('heal', { target: R(ev.a), source: R(ev.s), amount: ev.v, crit: !!ev.c }); break;
      case 'death': if (R(ev.a)) events.emit('death', R(ev.a), { source: R(ev.s) }); break;
      case 'fx': events.emit('fx', { preset: ev.p, pos: ev.at, count: ev.n }); break;
      case 'snd': events.emit('sound', { name: ev.n, pos: ev.at }); break;
      case 'melee': if (R(ev.a)) events.emit('melee', { source: R(ev.a), dir: ev.d }); break;
      case 'cs': if (R(ev.a)) events.emit('cast-start', R(ev.a), game.abilityDefs.get(ev.ab) || { id: ev.ab }); break;
      case 'cc': if (R(ev.a)) events.emit('cast-cancel', R(ev.a), game.abilityDefs.get(ev.ab) || { id: ev.ab }, ev.r); break;
      case 'ab': if (R(ev.a)) events.emit('ability', R(ev.a), game.abilityDefs.get(ev.ab) || { id: ev.ab }, {}); break;
      case 'aggro': if (R(ev.a)) events.emit('aggro', R(ev.a), R(ev.t)); break;
      case 'stt': if (R(ev.a)) events.emit('status', R(ev.a), { def: { id: ev.id } }, ev.op); break;
      case 'resp': if (R(ev.a)) events.emit('respawn', R(ev.a)); break;
      case 'note': events.emit(ev.n, ev.d); break;
      default: break;
    }
  }

  onEntityState(id, state, extra) {
    const world = this.game.world;
    const e = world && world.findById(id);
    if (!e) return;
    if (extra.h !== undefined) e.hidden = !!extra.h;
    if (extra.en !== undefined) e.enabled = !!extra.en;
    if (extra.o) e.origin = [...extra.o];
    if (state) world.applyReplicated(e, state);
  }

  onEntitySpawn(s) {
    const world = this.game.world;
    if (!world || world.findById(s.i)) return;
    const e = world.spawn({ ...s.kv, classname: s.c, origin: s.o }, { id: s.i, dynamic: true });
    e.dynamic = true;
  }

  onEntityRemove(id) {
    const world = this.game.world;
    const e = world && world.findById(id);
    if (e) world.remove(e);
  }

  // ---- connection loss ------------------------------------------------------------

  onClose(info) {
    if (this.closedByUs) return;
    const game = this.game;
    game.events.emit('disconnected', { reason: info.reason || 'connection lost' });
    if (!this.resumeToken || this.reconnects >= 8) { game.events.emit('online-ended', { reason: info.reason }); return; }
    this.reconnects++;
    game.events.emit('reconnecting', { attempt: this.reconnects });
    setTimeout(() => this.reconnect(), Math.min(4000, 700 * this.reconnects));
  }

  async reconnect() {
    if (this.closedByUs) return;
    try {
      const session = new NetSession({
        url: this.options.url, hello: { ...this.hello, resume: this.resumeToken }, relations: this.game.relations,
        abilityLookup: (id) => this.game.abilityDefs.get(id),
      });
      this.session = session;
      this.bind(session);
      const ready = new Promise((resolve) => session.once('map-ready', resolve));
      await session.connect();
      await ready;
      this.reconnects = 0;
      this.game.events.emit('reconnected', {});
    } catch (err) {
      this.onClose({ reason: err.message });
    }
  }

  close() {
    this.closedByUs = true;
    if (this.session) this.session.close();
  }
}
