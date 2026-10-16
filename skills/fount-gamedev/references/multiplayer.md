# Online play: server-authoritative top-down games

This is for top-down / RPG games (`"mode": "topdown"`) that run on a server. The older first-person deathmatch server (`server/server.mjs`) is separate and unchanged. Everything below belongs to `server/mmo.mjs`, which serves the game's files and the shared world on one port.

The engine supplies mechanisms (instances, replication, accounts, parties, chat, threat, PvP, admin). It has no opinion about classes, items, quests, bosses or art; those stay in the game's JSON and scripts.

## Contents

- [The model](#the-model) · [Running a server](#running-a-server) · [Playing from the client](#playing-from-the-client)
- [Entities on a server](#entities-on-a-server) · [The world context](#the-worldcontext-api) · [Hooks](#server-hooks)
- [Instances and portals](#instances-and-portals) · [Interest and bandwidth](#interest-management-and-bandwidth)
- [Parties and chat](#parties-chat-emotes-and-name-plates) · [Combat together](#fighting-together) · [PvP](#pvp-and-duels)
- [The world clock and water](#the-world-clock-and-tides) · [Operating a server](#operating-a-server)
- [Testing](#testing-headlessly) · [Limits](#limits-and-what-is-not-here)

## The model

The server runs the game. A client sends **intents** and the server decides what happens.

- **Sim rate.** The world steps at 120 Hz. Clients send a movement command at 30 Hz (`{t:'i', q, mv, f}`: a sequence number, a move vector, a facing), and the server answers with a snapshot at 30 Hz. Each command covers four physics steps.
- **Never trust a number.** Every message is parsed by `engine/protocol.js`, which clamps or refuses anything out of range. A client cannot name a position, a damage value or a hit. It says "use `strike` toward here" and the server checks cooldown, cost, range, line of sight and that the ability is on its bar.
- **Prediction.** The client moves its own character at once with the same `stepMovement()` the server runs, and replays unacknowledged commands on top of each snapshot. When the server agrees (it nearly always does) nothing visibly happens. Other players and monsters are interpolated 100 ms in the past.
- **Per-client deltas.** Each client is told only what changed since its last snapshot, and only about what is near it.
- **One process, many instances.** An instance is one running copy of a map. The same map can have many copies (a hub per 30 players, a private dungeon per party).

## Running a server

```
node server/mmo.mjs --root . --port 8099                    guests, nothing saved: fine for development
node server/mmo.mjs --root . --auth required --admin-token <16+ chars>
./serve.sh --online --auth required                          the same, from a game repo
```

The game config names the start map: `"server": { "startMap": "game/maps/hub.json" }`. `node server/mmo.mjs --help` lists every flag; each has a `FOUNT_*` environment variable (`FOUNT_PORT`, `FOUNT_AUTH`, `FOUNT_STORE`, `FOUNT_DATA`, `FOUNT_ADMIN_TOKEN`, `FOUNT_MAX_PLAYERS`, `FOUNT_LOG_JSON`, ...) and `--server-config file.json` takes them as a file. Flags beat environment, which beats the file.

**Auth modes.** `none`: anyone joins as a guest and nothing is saved. `optional`: guests, or a logged-in character that is saved. `required`: a login and a character to play.

`server` config keys (in the game config's `"server"` block):

| key | meaning |
|---|---|
| `startMap` | where new players begin |
| `viewRadius` / `interestMargin` / `bandwidth` | interest management (see below); a map's `instance` block can override |
| `partySize` | members per party (5) |
| `sayRadius` | metres a `say` carries (40) |
| `chatRates` | per-channel limits, `{ say: [6, 6000] }` = 6 messages per 6 s |
| `emotes` | allowed emotes, `{ "wave": "waves." }`; default has eight |
| `scaling` | encounter scaling tables (see Fighting together) |
| `pvp` | default PvP mode: `off`, `free`, `flagged`, `teams` |
| `maxCharacters`, `characterVersion`, `goldField`, `autosaveSeconds`, `openAbilities` | see persistence.md |

## Playing from the client

```js
const acct = new AccountClient();                          // engine/account.js: same origin as the page
await acct.login(name, password);                          // or register(); tokens persist in localStorage
const { characters } = await acct.characters();
await acct.createCharacter('Brightblade', 'warrior');
await game.flow.enter(acct, characters[0].id);             // loading → playing
// or, without accounts:  await game.playOnline('ws://host:8099', { hello: { name: 'Ada' } });
```

`game.flow` is a small state machine (`boot → title → login → characters → loading → playing → disconnected`) with an event per state; the engine draws none of the screens. `game.goOffline()` returns to single player. The same game code runs both ways.

Things a game's UI reads or calls:

| object | what |
|---|---|
| `game.getHudState()` | the same keys online and offline (health, resources, hotbar, target, party, invitation, clock) |
| `game.chat` | `lines`, `say()`, `whisper()`, `send(channel, text)`, `emote()`, `ignore()`, `report()`, `submit("/w Bob hi")` |
| `game.parties` | `state`, `invitation`, `invite()`, `accept()`, `decline()`, `leave()`, `kick()`, `promote()`, `disband()` |
| `game.pvp` | `flag()`, `unflag()`, `duel(name)`, `acceptDuel()`, `yield()` |
| `game.clock` | `sample()`: hour, daylight, season, tide |
| `game.nameplates` | engine-drawn names, bars and speech bubbles; `options`, `colorFor` |
| `game.events` | `chat-line`, `party-changed`, `party-invite`, `duel-invite`, `duel-start`, `emote`, `disconnected`, `reconnecting`, `reconnected`, `online-ended`, plus the usual `damage`, `death`, `toast` |

A dropped connection reconnects on its own with the resume token for up to 8 attempts, back into the same instance, party and position (the server keeps the player for `reconnectGraceSeconds`, default 20).

## Entities on a server

An entity class has two halves. The server half owns the truth; the client half draws it.

```js
defineEntity('my_beacon', {
  server: {
    spawn(e, world)  { e.state.lit = false; },
    think(e, world, dt) { /* runs on the server only */ },
    inputs:   { Light(e, world, activator) { e.state.lit = true; world.fireOutput(e, 'OnLit', activator); } },
    interact(e, world, player) { world.sendInput(e.name, 'Light', player); },
    replicate(e, world) { return { lit: e.state.lit }; },     // what clients are told (default: plain state)
    visibleTo(e, player) { return true; },                     // per-player visibility
  },
  client: {
    spawn(e, world) { e.state.layer = world.context.materialIndex.get('metal') ?? 0; },
    think(e, world, dt) { /* cosmetic only: particles, sound */ },
    apply(e, data, world) { Object.assign(e.state, data); },   // data from replicate()
    draw(e, renderer, shadowPass) { /* ... */ },
  },
});
```

- **Flat classes still work.** A class written the old way (`{ spawn, think, draw, ... }`) runs on the server only when online and the client calls just its `draw()` against the replicated state; offline everything runs on one entity, as before.
- **Ids.** Map entities get their position in the file as an id, so server and client agree without a list. Entities spawned at runtime get dynamic ids and are announced to each client that may see them.
- **Per player.** `entity.stateFor(player.id)` is private state per player (forgotten when they leave). `entity.showOnlyTo([ids])` hides the entity from everyone else. This is how personal loot works.
- **Never trust the activator.** `interact` receives the server's `player`, never a client claim.

## The `world.context` API

Entities and scripts reach the engine through `world.context`:

| | |
|---|---|
| `players` | every player in this instance (one in single player) |
| `playerOf(actor)`, `playersInRadius(point, r)`, `playersInBox(min, max)` | lookups; dead players are skipped unless you pass `{ includeDead: true }` |
| `actors` | the actor system: `actors`, `getById`, `inRadius`, `abilities`, `combat` |
| `travel(player, map, landmark)` | send one player to another map (a portal) |
| `economy` | `grant`, `spend`, `transfer`, `balance`: audited gold (persistence.md) |
| `parties` | `membersNear(player, r)`, `shareXp(player, total, apply, { radius, bonusPerMember })` |
| `encounters` | `dropLoot(entity, { mode: 'personal' \| 'shared', recipients })` |
| `worldTime()` | the shared clock in seconds |
| `player.notify(name, payload)` | a toast / floating text / anything to one player |

Single player provides the same names, with one player and no ledger, so a script written for many players works alone.

## Server hooks

A server script exports `hooks` (`scripts.server` in the config; `scripts.shared` also loads in the browser). Every hook is optional and the engine calls them with plain arguments:

| hook | called |
|---|---|
| `playerConfig({ name, class, hello })` | before a player is created: return a `player` config override |
| `classes()` | return the allowed class list for character creation |
| `nameAllowed(name)` | `false` or a string to refuse a character name |
| `characterCreated(character)`, `characterSummary(record, character)` | creation; extra fields for the select screen |
| `migrateCharacter(record, fromVersion, toVersion)` | upgrade a saved record |
| `playerJoined(instance, player, info)`, `playerLeft`, `playerRespawned` | lifecycle |
| `instanceCreated(instance)`, `instanceClosed(instance)` | lifecycle |
| `actorDied(instance, actor, killer)`, `pvpKill(instance, killer, victim)`, `duelEnded(...)`, `encounterReset(instance, actor)` | combat |
| `scalePlayer(instance, player)` | a `{ hp, damageDealt, damageTaken, speed }` multiplier layer for sidekicking, or null |
| `chatFilter(text, player, channel)`, `chatReport(report)`, `guildOf(player)`, `partyMember(player)` | social |
| `adminGive(player, args)` | the admin `give` command |
| `message(session, player, msg)` | a message type the engine does not know: your own protocol |

## Instances and portals

A map says how it is instanced:

```json
"instance": { "policy": "shared", "cap": 30, "fill": "fullest", "idleTimeout": 60, "pvp": "off" }
```

- `shared`: a copy is filled up to `cap` (`fill: "fullest"` packs players together, `"emptiest"` spreads them), then another is opened. Empty copies close after `idleTimeout` seconds.
- `static`: spread players across copies by emptiest and never tear them down (a town).
- `party`: one private copy per party (a player with no party is a party of one): a dungeon.
- `solo`: one copy per player.

`trigger_changelevel` portals work online: the character is serialised with `actor.snapshot()`, leaves its copy, and joins the right copy of the destination at the named `info_landmark`. A script can do the same with `world.context.travel(player, map, landmark)`. `player.partyId` routes party maps; the social system keeps it current.

## Interest management and bandwidth

Each instance keeps a spatial hash (16 m cells). A client is sent only the actors, projectiles, entities and events near it:

- **View radius** 45 m by default (`viewRadius`). An actor enters view at the radius and leaves at `radius × interestMargin` (1.15), so someone on the boundary does not flicker.
- **Always visible:** `player.alwaysVisible = () => [actors]` (party members, a mount, a boss's adds) are sent at any distance. Party frames go out regardless of interest.
- **Events** are filtered by where they happened, except anything involving the receiving player's own actor: being hit by something you cannot see still shows.
- **Byte budget.** `bandwidth` (bytes per second per client; 0 = unlimited) caps a snapshot. The player's own state and events always go; actor updates go nearest and stalest first. An update that does not fit is retried next tick, so under pressure far things move choppily instead of not at all.

Measured on a laptop with 50 headless players in one instance (`server/loadtest.mjs --bots 50`): the average tick used about 21% of its 33 ms budget, with about 40 KB/s per client when everybody can see everybody. Set `bandwidth` for crowded hubs.

## Parties, chat, emotes and name plates

- **Parties** have a leader and up to `partySize` members. A frame (health, resources, map, online, plus your `partyMember` hook's fields) reaches every member at any distance. Party instances route by party id.
- **Channels:** `say` (nearby, with a speech bubble), `party`, `guild` (needs a `guildOf` hook), `whisper` (by name), `world`. Each has a rate limit; identical repeats are dropped; length is capped; `ignore` is stored in the character's data (`actor.data.socialIgnored`); `chatFilter` and `chatReport` are the game's moderation hooks; operators can mute.
- **Emotes** come from `server.emotes`; the last one is in `actor.publicData.emote` and fires `game.events 'emote'` so the game can play an animation.
- **Name plates, health bars and bubbles** are drawn in the world by `game.nameplates` from replicated data (`name`, `health`, `publicData.bubble`). Turn off with `game.nameplates.enabled = false` and draw your own from `game.actors.actors`.

`actor.publicData` is the way to show something to everyone nearby (level, title, a palette, paper-doll layers): it replicates with the actor. Keep it small.

## Fighting together

- **Threat.** Every monster keeps a threat table. Damage adds its final amount (times the ability's `threat` multiplier); healing a monster's enemy adds half the heal. It fights whoever has the most, and only swaps for someone with 10% more in melee or 30% more at range. A `{ "type": "threat", "amount": 200, "taunt": true }` effect adds, scales (`mult`) or takes the top. Tables clear when the monster gives up.
- **Friendly abilities.** `"targeting": "target", "friendly": true` works on other players, and `"area"` effects with `"targets": "ally"` hit allies (`"includeSource": true` includes the caster).
- **Scaling.** On an NPC entity set `"scales": true`. The map's `instance.scaling` (or `server.scaling`) is `{ "hp": [1, 1.7, 2.4], "damage": [1, 1.1, 1.2] }`, indexed by living players − 1. `actor.setScale(key, { hp, damageDealt, damageTaken, speed })` is the general mechanism: layers multiply, health keeps its fraction, and saved characters record unscaled health.
- **Wipes.** Set `"resetOnWipe": true` on a boss: when every player in the instance is dead it returns to full health with a clear threat table, and `encounterReset` fires.
- **Personal loot.** `world.context.encounters.dropLoot({ classname: 'my_loot', origin }, { mode: 'personal', recipients: world.context.parties.membersNear(killer) })` spawns one copy per recipient, each visible only to them. `mode: 'shared'` spawns one anyone can take.
- **Sidekicking.** The `scalePlayer` hook returns a multiplier layer, applied when a player enters and removed when they leave.
- **Death hooks.** `actorDied` for everything, `pvpKill` for player kills outside duels.
- **Boss scripts** are ordinary server-half entities using `think`, `world.context.players` and `actors.abilities.use(...)`. Nothing boss-specific is built in.

## PvP and duels

Players share a faction, so by default they are friends. A map's `instance.pvp` (or `server.pvp`) changes that:

- `off`: never hostile. `free`: always hostile except party members. `flagged`: hostile only when both have the flag on (`game.pvp.flag()`; dropping it takes 10 seconds). `teams`: hostile when `actor.data.team` differs.
- **Duels** override all of it between two consenting players (`game.pvp.duel(name)`, the other `acceptDuel()`), hostile only to each other and **non-lethal**: the blow that would kill leaves the loser on one health and ends the duel (`duelEnded` hook). Leaving or yielding ends it too.

## The world clock and tides

`game.clock.sample()` returns `hour`, `daylight` (0 at midnight to 1 at noon), `isNight`, `day`, `season`, `seasonProgress`, `tide` (−1 to 1) from one number, the world time, which the server puts in every snapshot, so everyone in an instance agrees. Configure with `"clock": { "dayLength": 600, "startHour": 8, "seasons": [...], "seasonLength": 3, "tidePeriod": 240 }`. Events: `hour-changed`, `day-changed`, `season-changed`. `game.clock.lighting(env)` returns an environment tinted for the hour.

`func_water` is a volume whose surface follows a tide (`"tide": { "amplitude": 0.4, "period": 240 }`) and slows whatever wades in it (`"slow": 0.6`). The server owns the level and the slowdown. Outputs: `OnEnter`, `OnExit`.

## Operating a server

- **Console.** In a terminal the server reads commands (`help`, `status`, `players`, `instances`, `dump <instance>`, `kick`, `ban`, `unban`, `mute`, `unmute`, `say`, `tp`, `spawn <class> near <player> [json]`, `gold`, `give`, `rollback-gold`, `save`, `backup`, `audit`, `shutdown [seconds]`, `cancel`).
- **HTTP admin.** With `--admin-token` (16+ characters), `POST /admin` with `Authorization: Bearer <token>` and `{ "line": "kick Bob" }` runs the same commands and returns `{ ok, text, data }`. It is rate limited; a bad token is refused; every command is audit-logged with who ran it. There is no admin WebSocket.
- **Status and metrics.** `GET /api/status` (public) and `GET /metrics` (Prometheus text; localhost or the admin token): players, instances, tick time and budget used, bytes sent, saves and failures, per-instance players and tick.
- **Logs.** `--log-json` writes one JSON object per line.
- **Shutdown.** SIGINT/SIGTERM, or the `shutdown` command, warns players on a countdown, refuses new joins, saves every character, then exits. A second signal does not hurry it.
- **Backups.** Every 60 minutes by default (`--backup-minutes`), kept newest 14 (`--backup-keep`), in `<root>/data/backups`, taken while the game runs. `node server/mmo.mjs --restore <backup>` puts one back with the server stopped, moving the old data aside rather than deleting it.
- **Load test.** `node server/loadtest.mjs --bots 50 --seconds 15` starts a server and plays with headless bots (or `--url ws://host:8099` for a running one); it passes when the average tick uses under half its budget.

## Testing headlessly

The server and the real client netcode run in Node, so everything above can be tested without a browser. `tests/mmo-helpers.mjs` has a `Bot` that plays through the real protocol; `tests/e2e.test.mjs` is the worked example (two accounts, a monster, a party, a portal, a dropped connection, a save). Run a suite with `node --no-warnings tests/<name>.test.mjs` (`--no-warnings` silences Node's SQLite notice).

## Limits and what is not here

- No gateway or sharding across processes: one process hosts everything (the bot test shows its headroom). The store contract (`server/store.mjs`) lets a game plug in Postgres for the character data.
- No admin WebSocket, and mutes are not persisted across restarts.
- Camera cut-away (`camera.occlusionFade`), decals, UV scrolling, palette swaps, paper dolls and music are rendering and audio features, documented in rpg.md and sprites-and-audio.md.
