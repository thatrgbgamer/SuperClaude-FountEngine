# Top-down and RPG games in Fount

Everything here is optional. A map with no `"mode"` is the first-person game it always was, and none of this code runs. Set `"mode": "topdown"` and the engine switches to a follow camera, a cursor-driven player, and an actor/ability/combat layer built for RPGs.

The engine provides the **mechanisms**: actors, damage, abilities, statuses, AI, navigation, particles, camera, picking, input. It ships no classes, items, loot, quests, dialogue or art. Those are the game's, written as JSON data and, where needed, `defineEntity` modules.

## Contents

- [Turning it on: config blocks](#turning-it-on-config-blocks)
- [Camera, picking, controls](#camera-picking-controls)
- [The pixel look](#the-pixel-look)
- [Actors](#actors)
- [Damage events](#damage-events)
- [Abilities](#abilities)
- [Effects](#effects)
- [Statuses](#statuses)
- [Monster AI and navigation](#monster-ai-and-navigation)
- [Factions](#factions)
- [Level transitions and carried state](#level-transitions-and-carried-state)
- [Events](#events)
- [Writing your own HUD](#writing-your-own-hud)
- [Input and rebinding](#input-and-rebinding)
- [Threat, scaling, PvP and fighting in groups](#threat-scaling-pvp-and-fighting-in-groups)
- [Looks and feel](#looks-and-feel)
- [Testing without a browser](#testing-without-a-browser)
- [Not built yet](#not-built-yet)

## Turning it on: config blocks

Settings can live in a game-wide file loaded once, and any map can override them. A map's block of the same name is merged key by key over the game's (`camera`, `render`, `player` and `nav` merge; other keys replace).

```js
// the game's index.html, before loading a map
await game.loadConfig('game/game.json');
await game.load('game/maps/hub.json');
```

```json
{
  "mode": "topdown",
  "camera":  { "pitch": 58, "yaw": 45, "ortho": true, "pixelsPerUnit": 16, "spriteTilt": 0.5 },
  "render":  { "resolution": [480, 270], "palette": ["#000000", "#1d2b53"], "dither": { "strength": 0.3, "size": 4 }, "textureSize": 32 },
  "player":  { "sprite": "hero", "health": 100, "speed": 5, "resources": { "mana": { "max": 50, "regen": 3 } }, "hotbar": ["strike", "bolt"] },
  "nav":     { "cell": 0.5 },
  "sprites": ["game/sprites/hero.json", "game/sprites/imp.json"],
  "abilities": "game/abilities.json",
  "statuses": "game/statuses.json",
  "particles": "game/particles.json",
  "relations": { "player|town": "friendly" },
  "keys": { "interact": ["KeyE"], "hotbar1": ["Digit1"] }
}
```

`sprites`, `abilities`, `statuses` and `particles` each take a URL to a JSON file or the data inline (`spriteDefs` is an inline array of sprite documents). Files are fetched once however many maps name them. `keys` is game-config only.

| Block | Keys |
|---|---|
| `camera` | `pitch` (5-89, default 58), `yaw` (45), `distance` (18, perspective), `fov` (38), `ortho` (false), `orthoHeight` (14) or `pixelsPerUnit`, `zoom`/`minZoom`/`maxZoom`, `wheelZoom` (false), `yawStep` (45; 0 locks rotation), `rotateSmooth`, `smooth` (9), `deadzone` (0.6 m), `focusHeight` (0.9), `spriteTilt` (0..1), `snap` (true) |
| `render` | See [The pixel look](#the-pixel-look) |
| `player` | `name`, `faction` ("player"), `health`, `resources`, `stats`, `resist`, `speed` (5), `radius` (0.35), `height` (1.7), `mass` (3), `sprite`, `spriteScale`, `hotbar` (ability ids), `clickToMove` (false), `facing` ("movement" or "mouse"), `primarySlot` (0), `respawnDelay` (3 s) |
| `nav` | `cell` (0.5 m), `top` (default: spawn height + 2.5), `minRegion` (80 cells), `enabled` |

Recommendation: **use `"ortho": true` with `pixelsPerUnit`**. Every ground pixel is then the same size on screen, which is what keeps chunky textures looking like pixel art instead of swimming with depth. Perspective works, but its texels shrink with distance.

## Camera, picking, controls

- `game.topCamera` follows the player with a deadzone and easing, and snaps to whole render pixels in orthographic mode so the world never crawls.
- **WASD moves relative to the camera** (W is screen-up). `camLeft` / `camRight` (`[` and `]`) rotate by `yawStep` degrees, eased.
- The mouse is free. There is no pointer lock, crosshair or viewmodel in this mode. `index.html`'s stock HUD hides its crosshair when `state.mode === "topdown"`; a game's own HUD simply doesn't draw one.
- `game.hover` is updated every frame: `{ inside, ground: [x,y,z] | null, actor | null, ray }`. `ground` is where the cursor ray hits the level (roofs and canopies higher than 2.5 m above the player are ignored, so a building's roof does not steal the click), falling back to the plane through the player's feet. `actor` is the nearest living actor under the cursor.
- `game.aimFor(player)` turns that into `{ dir, point, target }` for abilities. `target` is the hovered actor, else the last clicked target, else the nearest hostile within 12 m.
- With `"clickToMove": true`, the primary button walks to the clicked point along the nav grid, and the *secondary* button attacks. Otherwise the primary button attacks. Holding the attack button keeps using the `primarySlot` ability as fast as its cooldown allows.
- Hotbar keys `hotbar1`..`hotbar10` use `player.hotbar[n-1]`.
- `interact` (E) calls `interact(entity, world, player)` on the nearest entity within its `interactRadius` (default 2 m) whose class defines it, and emits `interact` either way. Dialogue and shops are the game's, built on this.

## The pixel look

All of it lives in the `render` block, and a map without one renders exactly as before.

| Key | Meaning |
|---|---|
| `resolution` | `[w, h]` internal size, e.g. `[480, 270]`. The frame is drawn at this size and enlarged with nearest-neighbour. This is the single biggest contributor to the look |
| `upscale` | `"integer"` (default: whole-number scale, letterboxed, so every pixel is the same size) or `"fit"` |
| `pixelSnap` | Default true. Snaps each sprite's anchor to a whole render pixel so moving characters do not shimmer |
| `palette` | Up to 64 `"#rrggbb"` colours. Every output pixel is one of them |
| `dither` | `false`, a number (strength), or `{ strength, size }` with size 2, 4 or 8 (Bayer matrix). Default strength 0.5 when there is a palette. Lower is cleaner: around 0.2-0.35 usually looks best |
| `levels` | With no palette, quantise each channel to this many levels instead |
| `textureSize` | Resolution of generated materials: 16, 32 or 64. A material's own `size` overrides it |
| `filter` | `"nearest"` (default with `resolution`), `"nearest-mip"`, or `"linear"` |
| `hardShadows` | Hard-edged shadows with no softening. Default true with `resolution` |
| `spriteMinLight` | Sprites never go darker than this (0.35) so characters stay readable in dim rooms |
| `shadowColor` | Colour multiplied over the ground by a sprite's blob shadow |

Dithering is applied to the final frame, so lighting, fog and shadow gradients all dither. The pattern is anchored to render pixels and does not move when the window resizes.

Animated materials, new generators and the `emissive` flag are in `map-format.md`.

## Actors

An **actor** is anything with health that acts: the player, a townsperson, a skeleton. Create one with `game.actors.spawn(options)`, or let an `actor_npc` entity do it from map JSON.

```js
const actor = game.actors.spawn({
  name: 'Warden', faction: 'enemy', feet: [4, 0, 6],
  health: 80, speed: 3, radius: 0.4, height: 1.7, mass: 1,
  resources: { mana: { max: 30, regen: 1 } },
  stats: { power: 8, critChance: 0.05 },
  resist: { fire: 0.25, frost: -0.5 },       // fraction ignored; negative is vulnerable
  sprite: 'warden', spriteScale: 1,
  corpseTime: 6,                              // seconds the body lingers (players never despawn)
  ai: { aggroRadius: 9 },                     // omit for a passive actor
});
```

Useful members: `position`, `feet`, `chest`, `facing` (unit [x, z]), `health`/`maxHealth`, `resources`, `stats`, `resist`, `statuses`, `cooldowns`, `casting`, `data` (anything JSON the game wants to keep on it), `sprite`, `ai`, `dead`.

Methods: `takeDamage(event)`, `heal(n, source)`, `addStatus(id | def, { source, duration, stacks })`, `removeStatus(id)`, `hasStatus(id)`, `die()`, `revive()`, `teleport(feetPos)`, `playAction('attack')`, `isHostile(other)`, `canAct()`, `canMove()`, `canCast()`, `cooldownRemaining(id)`, `snapshot()` / `restore(snap)`.

Control comes in through `actor.intent = { move: [x, z], face: [x, z] | null }`, set every step by the player controller or the AI. `move` is a vector with magnitude up to 1.

An actor emits its own events too (`actor.on('death', fn)`): `damage`, `heal`, `death`, `revive`, `kill` (it killed something), `status`, `cast-start`, `cast-cancel`, `ability`, `aggro`, `ai-state`.

The engine does not decide what a "class" is. Use `stats` for numbers abilities read, `data` for everything else (class name, inventory, xp), and your own code to grant abilities. All of `actor.data` survives level transitions.

## Damage events

Every hit, tick and explosion produces one event object, passed to `target.takeDamage(ev)` and then to the `damage` event:

```js
{ type: 'fire',          // 'physical' | 'fire' | 'frost' | 'holy' | 'shadow' | anything you invent
  amount: 24,            // after source-side scaling and crit
  final: 18,             // after the target's resistance and statuses (read it back from the event you passed)
  crit: false, killed: false,
  source: Actor | null,  // null for hazards and scripts
  target: Actor, ability: 'fireball' | null, kind: 'melee' | 'projectile' | 'area' | 'direct' | 'hazard' | 'dot' ..., point: [x, y, z] }
```

A hit always does at least 1 unless the target is invulnerable or in god mode. To bend damage, add a hook: `game.actors.combat.modifiers.push((ev, source, target) => { ev.amount *= ... })`. It runs after crit and before the target's own resistances.

Damage specs in JSON:

```json
{ "type": "fire", "amount": [18, 26], "scale": { "stat": "power", "mult": 0.5 }, "critChance": 0.1, "critMult": 2, "ignoreResist": false }
```

`amount` is a number or `[min, max]`. `scale` (one object or an array) adds `source.stats[stat] * mult`. The source's `critChance` stat adds to the spec's. `damageDealt` status multipliers apply to the source, `damageTaken` to the target.

## Abilities

An ability is JSON: a cooldown, a cost, an optional cast time, how it is aimed, and a list of [effects](#effects).

```json
{
  "id": "fireball", "name": "Fireball", "icon": "icon_fire",
  "cooldown": 3, "cost": { "mana": 12 }, "castTime": 0.45, "recovery": 0.1,
  "range": 14, "targeting": "direction",
  "anim": "cast", "sound": "cast",
  "effects": [{ "type": "projectile", "speed": 12, "sprite": "fx_orb", "tint": [1, 0.6, 0.2],
                "damage": { "type": "fire", "amount": [18, 26] } }]
}
```

| Field | Meaning |
|---|---|
| `targeting` | `self`, `target` (needs an actor in range), `ground` (a point; aimed past `range` it casts at the limit), `direction` |
| `range` | Metres, measured edge to edge |
| `hostile` / `friendly` | For `target` abilities: refuse a target of the wrong side |
| `castTime` | Seconds before the effects fire. The actor is rooted while casting unless `moveWhileCasting`; `interruptOnMove` cancels instead of rooting. Being stunned cancels, spending nothing |
| `recovery` | Seconds after the effects during which no other ability can start |
| `cost` | `{ resource: amount }`, paid when the cast completes |
| `cooldown` | Seconds; scaled by a `cooldown` status multiplier |
| `anim` | One-shot sprite animation. Default `cast` if there is a cast time, else `attack` |
| `sound` | Sound preset played when the effects fire |
| `effects` | See below |

Define them once per game: `game.abilityRegistry.define(table | def | [defs])`, or through the `abilities` config key. Use one: `game.actors.abilities.use(actor, id, { dir, point, target })` returns `{ ok, reason }` with reason `unknown`, `cannot-act`, `busy`, `cooldown`, `resource`, `no-target`, `range` or `not-hostile`. A failed player attempt also emits `ability-failed` so a HUD can say why.

For a HUD: `abilities.cooldownFraction(actor, id)` (1 right after use, down to 0) and `abilities.isReady(actor, id)`.

## Effects

Effects are the shared vocabulary of abilities, statuses and map scripts. Any effect may carry `delay` (seconds), `chance` (0-1) and `survives` (still runs if the source died).

| `type` | Does | Key fields |
|---|---|---|
| `damage` | Hurts the target | `damage` spec |
| `heal` | Heals the target (or the source with `self`) | `heal: { amount, scale, critChance }` |
| `status` | Applies a status | `status` id, `duration`, `stacks`, `self` |
| `melee` | An arc in front of the source, live for a short window; each actor hit once | `range` (edge to edge), `arc` (degrees), `window` (0.12 s), `hits`, `targets`, + a hit payload |
| `projectile` | A flying sprite | `speed`, `radius`, `gravity`, `lifetime`, `range`, `sprite`, `anim`, `scale`, `tint`, `homing: { turn }`, `pierce`, `pitch`, `spawnOffset`, `trail: { preset, interval }`, `onExpire`, `expireOnHit`, `targets`, + a hit payload |
| `area` | A circle or cone | `shape`, `radius`, `arc`, `duration`, `tick`, `follow`, `targets`, `maxTargets`, `falloff`, `height`, `fx`, + a hit payload |
| `knockback` | Shoves the target away | `strength` |
| `resource` | Gives or takes a resource from the source | `resource`, `amount` |
| `particles` | A burst | `preset`, `at` (`source`, `target`, `point`), `count` |
| `sound` | A sound preset | `name` |

A **hit payload** is what happens to each actor an effect touches: any of `damage`, `heal`, `status` (a string, an object, or a list), `knockback`, and `onHit` (a nested effect list run at the victim). `targets` is `hostile` (default), `ally`, `all` or `self`. Projectiles stop at walls and run `onExpire` there; with `expireOnHit` they run it on hitting an actor too, which is how a fireball explodes either way.

## Statuses

Timed buffs and debuffs, defined as data (the `statuses` config key, or `defineStatus(id, def)`):

```json
{
  "burning": {
    "duration": 4,
    "tick": { "interval": 1, "effects": [{ "type": "damage", "damage": { "type": "fire", "amount": 3 } }] },
    "mods": { "speed": 0.9, "damageTaken": 1.1, "resist": { "frost": -0.2 } },
    "flags": ["stun"], "stacking": "stack", "maxStacks": 3, "tint": [1, 0.6, 0.4]
  }
}
```

`mods` multiply per stack: `speed`, `damageTaken`, `damageDealt`, `cooldown`; `resist` adds per stack. `flags`: `stun` (cannot move or act), `root`, `silence`, `invulnerable`. `stacking`: `refresh` (default), `stack`, `ignore`, `replace`. Tick damage credits the actor that applied the status. Statuses defined in JS may also have `onApply(actor, status)`, `onTick(actor, status, dt)` and `onExpire(actor, status)`. A `duration` of `Infinity` makes an aura.

## Monster AI and navigation

`actor_npc` entities (and any actor spawned with `ai`) run a small state machine, tuned from map JSON:

`idle` and `wander` (drifting near home) become `notice` when a hostile comes within `aggroRadius`, then `chase`, then `attack`; they `leash` home when the target is lost, too far, or when the monster strays past `leashRadius`, healing on the way.

| Key | Default | Meaning |
|---|---|---|
| `aggroRadius` | 8 | Notice hostiles this close (edge to edge) |
| `loseRadius` | 14 | Give up the chase this far from the target |
| `leashRadius` | 20 | Never stray this far from home |
| `noticeTime` | 0.35 | Seconds of "!" before chasing |
| `wanderRadius`, `wanderPause`, `wanderSpeed`, `canWander` | 3, [1.5, 4], 0.45, true | Idle drifting |
| `senses` | `"los"` | `"los"` needs line of sight to notice; `"radius"` does not |
| `groupAggro` | 0 | Radius in which same-faction allies join the fight |
| `attackRange` | 1.6 | Reach, edge to edge |
| `preferRange` | none | Ranged units back off when the target is closer than 60% of this |
| `attackAbility` | none | An ability id to use as the attack |
| `attack` | | Inline attack if there is no ability: `{ damage, interval, windup, arc, knockback }`, or add `projectile: { speed, sprite, ... }` for a ranged one |

Events: `aggro` fires once when a monster notices someone; `ai-state` on every change.

**Navigation is baked from the level's own brushes at first use** (a trace down through the same collision world everything else uses), so there is nothing to author. Limits to know: it is one walkable layer under `top` (default: the player start's height + 2.5 m), so roofs above that are ignored but a second storey below it is not seen; ramps and stairs up to 45 degrees connect; small disconnected patches (wall tops, crates) are dropped as unreachable; moving brushes such as doors are not in the grid. Monsters do not avoid `func_hazard` volumes.

`game.actors.nav.findPath(from, to, { exact })` returns waypoints; `isWalkable(x, z)`, `lineClear(a, b)`.

## Factions

Different factions are hostile by default; `neutral` fights nobody. Override per pair: `game.relations.set('player', 'town', 'friendly')` (or `relations: { "player|town": "friendly" }` in config). Hostility decides who AI notices, who melee, projectiles and areas can hit (`targets: hostile` default), and who `ally` effects heal. Change `actor.faction` at runtime for charm and raise-dead effects.

## Level transitions and carried state

`trigger_changelevel` calls `game.travel(map, landmark)`: fade out, load the map, put the player at the destination's `info_landmark`, fade in. The player's actor is snapshotted first and restored on arrival: health, resources, stats, statuses, cooldowns, `data` and the hotbar all carry. `game.load(map, { landmark, carry })` is the same thing without the fade. If the new map fails to load, the old one is untouched and `travel-failed` is emitted.

For saving a character: `JSON.stringify(game.player.actor.snapshot())` is plain JSON, and `actor.restore(snap)` reads it back.

## Events

`game.events` is an emitter that outlives any one map. The engine's own reactions (damage numbers, hit particles, sounds, the "!" over an alerted monster) are ordinary listeners; add yours the same way, or replace the defaults by setting `game.damageNumbers = false` / editing `game.damageColors`.

| Event | Arguments |
|---|---|
| `damage` | the damage event |
| `heal` | `{ target, source, amount, crit }` |
| `death` | `(actor, damageEvent)` |
| `status` | `(actor, status, 'apply' \| 'expire')` |
| `cast-start`, `cast-cancel`, `ability` | `(actor, abilityDef, aim)`; cancel gets a reason |
| `ability-failed` | `{ id, reason, actor }` |
| `melee`, `hit` | `{ source, spec, dir }`, `{ source, target, event, spec, ctx }` |
| `projectile-spawn`, `projectile-hit`, `projectile-end` | the projectile record, `(p, target)`, `(p, why)` |
| `fx`, `sound` | `{ preset, pos, count }`, `{ name, pos }` |
| `aggro`, `ai-state` | `(actor, target)`, `(actor, next, prev)` |
| `spawn`, `remove` | `(actor)` |
| `map-loaded`, `travel`, `travel-failed`, `respawn`, `interact` | `{ name, mode, landmark }`, `{ map, landmark }`, ... |

Handlers that throw are logged and do not stop the simulation.

## Writing your own HUD

The engine draws no HUD. `new Game(canvas, hud)` takes any object with `update(state)`, called every frame; build the DOM however you like. `state` has the old first-person fields plus:

```js
state.mode          // 'fps' | 'topdown'
state.cursor        // 'free' | 'locked'
state.fade          // 0..1, the transition fade, if you want to draw your own
state.player        // null in fps mode, otherwise game.getHudState():
```

```js
{ name, health, maxHealth,
  resources: { mana: { value, max } },
  hotbar: [{ slot, id, name, icon, key: 'W' | '1', cost, cooldown /* 1 -> 0 */, cooldownRemaining, ready }],
  casting: { id, name, progress } | null,
  statuses: [{ id, remaining, duration, stacks }],
  target: { name, health, maxHealth, faction, hostile, dead } | null,
  hover:  { ... } | null,
  data }                                // actor.data: your class, inventory, ...
```

Anything else (party frames, nameplates, a chat log) comes from `game.actors.actors` and `game.events`. For text that matches the in-world font, see `<fount-text>` in `sprites-and-audio.md`.

## Input and rebinding

Game code asks for actions, never keys. `game.input` has `isDown(action)`, `pressed(action)` (true once per press, however many physics steps run in a frame), `bind(action, codes)`, `add`, `remove`, `reset()`, `describe(action)` ("W / UP", for showing a binding), `rebind(action)` (a promise that resolves with the next key pressed; Escape cancels), and `save()` / `load()` to keep rebinds in `localStorage` (loaded automatically; saved bindings win over the game's defaults).

Actions: `forward back left right jump fire primary secondary interact inventory chat camLeft camRight hotbar1`..`hotbar10`. Mouse buttons are `Mouse0` (left), `Mouse1`, `Mouse2` (right). A game invents more by binding any name and calling `isDown`/`pressed` on it.

## Threat, scaling, PvP and fighting in groups

These matter when several players share a fight; the full server side is in `multiplayer.md`.

- **Threat.** Every monster with AI keeps `ai.threat` (actor to number). Damage adds its final amount times the ability's `threat` multiplier, healing a monster's enemy adds half the heal, and the monster fights whoever has the most, swapping only for 10% more in melee or 30% more at range. The effect `{ "type": "threat", "amount": 200, "mult": 1, "taunt": true }` adds, scales or takes the top (`self: true` applies to the caster). The table clears when the monster goes idle. With one player this changes nothing.
- **Friendly targets.** `"targeting": "target", "friendly": true` works on any friendly actor, including other players; `"area"` effects take `"targets": "ally"` (`"includeSource": true` to include the caster).
- **Scaling layers.** `actor.setScale('key', { hp, damageDealt, damageTaken, speed })` multiplies by a named layer and `setScale('key', null)` removes it. Health keeps its fraction; `snapshot()` records unscaled values. Wading in `func_water`, a boss scaled for a bigger group and a high-level player sidekicked down all use it.
- **Player versus player.** Two players are friends unless the map's PvP mode (`off`, `free`, `flagged`, `teams`) or a duel says otherwise; set `system.pvp = new Pvp({ mode })` (`engine/pvp.js`) to use it offline. See `multiplayer.md`.

## Looks and feel

- **Camera cut-away.** In top-down mode, scenery between the camera and the player is dithered away within a radius of the sight line, so a wall never hides the player. On by default; `"camera": { "occlusionFade": false }` turns it off and a number sets the radius in metres (2.2). Floors at the player's own height are never cut. For any other focus point, `renderer.setFocus(pos, radius)`.
- **UV-scrolling materials.** A material may carry `"scroll": [0.05, 0.02]` (uv units per second): flowing water, conveyor belts, drifting clouds.
- **Decals.** `game.decals.add('splat', [x, y, z], { size: 1.2, life: 30, fade: 5, tint })` lays a sprite flat on the ground (scorch marks, blood, footprints). It pixelates, lights and fogs with the scene. At most 300 live; the oldest are replaced.
- **Palette swaps.** `spriteLibrary.variant(name, { r: '#2040c0' })` (a palette character) or `{ '#aa0000': '#0000cc' }` (an old colour) makes a cached recoloured sprite and returns its name; `spriteInstance.setPalette(swap)` recolours in place, keeping the animation. Putting `publicData.palette = swap` on an actor makes every client that sees it draw it recoloured.
- **Paper dolls.** `actor.publicData.layers = [{ sprite: 'hair', palette: {...} }, { sprite: 'cloak', order: 'under' }]` stacks sprites that follow the body's animation and facing, so gear shows without a sprite per combination. Layers only need the same animation names and frame counts as the body.
- **World clock.** `game.clock.sample()` (hour, daylight, season, tide) from one number that is shared online; `game.clock.lighting(env)` tints an environment for the hour. `func_water` follows the tide. See `multiplayer.md`.
- **Name plates and bubbles.** `game.nameplates` draws names, health bars and chat bubbles over actors online.
- **Music.** `game.music.play('town', { fade: 1.5 })` plays a tracker-style song defined in the game config; see `sprites-and-audio.md`.
- **Sprite-sheet preview.** Open `sprites.html` (`?config=game/game.json`) to see every sprite, animation and direction, animated, with a palette-swap box.

## Testing without a browser

Actors, combat, abilities, statuses, AI and navigation import no DOM or GL, so they run in plain Node. A throwaway test builds a collision world from brushes with `buildMap({ name, brushes }).collision`, creates an `ActorSystem({ collision })`, and calls `system.update(1/120)` in a loop. `apps/fount/tests/rpg.test.mjs` is a worked example covering every system on this page. Run with `node apps/fount/tests/rpg.test.mjs`.

## Not built yet

Online play (server-authoritative actors, instances, parties, persistence) is in `multiplayer.md` and `persistence.md`. Still absent: UI panel kits, palette preview in the editor, mounts, and a `hideWhenOccluding` flag for individual brushes (the camera cut-away is global). A map that needs one of these today should do it with a `defineEntity` module and the events above.
