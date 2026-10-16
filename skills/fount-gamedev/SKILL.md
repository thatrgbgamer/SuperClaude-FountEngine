---
name: fount-gamedev
description: Builds and edits games in the Fount engine bundled with this repo at apps/fount — a dependency-free WebGL2 FPS engine whose levels, entities, materials and sounds are all plain text. Use when the user wants to make or change a game, level, or map in Fount: adding rooms or arenas, placing enemies, wiring level logic (doors, triggers, timers, explosions), tuning weapons or movement, adding new entity behaviours, or debugging why something in the level does not work. Also covers running a Fount game as a multiplayer server and its admin commands. Triggers on "add a level", "make a map", "place some enemies", "add a door that opens when", "the ragdolls look wrong", "build me a game", "host a Fount server". Do not use for game development in another engine (Unity, Godot, Unreal, Phaser, three.js), for general game-design discussion with no code change, or for editing the Fount engine's own internals under apps/fount/engine — that is ordinary code work on this repo, not level authoring.
version: 0.1.0
---

# Fount game development

Fount lives at `apps/fount/`. It is a small FPS engine with brush-based levels, a Source-style entity IO system, and verlet ragdolls. Everything a game is made of — geometry, logic, materials, sound — is text you can write directly.

## Why this engine exists

**Authoring happens here, in this session. The game runs with zero API calls.** You write JSON and JS; the engine reads them and runs offline, forever, with no key, no network, and no per-play cost. Never add a runtime AI or paid-service call to a Fount game — it would trade the engine's entire reason for existing for a feature you can bake in at authoring time instead.

Multiplayer is not an exception to that. A Fount server is the game's own process, self-hosted and free to run; single-player still needs no network at all. The rule is about depending on somebody else's paid API at play time, not about sockets.

That constraint is why the engine has no binary assets: textures are generated from material parameters and sounds are synthesised from presets, so a complete game is diffable, reviewable text.

## Preferences

Load preferences before writing content: check `.claude/preferences.yaml` (project), then `~/.claude/skills-preferences.yaml` (global), then `config/defaults.yaml` (repo fallback) — use the first one found. None found is normal. Relevant here: `voice.verbosity` for how much you explain a change, and `stack`/`workflow` for whether to run checks before proposing. Code style in game scripts follows the engine's existing conventions regardless of preferences. Full contract: `shared/preferences-loader.md`.

## Run it

```sh
cd apps/fount && python3 -m http.server 8099
```

Then open `http://localhost:8099/` to play, or `http://localhost:8099/editor/index.html` to edit visually. ES modules need a real HTTP origin — opening `index.html` from the filesystem will fail.

The loop is: edit a file → refresh the browser. No build step, no compile, no asset pipeline.

