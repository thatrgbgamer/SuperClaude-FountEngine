# Moving a single-player game onto the online engine

Read this when you have a top-down game that already works offline and want it to run on `server/mmo.mjs`. Single player is unchanged: nothing here breaks an offline game, and the same code runs both ways. `multiplayer.md` and `persistence.md` are the reference; this is the path.

## 1. Get the engine

From the engine repo, into the game repo:

```
python tools/new_fount_game.py <game-repo> --update --editor
```

`--update` refreshes `engine/`, `server/` and `.claude/skills/fount-gamedev/`. `--editor` also refreshes `editor/index.html` (keeping your map list) and adds `sprites.html`. Your `index.html` and `game/` are never touched. Then:

```
node --no-warnings server/mmo.mjs --root . --config game/game.json --port 8099
```

Add `"server": { "startMap": "game/maps/<your hub>.json" }` to the game config. Click "Play online" or open `index.html?online=ws://host:8099`. With no other change the game plays online, because the engine's own entities and player already run on the server.

## 2. Entity classes: split into a server half and a client half

A class written the old way keeps working: online it runs on the server only, and the client calls just its `draw()` with the replicated state. That is fine for scenery. For anything that decides something (a boss, a shop, a puzzle, a pickup), split it:

```js
// before
defineEntity('my_chest', {
  spawn(e) { e.state.open = false; },
  think(e, world, dt) { /* open when the player is near; award loot */ },
  draw(e, renderer) { /* draw open or closed */ },
});

// after
defineEntity('my_chest', {
  server: {
    spawn(e) { e.state.open = false; },
    think(e, world, dt) {
      for (const p of world.context.playersInRadius(e.origin, 1.5)) {
        const mine = e.stateFor(p.id);                  // private per-player state
        if (!mine.opened) { mine.opened = true; /* grant loot to p */ }
      }
    },
    replicate(e) { return { open: e.state.open }; },    // what clients are told
  },
  client: {
    spawn(e, world) { e.state.layer = world.context.materialIndex.get('wood') ?? 0; },
    draw(e, renderer, shadowPass) { /* draw from e.state */ },
  },
});
```

The rules: the **server** half owns anything that matters (state, damage, rewards, timing); the **client** half does appearance only (draw, particles, sound). `world.context.player` (the single player) no longer exists on a server: use `world.context.players` and the helpers below, and treat the player an input gives you as the activator. In single player both halves run on the one entity, so nothing needs two versions.

## 3. `world.context`: what to replace

| single player habit | use instead |
|---|---|
| `world.context.player` | `world.context.players` (an array), `playerOf(actor)`, `playersInRadius(point, r)`, `playersInBox(min, max)` |
| edit `player.actor.data.gold` | `world.context.economy.grant / spend / transfer` |
| `game.travel(map, landmark)` | `world.context.travel(player, map, landmark)` |
| show a toast to "the" player | `player.notify('toast', { text, color })` (one player), or `world.context.events.emit('toast', ...)` (everyone in the instance) |
| give XP to the player | `world.context.parties.shareXp(player, total, (member, share) => ...)` |
| spawn loot | `world.context.encounters.dropLoot(entity, { mode: 'personal', recipients })` |
| `Math.random()` for combat | leave combat to the engine's seeded rolls; use `world.context.worldTime()` for anything that must agree between players |
| `game.renderTime` | `game.worldTime` / `world.context.worldTime()` |
| per-map globals | `instance.worldState` on the server; entity `state` otherwise (module-level variables are shared across every instance on a server) |

Module-level mutable state in a script is the usual porting bug: on a server, one module serves every instance and every player.

## 4. Character state: what is saved

A character is saved as:

```js
{ snapshot: actor.snapshot(), position: { map, feet, yaw }, savedAt }
```

`actor.snapshot()` holds `name, health, maxHealth, resources, stats, statuses, cooldowns, data`; `actor.restore(snapshot)` is its inverse and is also what a portal carries between maps. Rules for your game:

- Keep all persistent player state in **`actor.data`** (level, xp, gold, inventory, quest flags, learned abilities). Anything there is saved, replicated to that player, and carried through portals.
- Keep it plain JSON: numbers, strings, arrays, objects. No functions, no class instances, no references to actors.
- Gold changes go through the economy. Do not write `actor.data.gold` yourself.
- Set `server.characterVersion` and write a `migrateCharacter(record, from, to)` hook when the shape of `data` changes.
- Anything everyone nearby should see (level, title, a palette, equipment layers) goes in `actor.publicData`, which replicates with the actor and is saved by nobody.

## 5. Hooks (in a server script)

```js
export const hooks = {
  playerConfig({ name, class: cls }) { return { health: 120, hotbar: ['strike'] }; },   // per-class setup
  classes: () => ['warrior', 'ranger', 'mage'],
  characterCreated(c) {},
  migrateCharacter(record, from, to) { return record; },
  playerJoined(instance, player) {},
  actorDied(instance, actor, killer) {},
  scalePlayer(instance, player) { return null; },
};
```

List the script as `"scripts": { "server": ["game/server.js"], "shared": [...] }`. `shared` scripts also load in the browser; `server` scripts load only in Node and must not touch `window`, `document` or `localStorage` at load time. `multiplayer.md` lists every hook.

## 6. Abilities and combat

Ability JSON is unchanged. Online, the client only asks to use an ability on its hotbar; the server checks everything. Two things to know: abilities a player may use are those on their `hotbar` (or in `actor.data.abilities`, or all of them with `server.openAbilities`), and friendly abilities now work on other players (`"friendly": true`, `"targets": "ally"`). Monsters get threat tables for free; set `"scales"` and `"resetOnWipe"` on bosses.

## 7. UI

`game.getHudState()` has the same keys online and offline, so one HUD serves both; it adds `party`, `invitation`, `clock` and `online`. New game events to listen for: `chat-line`, `party-changed`, `party-invite`, `duel-invite`, `emote`, `disconnected`, `reconnecting`, `reconnected`, `online-ended`. Drive the title screen from `game.flow` (title → login → characters → loading → playing) and `AccountClient`. Name plates, health bars and speech bubbles are drawn by the engine; turn them off with `game.nameplates.enabled = false` if you draw your own.

## 8. Test it without a browser

Copy the shape of `tests/e2e.test.mjs` from the engine repo: start `startServer({ root, port: 0, quiet: true })`, create accounts through `AccountClient`, join with `Bot`, and assert on what the server and the bots see. Run `node server/loadtest.mjs --bots 50` before you ship a hub.

## Checklist

- [ ] `--update --editor` run, `server.startMap` set, the game plays online with no other change
- [ ] every entity that decides something has a `server` half; no module-level game state
- [ ] persistent player state lives in `actor.data` as plain JSON; gold goes through `economy`
- [ ] `characterVersion` and `migrateCharacter` in place before the first release
- [ ] maps declare an `instance` policy (shared hub, static town, party dungeon)
- [ ] HUD reads `getHudState()`; screens driven by `game.flow`
- [ ] an `e2e`-style headless test, and a load test for the busiest map
