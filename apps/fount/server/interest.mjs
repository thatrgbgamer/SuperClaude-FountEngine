// Interest management: deciding what each client hears about.
//
// Fifty players in one hub cannot each be sent fifty players' every movement.
// A client only needs what is near it, so the instance keeps a spatial hash of
// its actors (rebuilt each tick, cheap) and asks, per player, "who is within
// view?". Two refinements keep it from being noticeable:
//
//   Hysteresis. An actor comes into view at the view radius but only leaves at
//   a little beyond it, so someone standing on the boundary does not flicker in
//   and out every tick.
//   Always-visible actors. A game can name actors a player must always know about
//   whatever the distance (party members, a boss's adds, the mount they ride).
//
// Events (a damage number, a particle burst) are filtered by where they
// happened, except anything involving the player's own actor, which is always
// delivered: being hit by something you cannot see should still hurt visibly.

const CELL = 16;

const key = (cx, cz) => ((cx + 8192) << 14) | (cz + 8192);

export class SpatialInterest {
  /**
   * options: { radius: 45, margin: 1.15, cell: 16 }.
   * `radius` is metres a client can see; `margin` widens it for actors already in view.
   */
  constructor(options = {}) {
    this.radius = options.radius ?? 45;
    this.margin = options.margin ?? 1.15;
    this.cell = options.cell ?? CELL;
    this.grid = new Map();
    this.entityGrid = new Map();
    this.tick = -1;
  }

  /** Index the instance's actors and entities for this tick. */
  rebuild(instance, tickNo) {
    if (this.tick === tickNo) return;
    this.tick = tickNo;
    this.grid.clear();
    const c = this.cell;
    for (const a of instance.actors.actors) {
      const p = a.controller.position;
      const k = key(Math.floor(p[0] / c), Math.floor(p[2] / c));
      let bucket = this.grid.get(k);
      if (!bucket) this.grid.set(k, (bucket = []));
      bucket.push(a);
    }
  }

  /** Actors within `radius` metres (horizontal) of a point, using the hash to avoid scanning the instance. */
  near(x, z, radius) {
    const c = this.cell;
    const out = [];
    const r2 = radius * radius;
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const bucket = this.grid.get(key(cx, cz));
        if (!bucket) continue;
        for (const a of bucket) {
          const p = a.controller.position;
          const dx = p[0] - x, dz = p[2] - z;
          if (dx * dx + dz * dz <= r2) out.push(a);
        }
      }
    }
    return out;
  }

  // ---- the policy the replicator calls --------------------------------------------

  actors(player, instance) {
    this.rebuild(instance, instance.tickNo);
    const me = player.actor;
    const p = me.controller.position;
    const known = player.view.actors;
    const inside = this.near(p[0], p[2], this.radius);
    const seen = new Set(inside.map((a) => a.id));
    // Anyone already in view stays in view out to the wider radius.
    for (const a of this.near(p[0], p[2], this.radius * this.margin)) if (!seen.has(a.id) && known.has(a.id)) { seen.add(a.id); inside.push(a); }
    if (!seen.has(me.id)) { seen.add(me.id); inside.push(me); }
    if (player.alwaysVisible) {
      for (const a of player.alwaysVisible()) if (a && !a.removed && !seen.has(a.id)) { seen.add(a.id); inside.push(a); }
    }
    return inside;
  }

  entityVisible(player, entity) {
    const p = player.actor.controller.position;
    const r = this.radius * this.margin * 1.5;      // scenery and effects can be seen further than actors matter
    const o = entity.origin;
    // A volume is as near as its closest edge, not its centre.
    let dx, dz;
    if (entity.kv.min && entity.kv.max) {
      dx = Math.max(entity.kv.min[0] - p[0], 0, p[0] - entity.kv.max[0]);
      dz = Math.max(entity.kv.min[2] - p[2], 0, p[2] - entity.kv.max[2]);
    } else { dx = o[0] - p[0]; dz = o[2] - p[2]; }
    return dx * dx + dz * dz <= r * r;
  }

  projectileVisible(player, projectile) {
    const p = player.actor.controller.position;
    const dx = projectile.pos[0] - p[0], dz = projectile.pos[2] - p[2];
    const r = this.radius * this.margin;
    return dx * dx + dz * dz <= r * r;
  }

  eventVisible(player, item) {
    if (!item.at) return true;                      // a global event: everyone
    const p = player.actor.controller.position;
    const dx = item.at[0] - p[0], dz = item.at[1] - p[1];
    const r = this.radius * this.margin;
    if (dx * dx + dz * dz <= r * r) return true;
    const id = player.actor.id;
    return item.ev.a === id || item.ev.s === id || item.ev.t === id;
  }
}
