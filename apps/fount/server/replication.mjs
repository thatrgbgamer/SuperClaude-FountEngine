// Turning an instance's state into the snapshots clients receive.
//
// A snapshot is a delta against what that particular client has already been
// told: a walking actor costs a position, a standing one costs nothing. Each
// client has a ClientView remembering what it has been sent; a snapshot is the
// difference between that and now. Interest management (which actors a client
// hears about at all) is a separate object passed in, so the snapshot builder
// does not care how "nearby" is decided.

import { round1, round2, facingToDegrees } from '../engine/protocol.js';

/** What one client has been told so far. */
export class ClientView {
  constructor() {
    this.actors = new Map();        // actor id -> the fields last sent
    this.sentTick = new Map();      // actor id -> the tick it was last sent on
    this.entityVer = new Map();     // entity id -> the version last sent
    this.spawned = new Set();       // dynamic entity ids the client has been told to create
    this.hidden = new Set();        // map entity ids the client has been told to hide
    this.dataStr = null;            // last actor.data sent (own actor only)
    this.hotbarStr = null;
    this.hadProjectiles = false;
    this.deferred = 0;              // actor updates the budget held back last tick
  }
}

/** The fields a client needs to draw an actor, in the short names the protocol uses. */
export function actorFields(actor) {
  const f = actor.feet;
  const v = actor.controller.velocity;
  const fields = {
    k: actor.kind === 'player' ? 'p' : 'n',
    nm: actor.name,
    fc: actor.faction,
    sp: actor.spriteName || (actor.sprite ? actor.sprite.name : null),
    sc: actor.spriteScale,
    r: actor.radius,
    h: actor.height,
    x: round2(f[0]), y: round2(f[1]), z: round2(f[2]),
    fa: facingToDegrees(actor.facing),
    vx: round1(v[0]), vz: round1(v[2]),
    hp: Math.max(0, Math.ceil(actor.health)),
    mh: Math.ceil(actor.maxHealth),
    d: actor.dead ? 1 : 0,
    ac: actor.actionName,
    as: actor.actionSeq,
    st: actor.statuses.map((s) => s.def.id),
    pid: actor.player ? actor.player.id : null,
    ct: actor.dead && Number.isFinite(actor.corpseTime) ? actor.corpseTime : 0,
  };
  if (actor.publicData && Object.keys(actor.publicData).length) fields.pd = actor.publicData;
  return fields;
}

const same = (a, b) => (a === b) || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));

/** The fields of `next` that differ from `prev` (all of them if prev is null). */
export function diffFields(prev, next) {
  if (!prev) return { ...next };
  const out = {};
  for (const k of Object.keys(next)) if (!same(prev[k], next[k])) out[k] = next[k];
  return out;
}

/** Every actor, every event, everything: the interest policy for a small instance. */
export const EVERYTHING = {
  actors: (player, instance) => instance.actors.actors,
  entityVisible: () => true,
  eventVisible: () => true,
  projectileVisible: () => true,
};

export class Replicator {
  /** options: { bytesPerTick } a ceiling on one client's snapshot (Infinity for none); { maxEvents }. */
  constructor(instance, interest = EVERYTHING, options = {}) {
    this.instance = instance;
    this.interest = interest;
    this.bytesPerTick = options.bytesPerTick ?? Infinity;
    this.maxEvents = options.maxEvents ?? 96;
    this.tickNo = -1;
    this.actorCache = new Map();
  }

  /** Compute, once per tick, anything every client's snapshot shares. */
  beginTick(tickNo) {
    this.tickNo = tickNo;
    this.actorCache.clear();
    for (const e of this.instance.world.entities) this.refreshEntity(e);
  }

  fieldsOf(actor) {
    let f = this.actorCache.get(actor.id);
    if (!f) this.actorCache.set(actor.id, (f = actorFields(actor)));
    return f;
  }

