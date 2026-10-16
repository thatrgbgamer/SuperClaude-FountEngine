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
    this.entityVer = new Map();     // entity id -> the version last sent
    this.spawned = new Set();       // dynamic entity ids the client has been told to create
    this.hidden = new Set();        // map entity ids the client has been told to hide
    this.dataStr = null;            // last actor.data sent (own actor only)
    this.hotbarStr = null;
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
  constructor(instance, interest = EVERYTHING) {
    this.instance = instance;
    this.interest = interest;
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

    // ---- actors
    const visible = this.interest.actors(player, inst);
    const a = [];
    const seen = new Set();
    for (const actor of visible) {
      seen.add(actor.id);
      const next = this.fieldsOf(actor);
      const prev = view.actors.get(actor.id);
      const d = diffFields(prev, next);
      if (!prev || Object.keys(d).length) {
        d.i = actor.id;
        a.push(d);
        view.actors.set(actor.id, next);
      }
    }
    const x = [];
    for (const id of view.actors.keys()) {
      if (!seen.has(id)) { x.push(id); view.actors.delete(id); }
    }
    if (a.length) snap.a = a;
    if (x.length) snap.x = x;

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
      const shown = (!entity.visibleTo || entity.visibleTo(player)) && this.interest.entityVisible(player, entity, inst);
      if (!shown) {
        if (entity.dynamic) continue;                      // never announced, or removed below
        if (!view.hidden.has(entity.id)) { view.hidden.add(entity.id); e.push({ i: entity.id, h: 1 }); }
        live.add(entity.id);
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
    if (player.pendingEvents.length) { ev.push(...player.pendingEvents); player.pendingEvents.length = 0; }
    if (ev.length) snap.ev = ev;

    void own;
    return snap;
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