Press `` ` `` in game for the console. While authoring, the commands that earn
their keep are `noclip` and `teleport x y z` (reach the part of the level you
just changed without walking there), `where` (read out coordinates to paste into
map JSON), `ent` (what actually loaded), `spawn <classname>` (try an entity
before committing it to the file), and `fire <target> <input>` (drive an IO
connection by hand to see whether the wiring or the trigger volume is at fault).
`restart` reloads the map without a page refresh.

## A game of its own, in its own repo

`apps/fount/game/` holds the engine's demo maps. When someone is building an
actual game rather than tweaking the demos, give it its own repository:

```sh
python3 tools/new_fount_game.py ../their-game --name "Their Game"
```

That vendors the engine and the multiplayer server (no dependencies, so a copy is
simpler and more robust than a submodule), adds a starter level, shell, editor,
`run.sh` and `serve.sh`, and makes a git repo with a first commit. It pushes
nothing; it prints the remote steps.

It also installs this skill at `.claude/skills/fount-gamedev/` inside the new
project, which is what carries Fount knowledge across: a Claude Code session
opened on that repo finds it as a project skill and already knows the map format
and entity library, with SuperClaude nowhere in sight.

Use `--vendor-only` to add Fount to a repo that already exists, and `--update`
to refresh a vendored engine later (it touches only `engine/`, `server/` and the
skill, never the game's own content).

## Multiplayer

A Fount game can host its own server, and because the server is vendored into the
game's repo, deploying is `git clone && ./serve.sh` on any box with Node 18+ —
there is nothing to build and nothing to `npm install`.

```sh
./serve.sh --name "Their Game"          # serves the game AND hosts the session
```

Players type `connect` in the console; the terminal running the server is the
admin console (`status`, `kick`, `ban`, `map`, `say`, `anticheat`). The engine
README's multiplayer section covers tunnels, reverse proxies and a systemd unit.

That server (`server/server.mjs`) is for first-person games. A top-down / RPG game online uses `./serve.sh --online` (`server/mmo.mjs`): server-authoritative actors, accounts and saved characters, instances, parties and chat, with an admin console and HTTP admin API. Read `references/multiplayer.md` and `references/persistence.md` for it. Verify online behaviour headlessly with the Node bots in `apps/fount/tests/` (`e2e.test.mjs` is the worked example), not by clicking through two browser windows.

Server-side validation is on by default (`--anticheat off|lenient|normal|strict`).
If a game's own scripts launch players faster than ordinary movement — jump pads,
cannons — raise the speed cap or run `lenient`, or those launches will trickle
harmless points into honest players' scores.

Two things to keep in mind when authoring for it:

- **Design maps for it deliberately.** Multiple `info_player_start` entities give
  players somewhere to spawn apart from each other; one spawn point means people
  materialise on top of one another.
- **The server validates; it does not simulate.** It owns health, damage, death
  and scoring, re-traces every shot against the real map with lag compensation,
  and corrects movement that passes through geometry. What it does not do is
  reproduce movement from inputs or analyse behaviour, so a cheat that stays
  inside the rules is not caught. Say that plainly if someone asks about
  anti-cheat, rather than implying protection that isn't there — and point them
  at the engine README's Anticheat section, which draws the line exactly.
- **Cheat console commands are blocked on servers by default.** `noclip`, `god`,
  `give`, `teleport` and the physics cvars only work in single-player, or on a
  server started with `--cheats`. If someone reports that noclip "stopped
  working", that is why.

## Where things live

| Path | What |
|---|---|
| `game/maps/*.json` | Levels. One file per map, read directly at runtime |
| `game/scripts/*.js` | Custom entity behaviours for a specific game |
| `game/sprites/*.json`, `game/abilities.json`, `game/game.json` | Top-down games: sprites, abilities and the game-wide config (conventional names, wired up in the config) |
| `engine/` | The engine itself. Don't edit this to build a game |
| `server/` | Multiplayer server. Likewise — vendored, not game content |
| `editor/index.html` | In-browser editor: fly around, select, edit, export JSON |
| `index.html` | Game shell and HUD; the map list lives here |

Read the reference file for the job at hand rather than guessing at schema:

- **`references/map-format.md`** — brush types, materials, sky/lighting, coordinate system, and a scale table so rooms feel right.
- **`references/entities.md`** — every built-in classname, its keyvalues, and its inputs/outputs, plus how the IO system routes events.
- **`references/custom-behaviors.md`** — `defineEntity`, the engine services available to behaviours, and two worked examples.
- **`references/rpg.md`** — top-down / RPG games: the camera, the pixel-art render pipeline, actors, damage, abilities, statuses, monster AI, level transitions, events, and how to write a game's own HUD.
- **`references/sprites-and-audio.md`** — the text sprite format, particles, the bitmap font, `<fount-text>`, every sound preset, the tracker-style music sequencer, palette swaps and the sprite-sheet preview page.
- **`references/multiplayer.md`** — online top-down games on `server/mmo.mjs`: the server-authoritative model, `defineEntity` server/client halves, the `world.context` API, hooks, instances and portals, interest management, parties, chat, threat, PvP, the world clock, and running a server (admin console and API, metrics, backups, load test).
- **`references/online-migration.md`** — moving a working single-player game onto the online server: the server/client entity split, the `world.context` changes, what a character save contains, hooks, and a checklist.
- **`references/persistence.md`** — accounts, characters, the HTTP API, stores (sqlite, file, custom), the save record and `actor.snapshot()` interface, versioning, the gold economy and ledger, backups.

## Top-down and RPG games

Setting `"mode": "topdown"` (in a map, or game-wide with `game.loadConfig()`) turns Fount into a pixel-art sprite RPG engine: a follow camera, cursor-driven player, low-resolution palette-and-dither rendering, billboarded text sprites, and a generic actor / ability / status / AI layer. Read `references/rpg.md` first. The engine supplies mechanisms only. Classes, items, quests and art are the game's, as JSON data and `defineEntity` modules. Sprites are authored as text; see `references/sprites-and-audio.md`. Verify combat, abilities and AI headlessly in Node (`apps/fount/tests/rpg.test.mjs` is a worked example) before reporting them done.

## Building a level

Work in this order. It front-loads the decisions that are painful to change later.

1. **Decide the shape of the space first**, in metres, using the scale table in `references/map-format.md`. A level that is the wrong size is far more work to fix than one that is the wrong colour.
2. **Floor, then walls, then a ceiling if it is interior.** Make the floor larger than the playable area and put walls *outside* its edge so there is no gap at the seam.
3. **Add verticality** — a ledge with a ramp, a catwalk, a platform. Flat rooms play badly and hide the movement system's best quality.
4. **Place `info_player_start` on a clear patch of floor**, `y` just above the floor surface. Check that no brush occupies that spot; a spawn inside geometry is the single most common authoring bug. The engine will report it in the HUD and lift the player out, but that is a safety net, not a fix.
5. **Light it.** Set `sky.ambient` high enough that interiors read (below ~0.2 they go black), then add `light` entities for anywhere that needs shape. Max 16 active.
6. **Then populate**: NPCs, props, pickups.
7. **Then wire logic** with `connections`.

Give a `name` only to entities something targets. Unnamed entities are fine and keep the file readable.

## Wiring logic

Level behaviour is declarative — an output on one entity routed to an input on another, optionally delayed. This is the part worth reaching for before writing any JS, because most mechanics are expressible without code.

```json
{ "classname": "trigger_multiple", "name": "trig_ambush", "wait": 999,
  "connections": [
    { "output": "OnStartTouch", "target": "ambush_door", "input": "Open" },
    { "output": "OnStartTouch", "target": "ambush_guards", "input": "Enable", "delay": 0.4 },
    { "output": "OnStartTouch", "target": "alarm_light", "input": "SetBrightness", "param": "2.5" }
  ] }
```

Three things to remember:

- A `trigger_multiple` has no bounds of its own. Its volume is a brush with `"trigger": true` and **the same `name`**. Omitting that brush is a silent no-op.
- Several entities may share one `name`; an output then drives all of them at once. That is how `ambush_guards` above enables a whole squad.
- `delay` replaces timer bookkeeping. Stagger a sequence by giving successive connections increasing delays.

## Ragdolls

`npc_grunt` ragdolls on death automatically — no setup. The body inherits the NPC's velocity at the moment of death and takes the killing impulse at the point of impact, so a headshot snaps the head back, a body shot folds the torso, and an NPC killed while running tumbles onward. Bodies collide with the world, take later bullets, and get thrown by `env_explosion`.

To drop a body on a script cue, send `Damage` with a large `param`:

```json
{ "output": "OnTimer", "target": "guard_1", "input": "Damage", "param": "999" }
```

To test the physics with no NPC involved, use `point_ragdoll` and its `Spawn` input.

If ragdolls look wrong, the cause is usually one of: an NPC spawned inside geometry (the body starts penetrating and gets shoved out), `sky.ambient` so low the body is invisible rather than absent, or `maxRagdolls` retiring an older body you were watching. Check those before touching `engine/ragdoll.js`.

## Verify before you claim it works

A map that parses is not a map that plays. At minimum:

```sh
python3 -c "import json; json.load(open('apps/fount/game/maps/YOUR_MAP.json')); print('valid JSON')"
```

Then load it in a browser and confirm: the player spawns standing on the floor (not lifted, no HUD warning), you can reach every area you intended, the logic you wired actually fires, and nothing renders pure black that shouldn't. If you cannot run a browser, say so plainly rather than implying the level was played.

Add a new map to the `MAPS` array in both `index.html` and `editor/index.html` or it won't be selectable.

## Common failures

| Symptom | Cause |
|---|---|
| Player stuck at spawn, HUD shows a warning | `info_player_start` inside a brush |
| Trigger never fires | No brush with `"trigger": true` and a matching `name` |
| A surface or whole room is black | `sky.ambient` too low and no `light` nearby — expected, not a bug |
| Ramp leaves a step at the top | Ramp's `max[1]` doesn't match the platform's top surface, or `dir` is reversed |
| Brush invisible or missing | `min` not componentwise less than `max`, or a zero-thickness axis |
| Door stays partly in the doorway | `distance` smaller than the slab's travel needed to clear it |
| Everything is one flat colour | `materials` was defined but brush `material` names don't match any entry |
| Nothing loads, console shows CORS/module errors | Opened from `file://` instead of an HTTP server |