  refreshEntity(entity) {
    const world = this.instance.world;
    const rep = world.replicate(entity);
    const o = entity.origin.map(round2);
    const str = JSON.stringify([rep, o, entity.enabled ? 1 : 0]);
    if (str !== entity._netStr) {
      entity._netStr = str;
      entity._netVer = (entity._netVer || 0) + 1;
      entity._netState = rep;
      entity._netOrigin = o;
    }
  }

  /** The snapshot for one player, updating that player's view of the world. */
  snapshot(player, events) {
    const inst = this.instance;
    const view = player.view;
    const own = player.actor;
    const snap = {
      t: 's',
      n: this.tickNo,
      ts: Math.round(inst.serverTimeMs()),
      wt: round2(inst.worldTime()),
      ack: player.ackReported,
    };

    // ---- the player's own authoritative state: full precision, because the client replays inputs on top of it
    snap.own = this.ownBlock(player, view);

    // ---- projectiles in view
    const projectiles = [];
    for (const p of inst.actors.combat.projectiles) {
      if (p.dead || !this.interest.projectileVisible(player, p, inst)) continue;
      projectiles.push([p.id, round2(p.pos[0]), round2(p.pos[1]), round2(p.pos[2]), round1(p.vel[0]), round1(p.vel[2]),
        p.spec.sprite || 0, p.spec.scale ?? 1, p.spec.tint || 0]);
    }
    if (projectiles.length || view.hadProjectiles) snap.p = projectiles;
    view.hadProjectiles = projectiles.length > 0;

    // ---- entities
    const es = [], e = [], er = [];
    const world = inst.world;
    const live = new Set();
    for (const entity of world.entities) {
      if (entity.removed) continue;
      if (entity.visibleTo && !entity.visibleTo(player)) {
        // Hidden from this player on purpose: a map entity exists on their client already, so tell it to hide.
        if (entity.dynamic) continue;
        if (!view.hidden.has(entity.id)) { view.hidden.add(entity.id); e.push({ i: entity.id, h: 1 }); }
        live.add(entity.id);
        continue;
      }
      if (!this.interest.entityVisible(player, entity, inst)) {
        // Too far to matter: a map entity stays as it was on their client; a runtime one is withdrawn.
        if (!entity.dynamic) live.add(entity.id);
        continue;
      }
      live.add(entity.id);
      if (view.hidden.has(entity.id)) { view.hidden.delete(entity.id); view.entityVer.delete(entity.id); e.push({ i: entity.id, h: 0 }); }
      if (entity.dynamic && !view.spawned.has(entity.id)) {
        view.spawned.add(entity.id);
        if (!entity._netKv) entity._netKv = JSON.parse(JSON.stringify(entity.kv));
        es.push({ i: entity.id, c: entity.classname, kv: entity._netKv, o: entity.origin.map(round2) });
      }
      if (view.entityVer.get(entity.id) !== entity._netVer) {
        view.entityVer.set(entity.id, entity._netVer);
        e.push({ i: entity.id, s: entity._netState, o: entity._netOrigin, en: entity.enabled ? 1 : 0 });
      }
    }
    for (const id of view.entityVer.keys()) {
      if (!live.has(id)) { view.entityVer.delete(id); view.spawned.delete(id); view.hidden.delete(id); er.push(id); }
    }
    for (const id of view.spawned) if (!live.has(id)) { view.spawned.delete(id); er.push(id); }
    if (es.length) snap.es = es;
    if (e.length) snap.e = e;
    if (er.length) snap.er = er;

    // ---- events: the tick's shared ones that this player can see, then ones sent just to them
    const ev = [];
    for (const item of events) {
      if (item.only !== undefined && item.only !== player.id) continue;
      if (item.only === undefined && !this.interest.eventVisible(player, item, inst)) continue;
      ev.push(item.ev);
    }
    if (ev.length > this.maxEvents) {
      // A storm of events must not crowd out the state: keep what concerns this player, then the newest.
      const mine = own.id;
      const concerns = ev.filter((q) => q.a === mine || q.s === mine || q.t === mine);
      const rest = ev.filter((q) => !(q.a === mine || q.s === mine || q.t === mine));
      const keep = Math.min(concerns.length, this.maxEvents / 2);
      ev.length = 0;
      ev.push(...rest.slice(-(this.maxEvents - keep)), ...concerns.slice(-keep));
    }
    if (player.pendingEvents.length) { ev.push(...player.pendingEvents); player.pendingEvents.length = 0; }
    if (ev.length) snap.ev = ev;

    // ---- actors in view, fitted to what the byte budget has left
    this.actorUpdates(player, view, snap);
    return snap;
  }

