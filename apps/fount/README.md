# Fount Engine

A dependency-free WebGL2 FPS engine, built so **Claude can author a complete game as plain text and the game then runs with zero API calls.**

That single constraint shapes everything here. Authoring happens in a Claude Code session on your existing subscription; the finished game is static files that run offline, forever, with no API key, no network access, and no per-play cost. To make that possible, nothing in a Fount game is a binary asset:

| Normally a binary file | In Fount |
|---|---|
| Texture PNGs | Procedural generators with named parameters (`brick`, `metal`, `noise`, …) |
| Sound WAVs | WebAudio synthesis presets (`shoot`, `explosion`, `die`, …) |
| Compiled level (BSP) | A JSON brush list, read directly at runtime |
| Character models | Primitives composed in code, sharing a skeleton with the ragdolls |
| Animation clips | Procedural — walk cycles from a sine, deaths from physics |

So a whole game is text you can diff, review, and edit in one pass.

## Top-down pixel-art and RPG games

Set `"mode": "topdown"` and the same engine becomes a pixel-art sprite RPG engine: a follow camera and cursor picking, low-resolution rendering with an enforced palette and Bayer dithering, text-defined billboard sprites, particles and a bitmap font, plus generic actors, abilities, statuses, monster AI with baked navigation, hazards and level transitions. Nothing about it is game-specific, and a map without the setting is the first-person game it always was. See `.claude/skills/fount-gamedev/references/rpg.md` (in a scaffolded game) or `skills/fount-gamedev/references/rpg.md`, and try the `test_topdown` map. Engine tests run with plain Node: `node tests/rpg.test.mjs`.

## Run it

```sh
cd apps/fount
./run.sh              # or ./run.sh 9000 for a different port
```

That serves the files and opens a browser. Equivalent by hand:

```sh
python3 -m http.server 8099
```

- Game: <http://localhost:8099/>
- Editor: <http://localhost:8099/editor/index.html>

ES modules need a real HTTP origin — opening `index.html` from the filesystem won't work. There is no build step: edit a file, refresh the browser.

## Controls

| Input | Action |
|---|---|
| WASD | Move — air acceleration is capped Quake-style, so air-strafing and bunnyhopping preserve momentum |
| Space | Jump |
| Mouse | Look (click to capture, or drag); left click to shoot |
| Arrow keys | Look, for when pointer lock is unavailable |
| F / Enter / Ctrl | Shoot from the keyboard |
| ` or ~ | Open the console |
| Shift+R | Restart map |
| Esc | Release mouse |

Looking works three ways — pointer lock, mouse drag, arrow keys — on purpose.
Pointer lock is refused by some browsers and embeddings, and when it was the
only route a refusal left you unable to turn at all, with nothing on screen
saying why. Now any one of them is enough, and a refusal says so in the HUD.

Headshots do 100 damage, body shots 25. The ragdoll a kill produces inherits the victim's velocity and takes the bullet's impulse at the point of impact.

## What's in the box

**Renderer** — WebGL2 from raw GL calls. One shader, a single 2D-array texture holding every material (so the world draws without rebinds), a 2048² directional shadow map with 3×3 PCF, up to 16 point lights, and exponential distance fog.

**Collision** — Swept AABB against convex brushes using Quake's Minkowski plane-expansion trace, so slopes, wedges and cylinders work with no special cases. Move-and-slide with corner creasing, plus step-up so stairs are walkable.

**Ragdolls** — 16-particle verlet humanoid with distance constraints and cross-bracing, colliding against the world, settling and freezing when still. Position-based dynamics rather than rigid bodies with joints: stable at any timestep, no inertia tensors, and much floppier in the way that actually reads as death. Explosions throw bodies; later bullets shove them.

**Entities + IO** — Entities are addressed by `classname` from map JSON. Level logic is declared as output→input connections with delays (`OnDeath` → `Open` after 0.5s), so most mechanics need no code at all.

**Editor** — Fly camera, click-to-select, outliner, property forms plus raw-JSON editing per object, entity gizmos, and export back to the map file. Visual edits and hand-written JSON round-trip, because the JSON *is* the map.

## Layout

```text
apps/fount/
├── index.html              Game shell + HUD; the map list lives here
├── editor/index.html       In-browser editor
├── engine/
│   ├── math.js             Vectors as plain arrays, so they match map JSON
│   ├── render.js           WebGL2 renderer, mesh building
│   ├── physics.js          Brush tracing, character controller, rigid bodies
│   ├── ragdoll.js          Verlet ragdolls
│   ├── entity.js           Entity registry + output/input event system
│   ├── entities.js         Built-in classnames
│   ├── map.js              Brush → planes → polygons, map loading
│   ├── textures.js         Procedural material generators
│   ├── audio.js            Procedural sound synthesis
│   ├── console.js          In-game console: commands, cvars, completion
│   ├── net.js              Multiplayer client: snapshots, interpolation
│   └── game.js             Player, weapons, fixed-timestep loop
├── server/
│   ├── websocket.mjs       RFC 6455 server, written against the stdlib
│   ├── anticheat.mjs       Movement, shot and hit validation
│   ├── anticheat.test.mjs  A hostile client that tries to beat it
│   └── server.mjs          HTTP + session host, admin terminal
├── serve.sh                Start a multiplayer server
├── package.json            Declares the engine's .js as ES modules; no deps
└── game/
    ├── maps/               Levels (JSON)
    └── scripts/            Game-specific entity behaviours
