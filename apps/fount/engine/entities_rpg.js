// Entities for top-down / RPG games: scenery sprites, monsters, hazards,
// level transitions, effects. Same rules as the rest of the entity library:
// everything is addressable from map JSON, and logic is wired with outputs and
// inputs. They reach the game through world.context (actors, particles, game),
// never through globals.

import { defineEntity } from './entity.js';
import { SpriteInstance } from './sprites.js';
import { pointInBrush } from './map.js';

const layerOf = (world, name, fallback = 0) => world.context.materialIndex.get(name) ?? fallback;

const headingFromYaw = (deg) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r)];
};

const playerActor = (world) => {
  const p = world.context.player;
  return p && p.actor ? p.actor : null;
};

// ---------------------------------------------------------------------------
// Landmarks and scenery
// ---------------------------------------------------------------------------

// A named place a level transition can drop the player. info_landmark names
// are looked up by trigger_changelevel; the entity itself does nothing.
defineEntity('info_landmark', {});

defineEntity('prop_sprite', {
  spawn(entity, world) {
    const name = entity.get('sprite');
    if (!name) { console.warn(`[fount] prop_sprite "${entity.name || entity.id}" has no "sprite"`); return; }
    try {
      const s = new SpriteInstance(world.context.sprites, name, { scale: entity.get('scale', 1), anim: entity.get('anim') });
      s.tint = entity.get('tint', [1, 1, 1]);
      s.speed = entity.get('animSpeed', 1);
      const yaw = entity.get('heading', entity.angles[1] || 0);
      const h = headingFromYaw(yaw);
      s.setHeading(h[0], h[1]);
      entity.state.sprite = s;
      entity.state.shadow = entity.get('shadow', 0.45);
    } catch (err) {
      console.warn(`[fount] prop_sprite: ${err.message}`);
    }
  },
  think(entity, world, dt) {
    if (entity.state.sprite) entity.state.sprite.update(dt);
  },
  draw(entity, renderer, shadowPass, world) {
    const s = entity.state.sprite;
    if (!s || shadowPass) return;
    if (entity.state.shadow > 0) renderer.drawBlobShadow(entity.origin, entity.state.shadow, 0.7);
    s.draw(renderer, entity.origin, world.context.game ? world.context.game.cameraYaw : 0);
  },
  inputs: {
    PlayAnim(entity, world, ctx) {
      if (entity.state.sprite) entity.state.sprite.play(ctx.param, { restart: true });
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

defineEntity('actor_npc', {
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
      const a = entity.state.actor, p = playerActor(world);
      if (a && a.ai && p) a.ai.alert(p);
    },
    Enable(entity) { if (entity.state.actor && entity.state.actor.ai) entity.state.actor.ai.enabled = true; },
    Disable(entity) { if (entity.state.actor && entity.state.actor.ai) entity.state.actor.ai.enabled = false; },
  },
});

// ---------------------------------------------------------------------------
// Hazards: lava, acid, a spike pit. A volume that hurts whatever stands in it,
// and can rise and fall on a timer or on command.
// ---------------------------------------------------------------------------

defineEntity('func_hazard', {
  spawn(entity, world) {
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
    s.layer = layerOf(world, entity.get('material', 'lava'), 0);
    s.uvScale = entity.get('uvScale', 0.5);
    s.damage = entity.get('damage', { type: 'fire', amount: 8 });
    s.interval = entity.get('interval', 0.5);
    s.status = entity.get('status');
    s.cool = new Map();
    s.touching = new Set();
    s.particleAcc = 0;
    s.min = [...s.baseMin];
    s.max = [...s.baseMax];
    s.hurtsPlayer = true;
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
    if (!(game && game.mode === 'topdown') && ctx.player && !ctx.player.dead) {
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
      if (!s.touching.has(v.key)) world.fireOutput(entity, 'OnTouch', v.actor ? v.actor.entity : null);
      const left = (s.cool.get(v.key) ?? 0) - dt;
      if (left > 0) { s.cool.set(v.key, left); continue; }
      s.cool.set(v.key, s.interval);
      if (v.actor && system) {
        system.combat.dealDamage(null, v.actor, s.damage, { kind: 'hazard', point: [v.feet[0], s.max[1], v.feet[2]] });
        if (s.status) v.actor.addStatus(s.status);
      } else if (v.key.takeDamage) {
        v.key.takeDamage(s.damage.amount ?? 8, entity);
      }
    }
    for (const k of s.touching) if (!inside.has(k)) s.cool.delete(k);
    s.touching = inside;

    // Surface effects: embers off lava, bubbles off acid.
    const preset = entity.get('particles');
    if (preset && ctx.particles) {
      s.particleAcc += entity.get('particleRate', 3) * dt;
      while (s.particleAcc >= 1) {
        s.particleAcc -= 1;
        ctx.particles.burst(preset, [
          s.min[0] + Math.random() * (s.max[0] - s.min[0]), s.max[1] + 0.05,
          s.min[2] + Math.random() * (s.max[2] - s.min[2]),
        ], { count: 1 });
      }
    }
  },

  draw(entity, renderer, shadowPass) {
    if (shadowPass) return; // a glowing surface neither casts nor needs a shadow
    const s = entity.state;
    renderer.drawBrushBox(s.min, s.max, s.layer, entity.get('tint', [1, 1, 1]), s.uvScale);
  },

  inputs: {
    Raise(entity) { entity.state.target = entity.state.distance; },
    Lower(entity) { entity.state.target = 0; },
    Toggle(entity) { entity.state.target = entity.state.target === 0 ? entity.state.distance : 0; },
    Start(entity) { entity.state.auto = true; },
    Stop(entity) { entity.state.auto = false; },
  },
});

// ---------------------------------------------------------------------------
// Level transitions
// ---------------------------------------------------------------------------

defineEntity('trigger_changelevel', {
  spawn(entity, world) {
    const s = entity.state;
    s.box = entity.kv.min && entity.kv.max ? { min: entity.kv.min, max: entity.kv.max } : null;
    const region = s.box ? null : world.context.findTriggerBrush(entity.name);
    s.planes = region ? region.planes : null;
    if (!s.box && !s.planes) console.warn(`[fount] trigger_changelevel "${entity.name || entity.id}" needs "min"/"max", or a trigger brush with the same name`);
    s.inside = false;
    s.particleAcc = 0;
  },

  think(entity, world, dt) {
    const s = entity.state;
    const ctx = world.context;
    const game = ctx.game;
    const player = ctx.player;
    if (!player || (!s.box && !s.planes)) return;

    const p = player.position;
    let inside;
    if (s.box) {
      inside = p[0] > s.box.min[0] && p[0] < s.box.max[0] && p[2] > s.box.min[2] && p[2] < s.box.max[2]
        && p[1] > s.box.min[1] - 1.5 && p[1] < s.box.max[1] + 1.5;
    } else {
      inside = pointInBrush(s.planes, p, 0.35);
    }

    // A glow over the doorway, so it reads as somewhere you can go.
    const effect = entity.get('effect', 'portal');
    if (effect && ctx.particles && s.box) {
      s.particleAcc += entity.get('effectRate', 6) * dt;
      while (s.particleAcc >= 1) {
        s.particleAcc -= 1;
        ctx.particles.burst(effect, [
          s.box.min[0] + Math.random() * (s.box.max[0] - s.box.min[0]), s.box.min[1],
          s.box.min[2] + Math.random() * (s.box.max[2] - s.box.min[2]),
        ], { count: 1 });
      }
    }

    // Fire on entry, not on every step spent inside.
    if (inside && !s.inside && game && !game.transitioning && !player.dead) {
      world.fireOutput(entity, 'OnTravel');
      if (entity.get('map')) game.travel(entity.get('map'), entity.get('landmark'));
      else console.warn(`[fount] trigger_changelevel "${entity.name || entity.id}" has no "map" to travel to`);
    }
    s.inside = inside;
  },
});

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

defineEntity('env_particles', {
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
});