  actorUpdates(player, view, snap) {
    const inst = this.instance;
    const me = player.actor;
    const mp = me.controller.position;
    const seen = new Set();
    const candidates = [];
    for (const actor of this.interest.actors(player, inst)) {
      seen.add(actor.id);
      const next = this.fieldsOf(actor);
      const prev = view.actors.get(actor.id);
      const d = diffFields(prev, next);
      if (prev && !Object.keys(d).length) continue;
      const p = actor.controller.position;
      const dist = Math.hypot(p[0] - mp[0], p[2] - mp[2]);
      const stale = this.tickNo - (view.sentTick.get(actor.id) ?? this.tickNo - 4);
      candidates.push({ actor, d, next, size: JSON.stringify(d).length + 4, score: (actor === me ? 1e9 : 0) + 1000 / (1 + dist) + stale * 20 });
    }
    const x = [];
    for (const id of view.actors.keys()) {
      if (!seen.has(id)) { x.push(id); view.actors.delete(id); view.sentTick.delete(id); }
    }
    let room = Infinity;
    if (this.bytesPerTick !== Infinity) {
      room = Math.max(this.bytesPerTick * 0.3, this.bytesPerTick - JSON.stringify(snap).length);
      candidates.sort((u, v) => v.score - u.score);
    }
    const a = [];
    let used = 0, deferred = 0;
    for (const c of candidates) {
      if (c.actor !== me && used + c.size > room) { deferred++; continue; }   // late, not lost: the view stays as it was
      used += c.size;
      c.d.i = c.actor.id;
      a.push(c.d);
      view.actors.set(c.actor.id, c.next);
      view.sentTick.set(c.actor.id, this.tickNo);
    }
    view.deferred = deferred;
    if (a.length) snap.a = a;
    if (x.length) snap.x = x;
  }

  ownBlock(player, view) {
    const actor = player.actor;
    const c = actor.controller;
    const res = {};
    for (const [k, r] of Object.entries(actor.resources)) res[k] = [round2(r.value), r.max];
    const cd = {};
    for (const [k, v] of Object.entries(actor.cooldowns)) cd[k] = round2(v);
    const block = {
      p: [c.position[0], c.position[1], c.position[2]],
      v: [c.velocity[0], c.velocity[1], c.velocity[2]],
      og: c.onGround ? 1 : 0,
      sp: actor.speed,
      cm: actor.canMove() ? 1 : 0,
      res, cd,
      cast: actor.casting ? { id: actor.casting.def.id, t: round2(actor.casting.t), total: actor.casting.total } : null,
      st: actor.statuses.map((s) => ({ id: s.def.id, r: round1(s.remaining), d: s.duration, k: s.stacks })),
      rt: actor.dead ? round1(Math.max(0, player.respawnTimer)) : 0,
    };
    const dataStr = JSON.stringify(actor.data);
    if (dataStr !== view.dataStr) { view.dataStr = dataStr; block.dd = actor.data; }
    const hotbarStr = JSON.stringify(player.hotbar);
    if (hotbarStr !== view.hotbarStr) { view.hotbarStr = hotbarStr; block.hb = player.hotbar; }
    return block;
  }
}