```

## Authoring

The `fount-gamedev` skill in this repo teaches Claude the formats. Install it and ask for what you want:

> "Add a level with a courtyard and a sniper tower, and put four guards in it."

Full schema documentation, for humans and for Claude:

- `skills/fount-gamedev/references/map-format.md` — brushes, materials, lighting, scale table
- `skills/fount-gamedev/references/entities.md` — every classname, keyvalue, input and output
- `skills/fount-gamedev/references/custom-behaviors.md` — `defineEntity` and engine services

## Console

Press `` ` `` (or `~`) in game. Tab completes, up/down walks history, and `help`
lists everything.

| Command | Does |
|---|---|
| `noclip`, `god` | The usual cheats |
| `give health\|ammo [n]` | Top yourself up |
| `teleport x y z`, `where` | Move about, find out where you are |
| `spawn <classname> [key value …]` | Place an entity at your crosshair |
| `ragdoll`, `killall`, `clearbodies` | Make a mess, then clean it up |
| `ent [classname]`, `fire <target> <input> [value]` | Inspect entities; send them IO inputs |
| `map <path>`, `restart`, `pause` | Level control |
| `connect [host]`, `disconnect`, `say`, `name`, `players`, `status` | Multiplayer |

Cheat commands (`noclip`, `god`, `give`, `teleport`, `spawn`, and the `gravity`,
`speed`, `jump` and `timescale` cvars) are disabled while you are on a server
that has not enabled them. Single-player is your own game, so nothing is locked
there.

Cvars are read by typing the name and set by typing a value after it:
`sensitivity`, `fov`, `gravity`, `speed`, `jump`, `timescale`, `maxbodies`,
`showfps`.

`fire` is the useful one while building a level: it drives the same IO system
the map JSON uses, so you can test a connection before you wire it up.

## Multiplayer

```sh
cd apps/fount
./serve.sh                                    # port 8099, all interfaces
./serve.sh --port 8080 --name "My Server"
./serve.sh --map game/maps/test_playground.json --max 24
```

One process serves the game files *and* hosts the session on the same port, so
there is nothing else to run and nothing to configure: whoever opens the page is
already pointed at the right server. Node 18+, no `npm install` — the WebSocket
server in `server/websocket.mjs` is written against the standard library. The
`.mjs` extension is deliberate: it makes the server itself load correctly
whatever `package.json` your game repo happens to have next to it. The engine's
own `.js` files still need `"type": "module"` in `package.json` — the scaffolder
writes one, and there is nothing in it to install. Setting that to `"commonjs"`
will stop the server loading the engine's collision code, and so stop it
starting; the error says exactly that if it happens.

Players join with `connect` in the console (no argument connects to whoever
served the page), and `disconnect` leaves. Chat is `say`, `players` shows the
scoreboard, `status` shows the connection.

### Admin

The terminal you started the server in *is* the admin console — type into it:

| Command | Does |
|---|---|
| `status` | Who is connected, their scores, their addresses |
| `say <text>` | Broadcast a server message |
| `kick <who> [why]` | Disconnect a player |
| `ban <who>`, `unban <addr>`, `bans` | Block an address, and manage the list |
| `admin <who>`, `unadmin <who>` | Grant or revoke in-game admin rights |
| `map <path>`, `restart` | Change or restart the level for everyone |
| `anticheat [level]` | Who has been flagged, or change the level live |
| `quit` | Shut down |

A player you have `admin`'d runs those same commands from the game by prefixing
chat with `/` — `say /kick griefer`. Everyone else gets told to ask you.

`<who>` matches a player id or a name prefix, so `kick 3` and `kick grie` both
work.

### Putting a server on the internet

The server binds all interfaces, so on a LAN people can already reach it at
`http://<your-lan-ip>:8099/`. Beyond that, pick whichever of these fits:

**A tunnel** — nothing to configure, good for a quick game with friends:

