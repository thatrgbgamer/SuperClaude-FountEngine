# Writing custom entity behaviours

When a game needs a mechanic no built-in class covers, register a new classname. Behaviour files live in `apps/fount/game/scripts/` and are imported by the map's game config or directly by `index.html`.

## Contents

- [defineEntity](#defineentity)
- [Engine services](#engine-services)
- [Worked example: a turret](#worked-example-a-turret)
- [Worked example: a pickup that changes the rules](#worked-example-a-pickup-that-changes-the-rules)
- [Drawing](#drawing)
- [Sprites, actors and events](#sprites-actors-and-events)
- [What not to do](#what-not-to-do)

## defineEntity

```js
import { defineEntity } from '../../engine/entity.js';

defineEntity('my_class', {
  spawn(entity, world) {},                  // once, at map load
  think(entity, world, dt) {},              // every physics step (1/120s) while enabled
  draw(entity, renderer, shadowPass, world) {},  // twice a frame: shadow pass, then colour pass
  inputs: {
    DoThing(entity, world, ctx) {},         // ctx: { activator, caller, param }
  },
});
```

`entity.state` is yours for runtime data. `entity.get(key, fallback)` reads a keyvalue from the map JSON, so every behaviour is tunable from the map without touching code:

```js
entity.state.hp = entity.get('health', 50);
```

Fire an output so level authors can hook your entity into the IO system:

```js
world.fireOutput(entity, 'OnSomethingHappened', activatorEntity, 'optional param');
```

## Engine services

`world.context` holds everything the engine exposes. Never reach for globals.

| Service | Use |
|---|---|
| `world.context.collision` | `traceBox(start, end, halfExtents)`, `traceRay(start, end)`, `pointInSolid(p, half)` |
| `world.context.player` | `position`, `eyePosition`, `forward`, `health`, `ammo`, `takeDamage(n, src)` |
| `world.context.ragdolls` | `spawn(options)`, `ragdolls` array, `count` |
| `world.context.listener()` | Player ear position, for positional audio |
| `world.context.materialIndex` | `Map` of material name → texture layer |
| `world.context.registerDynamicBrush(b)` | Register moving collision geometry |
| `world.context.findTriggerBrush(name)` | Look up a `"trigger": true` brush volume |
| `world.context.actors` | The `ActorSystem`: `spawn(options)`, `actors`, `inRadius(point, r)`, `nearestHostile(actor)`, `nav`, `combat`, `abilities` (see `rpg.md`) |
| `world.context.sprites` | The sprite library: `get(name)`, `has(name)` |
| `world.context.particles` | `burst(preset, pos, opts)`, `emitter(...)` |
| `world.context.events` | The game-wide event emitter: `on`, `off`, `emit` |
| `world.context.game` | The `Game` instance, for anything else (`mode`, `cameraYaw`, `travel()`, `hover`, `input`) |

Traces return `{ hit, fraction, normal, endPos, startSolid }`. Always check `hit` before trusting `normal`.

## Worked example: a turret

```js
import { defineEntity } from '../../engine/entity.js';
import { sub, add, norm, len, mul } from '../../engine/math.js';
import { playSoundAt } from '../../engine/audio.js';

defineEntity('npc_turret', {
  spawn(entity, world) {
    entity.state.cooldown = 0;
    entity.state.layer = world.context.materialIndex.get(entity.get('material', 'metal')) ?? 3;
    entity.state.yaw = entity.angles[1] || 0;
  },

  think(entity, world, dt) {
    const player = world.context.player;
    const muzzle = add(entity.origin, [0, 0.7, 0]);
    const toPlayer = sub(player.eyePosition, muzzle);
    const distance = len(toPlayer);
    if (distance > entity.get('range', 22) || player.health <= 0) return;

    // Don't shoot through walls.
    const trace = world.context.collision.traceRay(muzzle, player.eyePosition);
    if (trace.hit && trace.fraction < 0.98) return;

    const dir = norm(toPlayer);
    entity.state.yaw = Math.atan2(-dir[2], dir[0]) * 180 / Math.PI;

    entity.state.cooldown -= dt;
    if (entity.state.cooldown > 0) return;
    entity.state.cooldown = entity.get('fireInterval', 0.9);

    player.takeDamage(entity.get('damage', 6), entity);
    playSoundAt('shoot', muzzle, world.context.listener(), 45);
    world.fireOutput(entity, 'OnFire');
  },

  draw(entity, renderer, shadowPass) {
    const base = entity.origin;
    renderer.drawBox(add(base, [0, 0.25, 0]), [0.28, 0.25, 0.28], entity.state.layer, [0.7, 0.72, 0.78], null, shadowPass);
    const yawRad = entity.state.yaw * Math.PI / 180;
    const barrel = add(base, [Math.cos(yawRad) * 0.45, 0.72, -Math.sin(yawRad) * 0.45]);
    renderer.drawSegment(add(base, [0, 0.72, 0]), barrel, 0.07, entity.state.layer, [0.5, 0.52, 0.58], shadowPass);
  },

  inputs: {
    Damage(entity, world, ctx) {
      entity.state.hp = (entity.state.hp ?? entity.get('health', 30)) - (parseFloat(ctx.param) || 10);
      if (entity.state.hp <= 0) {
        world.fireOutput(entity, 'OnDestroyed', ctx.activator);
        world.remove(entity);
      }
    },
  },
});
```

Map usage:

```json
{ "classname": "npc_turret", "name": "turret_1", "origin": [6, 0, -8],
  "angles": [0, 180, 0], "range": 20, "damage": 8,
  "connections": [ { "output": "OnDestroyed", "target": "exit_door", "input": "Open" } ] }
```

## Worked example: a pickup that changes the rules

Mechanics that alter player state need no new systems — mutate the player and restore it on a timer.

```js
defineEntity('item_lowgrav', {
  spawn(entity, world) {
    entity.state.layer = world.context.materialIndex.get('light_panel') ?? 7;
  },
  think(entity, world, dt) {
    entity.state.bob = (entity.state.bob || 0) + dt * 3;
    const player = world.context.player;
    const dx = player.position[0] - entity.origin[0];
    const dz = player.position[2] - entity.origin[2];
    const dy = player.position[1] - entity.origin[1];
    if (Math.hypot(dx, dy, dz) > 1.2) return;

    const ctrl = player.controller;
    const original = ctrl.gravity;
    ctrl.gravity = original * 0.35;
    setTimeout(() => { ctrl.gravity = original; }, entity.get('duration', 8) * 1000);

    world.fireOutput(entity, 'OnPickup');
    world.remove(entity);
  },
  draw(entity, renderer, shadowPass) {
    const y = entity.origin[1] + 0.4 + Math.sin(entity.state.bob || 0) * 0.12;
    renderer.drawSphere([entity.origin[0], y, entity.origin[2]], 0.22, entity.state.layer, [0.5, 0.8, 1], shadowPass);
  },
});
```

## Drawing

`draw` is called twice per frame — once for the shadow map, once for colour — and `shadowPass` says which. Pass it through to every renderer call; the shadow pass ignores colour and material, so skipping it just means your entity casts no shadow.

| Call | Use |
|---|---|
| `renderer.drawBox(center, halfExtents, layer, tint, basis, shadowPass)` | Boxes; `basis` is an optional rotation matrix |
| `renderer.drawSphere(center, radius, layer, tint, shadowPass)` | Heads, orbs, pickups |
| `renderer.drawSegment(a, b, thickness, layer, tint, shadowPass)` | A box oriented along `a`→`b`: limbs, barrels, pipes |
| `renderer.setEmissive(true/false)` | Unlit draws, for anything that should glow |

There are no models to load. Compose shapes from these primitives — it is how the NPCs and ragdolls are drawn.

## Sprites, actors and events

A behaviour that wants a character rather than a box spawns an actor and lets the engine animate and draw it:

```js
defineEntity('boss_warden', {
  spawn(entity, world) {
    const actor = world.context.actors.spawn({
      name: 'Warden', faction: 'enemy', feet: entity.origin, health: 400,
      sprite: 'warden', spriteScale: 2, ai: { aggroRadius: 12, attackAbility: 'warden_slam' },
    });
    actor.entity = entity;
    actor.on('death', () => world.fireOutput(entity, 'OnDeath'));
    entity.state.actor = actor;
  },
});
```

The actor system updates and draws its actors itself (`think` only needs to sync `entity.origin`). To react to anything, subscribe once in `spawn`: `world.context.events.on('damage', (ev) => ...)`. Do not poll every actor in `think`.

Sprites are drawn in `draw` with a `SpriteInstance`, which queues them for the end of the frame, so draw order between sprites does not matter (depth sorts them); return early when `shadowPass` is true. Use `renderer.drawBrushBox(min, max, layer, tint, uvScale, shadowPass)` for a box whose texture tiles by world size instead of stretching across each face the way `drawBox` does.

## What not to do

- **Don't call out to a network or an AI API at runtime.** The whole point of this engine is that the game is finished content, not a live service: it runs offline, forever, with no keys and no usage cost. Author the behaviour now; don't defer it to an API call later.
- **Don't mutate `entity.kv` expecting it to persist.** Map JSON is the source of truth; write runtime data to `entity.state`.
- **Don't run physics in `draw`.** It is called once per rendered frame, while `think` runs at a fixed 1/120s — stepping simulation in `draw` makes behaviour frame-rate dependent.
- **Don't use variable `dt` for verlet integration.** If you add your own particle system, step it at the fixed timestep like `ragdoll.js` does, or it will explode at low frame rates.
- **Don't add a `think` that loops over every entity every step** if the map is large. Cache what you need in `spawn`.
