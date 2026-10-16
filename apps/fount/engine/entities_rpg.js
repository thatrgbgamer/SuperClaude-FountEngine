// Entities for top-down / RPG games: scenery sprites, monsters, hazards,
// level transitions, effects. Same rules as the rest of the entity library:
// everything is addressable from map JSON, and logic is wired with outputs and
// inputs. They reach the game through world.context (actors, particles, players,
// travel), never through globals.
//
// Each class is written as { server, client } halves. In a single-player game
// both run on the one entity; online, the server half simulates and the client
// half only shows what the server replicates. Anything cosmetic (particles,
// sprite animation) lives in the client half so it costs the server nothing.

import { defineEntity } from './entity.js';
import { SpriteInstance } from './sprites.js';
import { pointInBrush } from './map.js';

const layerOf = (world, name, fallback = 0) => world.context.materialIndex.get(name) ?? fallback;

const headingFromYaw = (deg) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r)];
};

const nearestPlayerActor = (world, point) => {
  let best = null, bestD = Infinity;
  for (const p of world.context.players) {
    if (p.actor.dead) continue;
    const f = p.actor.feet;
    const d = Math.hypot(f[0] - point[0], f[2] - point[2]);
    if (d < bestD) { best = p.actor; bestD = d; }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Landmarks and scenery
// ---------------------------------------------------------------------------

// A named place a level transition can drop the player. info_landmark names
// are looked up by trigger_changelevel; the entity itself does nothing.
defineEntity('info_landmark', {});

defineEntity('prop_sprite', {
  server: {
    spawn(entity) {
      entity.state.anim = entity.get('anim') ?? null;
      entity.state.animSeq = 0;
    },
    inputs: {
      PlayAnim(entity, world, ctx) {
        entity.state.anim = ctx.param;
        entity.state.animSeq++;
      },
    },
  },
  client: {
    spawn(entity, world) {
      const name = entity.get('sprite');
      if (!name) { console.warn(`[fount] prop_sprite "${entity.name || entity.id}" has no "sprite"`); return; }
      try {
        const s = new SpriteInstance(world.context.sprites, name, { scale: entity.get('scale', 1), anim: entity.get('anim') });
        s.tint = entity.get('tint', [1, 1, 1]);
        s.speed = entity.get('animSpeed', 1);
        const h = headingFromYaw(entity.get('heading', entity.angles[1] || 0));
        s.setHeading(h[0], h[1]);
        entity.state.sprite = s;
        entity.state.shadow = entity.get('shadow', 0.45);
        entity.state._seenSeq = 0;
      } catch (err) {
        console.warn(`[fount] prop_sprite: ${err.message}`);
      }
    },
    think(entity, world, dt) {
      const s = entity.state.sprite;
      if (!s) return;
      // The server counts PlayAnim requests; play the animation when the count moves.
      if (entity.state.animSeq !== entity.state._seenSeq) {
        entity.state._seenSeq = entity.state.animSeq;
        if (entity.state.anim) s.play(entity.state.anim, { restart: true });
      }
      s.update(dt);
    },
    draw(entity, renderer, shadowPass, world) {
      const s = entity.state.sprite;
      if (!s || shadowPass) return;
      if (entity.state.shadow > 0) renderer.drawBlobShadow(entity.origin, entity.state.shadow, 0.7);
      s.draw(renderer, entity.origin, world.context.game ? world.context.game.cameraYaw : 0);
    },
  },
});

// ---------------------------------------------------------------------------
// Monsters
// ---------------------------------------------------------------------------

const AI_KEYS = ['aggroRadius', 'loseRadius', 'leashRadius', 'noticeTime', 'wanderRadius', 'wanderPause',
  'wanderSpeed', 'canWander', 'attackRange', 'preferRange', 'senses', 'groupAggro', 'attackAbility', 'attack'];

function spawnActorFor(entity, world) {
  const ctx = world.context;
  const actors = ctx.actors;
  const aiKv = entity.get('ai', {});
  let ai = null;
  if (aiKv !== false && entity.get('passive') !== true) {
    ai = { ...(typeof aiKv === 'object' ? aiKv : {}) };
    for (const k of AI_KEYS) if (entity.kv[k] !== undefined && ai[k] === undefined) ai[k] = entity.kv[k];
  }
  const sprite = entity.get('sprite');
  if (!sprite) console.warn(`[fount] actor_npc "${entity.name || entity.id}" has no "sprite", so it will be invisible`);
  const actor = actors.spawn({
    name: entity.get('title', entity.name || 'Monster'),
    faction: entity.get('faction', 'enemy'),
    health: entity.get('health', 40),
    speed: entity.get('speed', 3),
    radius: entity.get('radius', 0.35),
    height: entity.get('height', 1.5),
    mass: entity.get('mass', 1),
    resist: entity.get('resist'),
    stats: entity.get('stats'),
    resources: entity.get('resources'),
    corpseTime: entity.get('corpseTime', 6),
    sprite,
    spriteScale: entity.get('scale', 1),
    feet: entity.state.home,
    facing: headingFromYaw(entity.angles[1] || 0),
    ai,
  });
  actor.entity = entity;
  entity.state.actor = actor;

  actor.on('damage', (ev) => world.fireOutput(entity, 'OnDamaged', ev.source ? ev.source.entity : null, String(ev.final)));
  actor.on('death', (a, cause) => world.fireOutput(entity, 'OnDeath', cause && cause.source ? cause.source.entity : null));
  actor.on('aggro', () => world.fireOutput(entity, 'OnAggro'));
  actor.on('ai-state', (a, next) => { if (next === 'leash') world.fireOutput(entity, 'OnLeash'); });
  return actor;
}

// The actor itself is replicated by the actor system, so the client half is empty:
// it exists only so a client does not try to run the server's spawn.
defineEntity('actor_npc', {
  server: {
    spawn(entity, world) {
      entity.state.home = [...entity.origin];
      spawnActorFor(entity, world);
    },
    think(entity, world, dt) {
      const actor = entity.state.actor;
      if (!actor) return;
      if (actor.system) { entity.origin = [...actor.feet]; return; }
      // The corpse has been cleared away. Come back, or go for good.
      const respawn = entity.get('respawn', 0);
      if (respawn > 0) {
        entity.state.respawnIn = (entity.state.respawnIn ?? respawn) - dt;
        if (entity.state.respawnIn <= 0) { entity.state.respawnIn = undefined; spawnActorFor(entity, world); }
      } else {
        world.remove(entity);
      }
    },
    inputs: {
      Kill(entity) {
        const a = entity.state.actor;
        if (a && !a.dead) a.takeDamage({ amount: a.health + 1, ignoreResist: true, type: 'physical', kind: 'script' });
      },
      Heal(entity, world, ctx) {
        const a = entity.state.actor;
        if (a) a.heal(parseFloat(ctx.param) || a.maxHealth);
      },
      SetFaction(entity, world, ctx) {
        const a = entity.state.actor;
        if (a && ctx.param) a.faction = ctx.param;
      },
      Aggro(entity, world) {
        const a = entity.state.actor;
        const p = a && nearestPlayerActor(world, a.feet);
        if (a && a.ai && p) a.ai.alert(p);
      },
      Enable(entity) { if (entity.state.actor && entity.state.actor.ai) entity.state.actor.ai.enabled = true; },
      Disable(entity) { if (entity.state.actor && entity.state.actor.ai) entity.state.actor.ai.enabled = false; },
    },
    replicate() { return {}; },
  },
  client: {},
});

// ---------------------------------------------------------------------------
// Hazards: lava, acid, a spike pit. A volume that hurts whatever stands in it,
// and can rise and fall on a timer or on command.
// ---------------------------------------------------------------------------

defineEntity('func_hazard', {
  server: {
    spawn(entity) {
      const s = entity.state;
      s.baseMin = entity.get('min', [0, 0, 0]);
      s.baseMax = entity.get('max', [1, 1, 1]);
      const dir = entity.get('moveDir', [0, 1, 0]);
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      s.moveDir = [dir[0] / l, dir[1] / l, dir[2] / l];
      s.distance = entity.get('distance', 0);
      s.speed = entity.get('speed', 1);
      s.offset = entity.get('startRaised', false) ? s.distance : 0;
      s.target = s.offset;
      s.auto = entity.get('auto', false);
      s.wait = entity.get('wait', 2);
      s.waitTimer = 0;
      s.damage = entity.get('damage', { type: 'fire', amount: 8 });
      s.interval = entity.get('interval', 0.5);
      s.status = entity.get('status');
      s._cool = new Map();
      s._touching = new Set();
      s.min = [...s.baseMin];
      s.max = [...s.baseMax];
    },

    think(entity, world, dt) {
      const s = entity.state;
      const ctx = world.context;

      // Rise and fall.
      if (s.distance > 0) {
        if (s.auto && Math.abs(s.offset - s.target) < 1e-4) {
          s.waitTimer += dt;
          if (s.waitTimer >= s.wait) { s.waitTimer = 0; s.target = s.target === 0 ? s.distance : 0; }
        }
        if (Math.abs(s.offset - s.target) > 1e-4) {
          const dir = Math.sign(s.target - s.offset);
          s.offset += dir * s.speed * dt;
          if ((dir > 0 && s.offset >= s.target) || (dir < 0 && s.offset <= s.target)) {
            s.offset = s.target;
            world.fireOutput(entity, s.target > 0 ? 'OnRaised' : 'OnLowered');
          }
        }
      }
      for (let i = 0; i < 3; i++) {
        s.min[i] = s.baseMin[i] + s.moveDir[i] * s.offset;
        s.max[i] = s.baseMax[i] + s.moveDir[i] * s.offset;
      }

      // Hurt whatever is inside, each victim on its own timer.
      const victims = [];
      const system = ctx.actors;
      if (system) for (const a of system.actors) if (!a.dead) victims.push({ key: a, feet: a.feet, radius: a.radius, height: a.height, actor: a });
      const game = ctx.game;
      if (ctx.player && !(game && game.mode === 'topdown') && !ctx.player.dead) {
        const p = ctx.player.position;
        victims.push({ key: ctx.player, feet: [p[0], p[1] - 0.9, p[2]], radius: 0.35, height: 1.8, actor: null });
      }

      const inside = new Set();
      for (const v of victims) {
        const overlaps = v.feet[0] + v.radius > s.min[0] && v.feet[0] - v.radius < s.max[0]
          && v.feet[2] + v.radius > s.min[2] && v.feet[2] - v.radius < s.max[2]
          && v.feet[1] < s.max[1] && v.feet[1] + v.height > s.min[1];
        if (!overlaps) continue;
        inside.add(v.key);
        if (!s._touching.has(v.key)) world.fireOutput(entity, 'OnTouch', v.actor ? v.actor.entity : null);
        const left = (s._cool.get(v.key) ?? 0) - dt;
        if (left > 0) { s._cool.set(v.key, left); continue; }
        s._cool.set(v.key, s.interval);
        if (v.actor && system) {
          system.combat.dealDamage(null, v.actor, s.damage, { kind: 'hazard', point: [v.feet[0], s.max[1], v.feet[2]] });
          if (s.status) v.actor.addStatus(s.status);
        } else if (v.key.takeDamage) {
          v.key.takeDamage(s.damage.amount ?? 8, entity);
        }
      }
      for (const k of s._touching) if (!inside.has(k)) s._cool.delete(k);
      s._touching = inside;
    },

    // Clients only need the surface: where it is now.
    replicate(entity) { return { min: entity.state.min, max: entity.state.max }; },

    inputs: {
      Raise(entity) { entity.state.target = entity.state.distance; },
      Lower(entity) { entity.state.target = 0; },
      Toggle(entity) { entity.state.target = entity.state.target === 0 ? entity.state.distance : 0; },
      Start(entity) { entity.state.auto = true; },
      Stop(entity) { entity.state.auto = false; },
    },
  },

  client: {
    spawn(entity, world) {
      const s = entity.state;
      s.layer = layerOf(world, entity.get('material', 'lava'), 0);
      s.uvScale = entity.get('uvScale', 0.5);
      s._particleAcc = 0;
      // Until the first replication arrives, show the resting position.
      if (!s.min) { s.min = [...entity.get('min', [0, 0, 0])]; s.max = [...entity.get('max', [1, 1, 1])]; }
    },
    think(entity, world, dt) {
      // Surface effects: embers off lava, bubbles off acid. Cosmetic, so the client's own.
      const s = entity.state;
      const preset = entity.get('particles');
      const particles = world.context.particles;
      if (!preset || !particles || !s.min) return;
      s._particleAcc += entity.get('particleRate', 3) * dt;
      while (s._particleAcc >= 1) {
        s._particleAcc -= 1;
        particles.burst(preset, [
          s.min[0] + Math.random() * (s.max[0] - s.min[0]), s.max[1] + 0.05,
          s.min[2] + Math.random() * (s.max[2] - s.min[2]),
        ], { count: 1 });
      }
    },
    draw(entity, renderer, shadowPass) {
      if (shadowPass) return; // a glowing surface neither casts nor needs a shadow
      const s = entity.state;
      if (!s.min) return;
      renderer.drawBrushBox(s.min, s.max, s.layer, entity.get('tint', [1, 1, 1]), s.uvScale);
    },
  },
});

// ---------------------------------------------------------------------------
// Level transitions
// ---------------------------------------------------------------------------

defineEntity('trigger_changelevel', {
  server: {
    spawn(entity, world) {
      const s = entity.state;
      s._box = entity.kv.min && entity.kv.max ? { min: entity.kv.min, max: entity.kv.max } : null;
      const region = s._box ? null : world.context.findTriggerBrush && world.context.findTriggerBrush(entity.name);
      s._planes = region ? region.planes : null;
      if (!s._box && !s._planes) console.warn(`[fount] trigger_changelevel "${entity.name || entity.id}" needs "min"/"max", or a trigger brush with the same name`);
    },

    think(entity, world) {
      const s = entity.state;
      const ctx = world.context;
      if (!s._box && !s._planes) return;

      // Every player is tested on their own: one walking in does not move the others.
      for (const player of ctx.players) {
        const ps = entity.stateFor(player.id);
        const p = player.position;
        let inside;
        if (s._box) {
          inside = p[0] > s._box.min[0] && p[0] < s._box.max[0] && p[2] > s._box.min[2] && p[2] < s._box.max[2]
            && p[1] > s._box.min[1] - 1.5 && p[1] < s._box.max[1] + 1.5;
        } else {
          inside = pointInBrush(s._planes, p, 0.35);
        }
        // Fire on entry, not on every step spent inside.
        if (inside && !ps.inside && !player.dead) {
          world.fireOutput(entity, 'OnTravel', player.actor.entity || null);
          if (entity.get('map') && ctx.travel) ctx.travel(player, entity.get('map'), entity.get('landmark'));
          else console.warn(`[fount] trigger_changelevel "${entity.name || entity.id}" has no "map" to travel to`);
        }
        ps.inside = inside;
      }
    },
  },

  client: {
    think(entity, world, dt) {
      // A glow over the doorway, so it reads as somewhere you can go.
      const s = entity.state;
      const effect = entity.get('effect', 'portal');
      const particles = world.context.particles;
      const box = entity.kv.min && entity.kv.max ? { min: entity.kv.min, max: entity.kv.max } : null;
      if (!effect || !particles || !box) return;
      s._acc = (s._acc || 0) + entity.get('effectRate', 6) * dt;
      while (s._acc >= 1) {
        s._acc -= 1;
        particles.burst(effect, [
          box.min[0] + Math.random() * (box.max[0] - box.min[0]), box.min[1],
          box.min[2] + Math.random() * (box.max[2] - box.min[2]),
        ], { count: 1 });
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

// Purely cosmetic, so it runs on each client with no help from the server.
defineEntity('env_particles', {
  server: {},
  client: {
    spawn(entity) {
      entity.state.acc = 0;
      entity.state.preset = entity.get('preset', 'smoke');
    },
    think(entity, world, dt) {
      const particles = world.context.particles;
      if (!particles) return;
      const s = entity.state;
      s.acc += entity.get('rate', 6) * dt;
      const radius = entity.get('radius', 0);
      while (s.acc >= 1) {
        s.acc -= 1;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
        particles.burst(s.preset, [entity.origin[0] + Math.cos(a) * r, entity.origin[1], entity.origin[2] + Math.sin(a) * r], { count: 1 });
      }
    },
  },
});