```sh
./serve.sh --port 8099 &
cloudflared tunnel --url http://localhost:8099     # or: ngrok http 8099
```

Share the HTTPS URL it prints. The client picks `wss://` automatically when the
page is served over HTTPS, so tunnels work with no flags.

**Port forwarding** — forward external 8099 to your machine's 8099 and share
`http://<your-public-ip>:8099/`. Free, but it exposes your home address to
everyone who plays.

**A cheap VPS** — the durable option, and the one to use if the server should
outlive your laptop:

```sh
git clone https://github.com/<you>/<your-game>.git
cd <your-game>
./serve.sh --port 80 --name "My Game"
```

That is the whole deployment. Because a scaffolded Fount game vendors the engine
and the server, the repo *is* the build — there is no toolchain to install on the
box beyond Node. Keep it running with whatever you already use; a systemd unit is
enough:

```ini
[Service]
ExecStart=/usr/bin/node /srv/my-game/server/server.mjs --port 80 --name "My Game"
WorkingDirectory=/srv/my-game
Restart=always
```

To put it behind nginx or Caddy for TLS, proxy to the port and pass the
`Upgrade`/`Connection` headers through so WebSockets survive the hop. The server
reads `X-Forwarded-For`, so `status` and `ban` see real client addresses rather
than the proxy's.

`GET /api/status` returns the server name, map, player list and uptime as JSON —
enough for a server browser or an uptime check.

### How it works, and what that costs

Remote players are drawn ~100 ms behind the newest snapshot, interpolated
between the two snapshots straddling that time. Rendering the latest snapshot
directly would teleport players on every packet; one tick of slack buys smooth
motion for a little latency, which is the standard trade. The server ticks at
20 Hz and clients report at the same rate.

Your client still traces its own shots, because that is what makes hits feel
immediate on a high-ping connection — but it only reports *who* it hit, and the
server decides whether that was possible and what it costs. See below.


## Online top-down games

Top-down / RPG games run on a different server, `server/mmo.mjs`, where the server simulates everything and clients send only intents (the first-person server above is unchanged):

```sh
./serve.sh --online                                        # guests, nothing saved: for development
./serve.sh --online --auth required --admin-token <16+ chars>
node server/mmo.mjs --help                                 # every option, each with a FOUNT_* variable
```

It brings accounts and saved characters (sqlite, file or your own store), instanced maps with portals, per-client interest management and a bandwidth budget, parties, chat and emotes, threat and PvP, an admin console and HTTP admin API, `/metrics`, scheduled backups and a graceful shutdown. A game's server half is ordinary `defineEntity` code plus a few hooks. See `skills/fount-gamedev/references/multiplayer.md` and `persistence.md`; `server/loadtest.mjs --bots 50` measures a server under load; `tests/e2e.test.mjs` is a headless two-player walk-through. Moving an existing game onto it: `skills/fount-gamedev/references/online-migration.md`.

Run the engine's tests from `apps/fount` with `node --no-warnings tests/<name>.test.mjs` (the flag silences Node's SQLite notice).

## Anticheat

The server loads the map and runs the engine's own collision code, so it checks
claims against the same geometry the client collides with. One implementation,
no second copy to drift out of step and start disagreeing with honest players.

**The server owns, and clients cannot touch:**

- **Health, damage, death, respawns and scoring.** A client that reports its own
  health is reporting a number nothing reads. Godmode and self-resurrection are
  not expressible in the protocol.
- **What a hit is worth.** The client says who it hit; the server re-traces the
  shot and computes the damage from where the ray actually landed. A claim of
  9999 damage, or of a head shot at the victim's feet, changes nothing.

**Every shot and hit is validated:**

- A hit must correspond to a shot the server accepted — no shot, no damage, which
  closes off the cheapest aimbot of all: posting hits with no shooting at all.
- The shot must leave from where the server thinks you are, pointing where you
  say you are looking, within a cone.
- The ray must actually intersect the target, **rewound to where you saw them** —
  your latency plus the interpolation delay, capped. Lag compensation is what
  makes honest hits land on a real connection; the cap is what stops it becoming
  a cheat of its own.
- Line of sight is traced through the map, so shooting through a wall fails.
- Fire rate, ammo and range are enforced, and the dead do not shoot.

**Movement is validated against real geometry.** Between two reported positions
the server sweeps the player's box through the world, allowing for stair step-up
and for the corner-clipping that a straight sweep shows but sliding movement
doesn't. A path that crosses solid brushwork is not a fast player — it is a
client that isn't colliding — so the server corrects the position and the cheat
achieves nothing. Speed and climb-rate limits sit on top as weaker signals,
because a laggy honest client can look fast for a tick and a wall never lies.

**Response is graduated.** Violations score by weight — shooting through a wall
costs far more than one fast tick — and decay by half every 30 seconds. Warnings
go to the log and to admins; a sustained pattern gets a kick. One anomaly is far
more often a lag spike than a cheat, and kicking on it punishes a bad connection
instead of a cheater.

```sh
./serve.sh --anticheat strict      # off | lenient | normal (default) | strict
./serve.sh --cheats                # let clients use noclip/god/give
./serve.sh --verbose               # log every flag, for tuning or a report
```

In the terminal, `anticheat` lists who has been flagged and for what, and
`anticheat <level>` changes the level live. `status` shows each player's ping and
marks anyone over the warning threshold.

`--cheats` turns the **movement** checks off, because noclip is movement through
geometry by definition — combat validation stays on either way, since that is
what protects other players rather than the cheating one. With cheats blocked
(the default) the client disables its own cheat commands on joining, so an honest
player cannot noclip themselves into a kick.

Thresholds were measured, not guessed: instrumented play put legitimate
horizontal speed at ~16 m/s p99 and terminal fall at exactly 60 m/s, so the
default caps sit at roughly twice real play. `server/anticheat.test.mjs` is a
hostile client that speaks the protocol directly and asserts all of the above —
run it after changing the movement constants or weapon values, because thresholds
measured against one version of the movement code are not automatically right
for the next.

```sh
node server/anticheat.test.mjs
```

### What it still does not do

The server **validates** movement rather than **simulating** it. It knows a move
was impossible and undoes it; it does not reproduce your movement from your
inputs. A full simulation would need client-side prediction and reconciliation —
a much larger change, and a worse-feeling game if done badly.

What that leaves open is movement cheating that stays inside the rules: a client
that never passes through geometry, never exceeds the speed caps, and never
claims an impossible shot can still, say, hold a slightly-too-perfect aim or move
with inhuman consistency. There is no behavioural or statistical detection here,
and no client attestation — the client is open source and runs in your browser,
so there could not be. This is built to make the cheap and common cheats
pointless, not to survive a determined attacker.

## Starting your own game repo

`apps/fount/` is the engine plus its demo maps. A real game wants its own
repository, which the scaffolder sets up:

```sh
python3 tools/new_fount_game.py ../my-game --name "My Game"
cd ../my-game && ./run.sh
```

You get a self-sufficient project: the engine vendored in (it has no
dependencies, so a copy beats a submodule), a starter level, the game shell and
editor, `run.sh`, a README, and a git repo with a first commit. Nothing is
pushed anywhere — the script prints the remote steps for you to run.

**The part that matters for Claude Code**: it also installs the `fount-gamedev`
skill at `.claude/skills/fount-gamedev/` inside the new project. A Claude Code
session opened on that repo — locally, or by attaching the GitHub repo on the
web — discovers it as a project skill automatically, so Claude already knows the
map format and entity library without SuperClaude being present at all.

Other modes:

```sh
python3 tools/new_fount_game.py ../existing-repo --vendor-only  # add Fount to a project you already have
python3 tools/new_fount_game.py ../my-game --update             # refresh the vendored engine + skill
python3 tools/new_fount_game.py ../my-game --dry-run            # show what it would write
```

`--update` only touches `engine/` and `.claude/skills/fount-gamedev/`. Your
`game/` content, `index.html` and README are never overwritten.

## Included maps

- **`dm_crucible`** — walled arena with a catwalk, ramps, a raised platform, physics crates, five guards, and a trigger-operated vault door.
- **`test_playground`** — sandbox for the systems themselves: a timer that drops ragdolls, an explosion pad, a cycling platform, stationary targets, and a crate stack.

## Performance note

Performance depends heavily on the GPU. On software rendering (a headless CI browser using SwiftShader) the demo maps run around 8–10 fps, dominated by the 2048² shadow pass; on any real GPU they run at refresh rate. If you need more headroom on weak hardware, drop `SHADOW_SIZE` in `engine/render.js`.

## Known limits

Honest about what this is not:

- **No rotational rigid bodies.** `prop_physics` boxes translate and get a visual spin, but don't tumble with real angular dynamics. Ragdolls carry the physical interest instead.
- **No BSP/PVS culling.** Every brush in the static mesh is drawn every frame. Fine at demo-map scale; a very large level would want spatial partitioning.
- **Point lights don't cast shadows** — only the sun does.
- **The server validates movement, it does not simulate it.** Impossible moves
  are corrected, but movement cheating that stays within the rules is not
  detected, and there is no behavioural analysis. See **Anticheat** above for
  where exactly that line sits.
- **Brushes must be convex.** Concave shapes are built from several brushes, exactly as in Quake and Source.

## License

MIT, same as the rest of SuperClaude.
