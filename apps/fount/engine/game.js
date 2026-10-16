// Game runtime: player, weapons, the fixed-timestep loop, and the glue that
// hands engine services to entity behaviours.

import { Renderer } from './render.js';
import { CollisionWorld, CharacterController } from './physics.js';
import { RagdollSystem, STEP_DT } from './ragdoll.js';
import { EntityWorld, defineEntity, getEntityDefinition } from './entity.js';
import { buildMap, loadMap, pointInBrush } from './map.js';
import { playSound, playSoundAt, unlockAudio } from './audio.js';
import {
  add, sub, mul, norm, len, dot, dist, clamp,
  anglesToForward, anglesToRight,
} from './math.js';
import { killNPC } from './entities.js';
import { GameConsole } from './console.js';
import { NetClient } from './net.js';
import './entities_rpg.js';
import { Emitter } from './events.js';
import { Input } from './input.js';
import { TopDownCamera, rayPlaneY } from './camera.js';
import { ActorSystem } from './actors.js';
import { Relations } from './combat.js';
import { AbilitySystem } from './abilities.js';
import { loadAssets, mergeConfig, pickMapConfig } from './assets.js';
import { ParticleSystem, FloatingTexts } from './particles.js';
import { createPlayer, stepTopDownPlayer } from './rpg_player.js';
import { OnlineLink, ReplicaActors, OnlinePlayer } from './online.js';
import { Economy } from './economy.js';
import { ChatClient, PartyClient } from './social_client.js';
import { NamePlates } from './nameplates.js';

// Single source of truth, shared with the ragdoll solver: impulses convert
// force to a verlet position offset using this exact value, so the two drifting
// apart silently doubles every impulse in the game.
const FIXED_DT = STEP_DT;
// frameTime is clamped to 0.25s below, which is 30 steps at 1/120. Capping
// lower than that meant a slow frame simulated less time than really elapsed
// and threw the remainder away — the world advancing by a different amount
// every frame, which is exactly what "janky" feels like.
const MAX_SUBSTEPS = Math.ceil(0.25 / FIXED_DT);

class Player {
  constructor(config = {}) {
    this.controller = new CharacterController({
      position: config.spawn || [0, 2, 0],
      halfExtents: [0.35, 0.9, 0.35],
      maxSpeed: config.maxSpeed ?? 7.2,
      jumpSpeed: config.jumpSpeed ?? 7.4,
    });
    this.angles = [0, config.yaw ?? 0, 0];
    this.maxHealth = config.maxHealth ?? 100;
    this.health = this.maxHealth;
    this.ammo = config.ammo ?? 120;
    this.eyeHeight = 0.72;
    this.fireCooldown = 0;
    this.damageFlash = 0;
    this.stepAccum = 0;
    this.kills = 0;
    this.dead = false;
    this.respawnTimer = 0;
    this.spawnPoint = config.spawn || [0, 2, 0];
  }

  get position() { return this.controller.position; }

  get eyePosition() {
    const p = this.controller.position;
    return [p[0], p[1] + this.eyeHeight, p[2]];
  }

  /** Eye position blended between the last two physics steps, for rendering. */
  interpolatedEye(alpha) {
    const p = this.controller.position;
    const q = this.prevPosition || p;
    return [
      q[0] + (p[0] - q[0]) * alpha,
      q[1] + (p[1] - q[1]) * alpha + this.eyeHeight,
      q[2] + (p[2] - q[2]) * alpha,
    ];
  }

  get forward() { return anglesToForward(this.angles); }

  /**
   * `fromServer` marks damage the server already applied and broadcast. Damage
   * without it came from something this client simulates alone — an NPC, an
   * explosion, a fall — and has to be reported, because NPCs run per-client and
   * the server owns health. Reporting your own damage is safe to trust: the
   * only thing a client can achieve by lying is hurting itself.
   */
  takeDamage(amount, source, fromServer = false) {
    if (this.dead || this.godMode) return;
    this.health -= amount;
    this.damageFlash = 1;
    playSound('hurt', 0.7);
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.respawnTimer = 2.5;
      playSound('die');
    }
    if (!fromServer && this.net && this.net.connected) this.net.reportSelfDamage(amount);
    void source;
  }

  /**
   * Move instantly, without a visible streak: the renderer blends between the
   * last two physics positions, so a teleport must reset both or the camera
   * sweeps across the map for one step.
   */
  teleport(pos) {
    this.controller.position = [pos[0], pos[1], pos[2]];
    this.controller.velocity = [0, 0, 0];
    this.prevPosition = [pos[0], pos[1], pos[2]];
  }

  respawn() {
    this.deaths = (this.deaths || 0) + 1;
    this.teleport(this.spawnPoint);
    // Deliberately keep the player's current yaw/pitch. Snapping the camera
    // back on respawn reads as the game wrestling the mouse away from you.
    this.angles[0] = 0;
    this.health = this.maxHealth;
    this.dead = false;
  }
}

// Colour of a floating damage number, by damage type. A game overrides entries
// with game.damageColors.
const DAMAGE_COLORS = {
  physical: [1, 1, 1], fire: [1, 0.62, 0.22], frost: [0.55, 0.85, 1], holy: [1, 0.95, 0.5], shadow: [0.78, 0.55, 1],
};

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${url} is not valid JSON: ${err.message}`);
  }
}

// Ray vs axis-aligned box, used for hitscan against NPC bodies.
function rayBox(origin, dir, min, max) {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-8) {
      if (origin[i] < min[i] || origin[i] > max[i]) return null;
    } else {
      const inv = 1 / dir[i];
      let t1 = (min[i] - origin[i]) * inv;
      let t2 = (max[i] - origin[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

export class Game {
  constructor(canvas, hud) {
    this.canvas = canvas;
    this.hud = hud;
    this.renderer = new Renderer(canvas);
    this.ragdolls = new RagdollSystem();
    this.keys = new Set();
    this.mouseDown = false;
    this.pointerLocked = false;
    this.lookBlocked = false;
    this.dragLook = false;
    this.dragDistance = 0;
    this.lastMouse = [0, 0];
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.fpsAccum = 0;
    this.dynamicBrushes = [];
    this.debugText = '';
    this.sensitivity = 0.14;
    this.onStatsChanged = null;
    this.fov = 78;
    this.timescale = 1;

    // Top-down / RPG support. All of it idles in a first-person map.
    this.mode = 'fps';
    this.config = {};                    // game-wide settings from loadConfig()
    this.mapConfig = {};                 // the effective settings for the current map
    this.events = new Emitter();         // damage, death, ability, travel...: see docs/rpg.md
    this.input = new Input();
    this.sprites = this.renderer.sprites;
    this.particles = new ParticleSystem();
    this.particles.sprites = this.sprites;
    this.floatText = new FloatingTexts();
    this.abilityDefs = new Map();        // shared across maps: define abilities once per game
    this.abilityRegistry = new AbilitySystem(null, this.abilityDefs);
    this.relations = new Relations();
    this.assetsLoaded = new Set();
    this.damageNumbers = true;
    this.damageColors = { ...DAMAGE_COLORS };
    this.actors = null;
    this.topCamera = null;
    this.hover = { inside: false, ground: null, actor: null, ray: null };
    this.mouseClient = null;
    this.renderTime = 0;
    this.frameDt = 0;
    this.fade = { alpha: 0, target: 0, speed: 4, resolve: null };
    this.transitioning = false;
    this.chat = new ChatClient(this);
    this.parties = new PartyClient(this);
    this.nameplates = new NamePlates(this);
    this.online = null;              // an OnlineLink while playing on a server
    this.arrival = null;
    this.lastArrival = null;
    this.input.load();
    this.setupEvents();
    this.bindInput();
    this.console = new GameConsole(this);
    this.net = new NetClient(this);
    this.net.onChat = (from, text) => {
      this.console.print(from ? `${from}: ${text}` : text, from ? 'out' : 'cmd');
      if (this.hud && this.hud.chat) this.hud.chat(from, text);
    };
    this.net.onStatus = (text) => this.console.print(text, 'cmd');
  }

  /**
   * Load a map. `options.landmark` names an info_landmark to arrive at, and
   * `options.carry` is an actor snapshot to restore: how a level transition
   * brings the player's state along.
   */
  async load(mapUrl, options = {}) {
    this.goOffline();   // loading a map yourself means playing locally
    const doc = await loadMap(mapUrl);
    await this.loadAssets(pickMapConfig(doc));
    this.currentMapPath = mapUrl;
    this.arrival = options.landmark !== undefined || options.carry ? { landmark: options.landmark || null, carry: options.carry || null } : null;
    this.loadMapDocument(doc);
  }

  /**
   * Game-wide settings: render, camera, player, sprites, abilities, keys. A map's
   * own blocks of the same names override these. Call before load().
   */
  async loadConfig(url) {
    const cfg = typeof url === 'string' ? await fetchJson(url) : url;
    this.config = mergeConfig(this.config, cfg);
    await this.loadAssets(cfg);
    if (cfg.keys) this.input.configure(cfg.keys);
    this.input.load(); // a player's own rebinds win over the game's defaults
    return cfg;
  }

  /** Sprites, abilities, statuses and particle presets: a URL to a JSON file, or the data inline. */
  async loadAssets(cfg) {
    await loadAssets(cfg, {
      fetchJson, sprites: this.sprites, abilities: this.abilityRegistry, relations: this.relations,
      particles: this.particles, loaded: this.assetsLoaded,
    });
  }

  loadMapDocument(doc) {
    this.mapDoc = doc;
    const arrival = this.arrival;
    this.arrival = null;
    this.lastArrival = arrival;

    const cfg = mergeConfig(this.config, pickMapConfig(doc));
    this.mapConfig = cfg;
    this.mode = cfg.mode === 'topdown' ? 'topdown' : 'fps';
    // A top-down game keeps the cursor. A pointer lock requested before the map
    // said which kind it was would otherwise hide it.
    if (this.mode === 'topdown' && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();

    const built = buildMap(doc);
    this.built = built;
    this.collision = built.collision;
    this.dynamicBrushes = [];
    this.collision.setDynamicBrushes(this.dynamicBrushes);
    this.renderer.configure(cfg.render);
    this.renderer.setMaterials(built.materials);
    this.renderer.setWorldMesh(built.meshData);
    this.renderer.computeLightMatrix(built.env.sunDir, built.bounds);
    this.env = built.env;
    this.ragdolls.clear();
    this.particles.clear();
    this.floatText.clear();

    const entities = built.entities || [];
    const landmark = arrival && arrival.landmark
      ? entities.find((e) => e.classname === 'info_landmark' && e.name === arrival.landmark) : null;
    if (arrival && arrival.landmark && !landmark) {
      console.warn(`[fount] map "${built.name}" has no info_landmark named "${arrival.landmark}"; using the player start instead`);
    }
    const startEntity = landmark || entities.find((e) => e.classname === 'info_player_start');
    const startYaw = startEntity && startEntity.angles ? startEntity.angles[1] : 0;

    this.actors = new ActorSystem({
      collision: this.collision, sprites: this.sprites, bus: this.events,
      abilityDefs: this.abilityDefs, relations: this.relations,
      nav: { top: (startEntity ? startEntity.origin[1] : 0) + 2.5, ...(cfg.nav || {}) },
    });

    if (this.mode === 'topdown') {
      const feet = startEntity ? [startEntity.origin[0], startEntity.origin[1] + 0.05, startEntity.origin[2]] : [0, 1, 0];
      this.player = this.createTopDownPlayer(feet, startYaw, arrival && arrival.carry);
      const res = this.renderer.pixel ? this.renderer.pixel.resolution : null;
      this.topCamera = new TopDownCamera(cfg.camera || {}, res);
      this.topCamera.cut(feet);
    } else {
      this.topCamera = null;
      let spawn = startEntity ? add(startEntity.origin, [0, 1.0, 0]) : [0, 3, 0];
      spawn = this.resolveSpawn(spawn);
      this.player = new Player({
        spawn,
        yaw: startYaw,
        ...(built.player || {}),
      });
      // The player reports locally-simulated damage (NPCs, explosions) so the
      // server's authoritative health stays in step with what this client sees.
      this.player.net = this.net || null;
    }

    this.world = new EntityWorld({
      collision: this.collision,
      ragdolls: this.ragdolls,
      actors: this.actors,
      particles: this.particles,
      sprites: this.sprites,
      events: this.events,
      materialIndex: built.materialIndex,
      player: this.player,
      // The one local player, in the same array shape an online server uses, so
      // an entity written for many players works unchanged in single player.
      players: [this.player],
      // The same call a server's scripts make; single player just keeps no ledger.
      economy: new Economy({ goldField: (cfg.server || {}).goldField }),
      // Alone there is no party: a share is the whole amount, and the only member is the player.
      parties: {
        membersNear: (player) => [player],
        shareXp: (player, total, apply) => { apply(player, Math.floor(total)); return [player]; },
      },
      travel: (player, map, landmark) => this.travel(map, landmark),
      listener: () => this.player.eyePosition,
      registerDynamicBrush: (brush) => this.dynamicBrushes.push(brush),
      findTriggerBrush: (name) => built.triggerBrushes.find((t) => t.name === name),
      game: this,
    });

    // Map entities get their position in the file as their id, so a server and its
    // clients agree on which entity is which without sending the list.
    built.entities.forEach((data, i) => this.world.spawn(data, { id: i + 1 }));
    this.world.finishMapSpawn();
    this.mapName = built.name;
    this.events.emit('map-loaded', { name: built.name, mode: this.mode, landmark: arrival ? arrival.landmark : null });
  }

  // ---- playing on a server ---------------------------------------------------------

  /**
   * Join a Fount server. Resolves once the map the server put you in is loaded
   * and you are standing in it. `options.hello` carries what the server asks for
   * to identify you (name, token, character...). Rejects with a message fit to
   * show a player. Leave with goOffline().
   *
   *   await game.loadConfig('game/game.json');
   *   await game.playOnline('ws://localhost:8099', { hello: { name: 'Ada' } });
   */
  async playOnline(url, options = {}) {
    this.goOffline();
    const link = new OnlineLink(this, { url, hello: options.hello });
    this.online = link;
    try {
      await link.connect(options.hello);
    } catch (err) {
      this.online = null;
      link.close();
      throw err;
    }
    return link;
  }

  /** Leave the server and go back to single-player: the next load() runs everything locally again. */
  goOffline() {
    if (this.online) { this.online.close(); this.online = null; }
    this.parties.clear();
    this.transitioning = false;
  }

  /**
   * Build the world for a map the server has put us in. The client keeps no
   * simulation: it loads the same map files for the picture and for predicting
   * its own movement, then shows whatever the server says is there.
   */
  async loadOnlineMap(link, welcome) {
    const session = link.session;
    const doc = await loadMap(welcome.map);
    await this.loadAssets(pickMapConfig(doc));
    this.currentMapPath = welcome.map;
    this.mapDoc = doc;

    const cfg = mergeConfig(this.config, pickMapConfig(doc));
    this.mapConfig = cfg;
    this.mode = 'topdown';
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();

    const built = buildMap(doc);
    this.built = built;
    this.collision = built.collision;
    this.dynamicBrushes = [];
    this.collision.setDynamicBrushes(this.dynamicBrushes);
    this.renderer.configure(cfg.render);
    this.renderer.setMaterials(built.materials);
    this.renderer.setWorldMesh(built.meshData);
    this.renderer.computeLightMatrix(built.env.sunDir, built.bounds);
    this.env = built.env;
    this.ragdolls.clear();
    this.particles.clear();
    this.floatText.clear();

    this.actors = new ReplicaActors(this, session);
    this.player = new OnlinePlayer(this, session, cfg.player || {});
    this.player.notify = (name, payload) => this.events.emit(name, payload);
    const res = this.renderer.pixel ? this.renderer.pixel.resolution : null;
    this.topCamera = new TopDownCamera(cfg.camera || {}, res);
    this.topCamera.cut(welcome.spawn);

    this.world = new EntityWorld({
      collision: this.collision,
      actors: this.actors,
      particles: this.particles,
      sprites: this.sprites,
      events: this.events,
      materialIndex: built.materialIndex,
      player: this.player,
      players: [this.player],
      travel: () => {},                       // a portal is the server's decision
      listener: () => this.player.eyePosition,
      registerDynamicBrush: (brush) => this.dynamicBrushes.push(brush),
      findTriggerBrush: (name) => built.triggerBrushes.find((t) => t.name === name),
      game: this,
    }, { side: 'client' });
    built.entities.forEach((data, i) => this.world.spawn(data, { id: i + 1 }));
    this.world.finishMapSpawn();

    session.attachWorld(this.collision);
    this.mapName = built.name;
    this.events.emit('map-loaded', { name: built.name, mode: this.mode, online: true, instance: welcome.instance, landmark: null });
  }

  /** One physics step while online: read input, predict our own movement, send it, animate the rest. */
  stepOnline(dt) {
    const P = this.player;
    stepTopDownPlayer(this, dt);
    if (this.online.ready) {
      const A = P.actor;
      this.online.session.step(dt, { mv: A.intent.move, f: A.intent.face });
    }
    this.world.update(dt);
    this.actors.update(dt);
    this.particles.update(dt);
    this.floatText.update(dt);
  }

  createTopDownPlayer(feet, yaw, carry) {
    const player = createPlayer(this.actors, this.mapConfig.player || {}, feet, yaw, carry);
    player.notify = (name, payload) => this.events.emit(name, payload);
    return player;
  }

  respawnPlayer() {
    if (this.online) return;   // the server decides when and where you come back
    this.player.respawn();
    if (this.topCamera) this.topCamera.cut(this.player.actor.feet);
    this.events.emit('respawn', this.player.actor);
  }

  /**
   * Walk through a door: fade out, load another map carrying the player's state
   * across, arrive at a named landmark, fade back in.
   */
  async travel(mapUrl, landmark = null) {
    if (this.transitioning) return;
    this.transitioning = true;
    const carry = this.mode === 'topdown' && this.player && this.player.actor ? this.player.actor.snapshot() : null;
    this.events.emit('travel', { map: mapUrl, landmark });
    playSound('portal');
    try {
      await this.fadeTo(1, 0.25);
      await this.load(mapUrl, { landmark, carry });
    } catch (err) {
      // The old map is untouched if the new one fails to load, so play on.
      console.error('[fount] travel failed:', err);
      this.events.emit('travel-failed', { map: mapUrl, error: err });
    } finally {
      await this.fadeTo(0, 0.3);
      this.transitioning = false;
    }
  }

  fadeTo(alpha, seconds) {
    return new Promise((resolve) => {
      this.fade.target = alpha;
      this.fade.speed = Math.max(0.001, Math.abs(alpha - this.fade.alpha) / Math.max(seconds, 0.01));
      this.fade.resolve = resolve;
      // A hidden tab stops the frame loop; do not hang the transition on it.
      setTimeout(() => { if (this.fade.resolve === resolve) { this.fade.alpha = alpha; this.fade.resolve = null; resolve(); } }, seconds * 1000 + 700);
    });
  }

  updateFade(dt) {
    const f = this.fade;
    if (f.alpha === f.target) return;
    const step = f.speed * dt;
    f.alpha = Math.abs(f.target - f.alpha) <= step ? f.target : f.alpha + Math.sign(f.target - f.alpha) * step;
    if (f.alpha === f.target && f.resolve) { const r = f.resolve; f.resolve = null; r(); }
  }

  // ---- RPG: what the camera is looking at, what the cursor points at ----------------

  /** Camera yaw in degrees: what sprites use to pick the facing to draw. */
  get cameraYaw() {
    if (this.mode === 'topdown' && this.topCamera) return this.topCamera.yaw;
    return this.player ? this.player.angles[1] : 0;
  }

  /** Work out what is under the mouse: a ground point and, if there is one, an actor. */
  updateHover() {
    const none = { inside: false, ground: null, actor: null, ray: null };
    if (this.mode !== 'topdown' || !this.topCamera || !this.mouseClient || !this.actors || !this.player) { this.hover = none; return; }
    const ndc = this.renderer.clientToNdc(this.mouseClient[0], this.mouseClient[1]);
    if (!ndc || !ndc.inside) { this.hover = none; return; }
    const ray = this.topCamera.ray(ndc.x, ndc.y, this.renderAspect);
    const feetY = this.player.actor.feet[1];

    // Roofs and canopies between the camera and the ground are not what you are pointing at.
    const reach = 400;
    const tr = this.collision.traceRay(ray.origin, add(ray.origin, mul(ray.dir, reach)), (b) => b.min[1] < feetY + 2.5);
    let ground = null, groundT = Infinity;
    if (tr.hit && !tr.startSolid) { ground = tr.endPos; groundT = tr.fraction * reach; }
    else {
      const plane = rayPlaneY(ray.origin, ray.dir, feetY);
      if (plane) { ground = plane.point; groundT = plane.t; }
    }

    let actor = null, best = groundT + 1.5;
    for (const a of this.actors.actors) {
      if (a.dead) continue;
      const f = a.feet;
      const hw = Math.max(a.radius * 1.2, a.sprite ? a.sprite.worldWidth * 0.4 : 0);
      const h = Math.max(a.height, a.sprite ? a.sprite.worldHeight : 0);
      const t = rayBox(ray.origin, ray.dir, [f[0] - hw, f[1], f[2] - hw], [f[0] + hw, f[1] + h, f[2] + hw]);
      if (t !== null && t < best) { best = t; actor = a; }
    }
    this.hover = { inside: true, ndc, ray, ground, actor };
  }

  /** Aim data for the player's abilities, from the cursor: { dir, point, target }. */
  aimFor(P) {
    const A = P.actor;
    const f = A.feet;
    const h = this.hover;
    let dir = null, point = null;
    if (h && h.ground) {
      point = [...h.ground];
      const dx = point[0] - f[0], dz = point[2] - f[2];
      const l = Math.hypot(dx, dz);
      if (l > 0.05) dir = [dx / l, dz / l];
    }
    if (!dir) dir = [...A.facing];
    // For abilities that need a target: whatever is under the cursor, else the
    // last thing clicked, else the nearest hostile in reach.
    let target = h && h.actor ? h.actor : null;
    if (!target && P.target && !P.target.dead) target = P.target;
    if (!target) target = this.actors.nearestHostile(A, 12);
    return { dir, point, target };
  }

  /** The nearest entity within reach that defines interact(entity, world, player). */
  interact(P) {
    const f = P.actor.feet;
    let best = null, bestD = Infinity;
    for (const e of this.world.entities) {
      if (e.removed || !e.enabled || !this.world.isInteractive(e)) continue;
      const d = dist(f, e.origin);
      if (d < e.get('interactRadius', 2) && d < bestD) { best = e; bestD = d; }
    }
    if (best && this.online) this.online.session.interact(best.id);
    else if (best) this.world.interactWith(best, P);
    this.events.emit('interact', { entity: best, player: P });
  }

  /** Everything a game's own HUD needs about the player, as plain data. */
  getHudState() {
    const P = this.player;
    if (!P || !P.actor || !this.actors) return null;
    const A = P.actor;
    const ab = this.actors.abilities;
    const shown = (a) => (a ? { name: a.name, health: a.health, maxHealth: a.maxHealth, faction: a.faction, hostile: A.isHostile(a), dead: a.dead } : null);
    const tgt = P.target && !P.target.dead ? P.target : null;
    return {
      name: A.name,
      health: A.health,
      maxHealth: A.maxHealth,
      resources: Object.fromEntries(Object.entries(A.resources).map(([k, r]) => [k, { value: r.value, max: r.max }])),
      hotbar: P.hotbar.map((id, slot) => {
        const def = id && ab.get(id);
        if (!def) return { slot, id: null };
        return {
          slot, id, name: def.name, icon: def.icon || null, key: this.input.describe(`hotbar${slot + 1}`), cost: def.cost,
          cooldown: ab.cooldownFraction(A, id), cooldownRemaining: A.cooldownRemaining(id), ready: ab.isReady(A, id),
        };
      }),
      casting: A.casting ? { id: A.casting.def.id, name: A.casting.def.name, progress: A.casting.total > 0 ? A.casting.t / A.casting.total : 1 } : null,
      statuses: A.statuses.map((s) => ({ id: s.def.id, remaining: s.remaining, duration: s.duration, stacks: s.stacks })),
      target: shown(tgt),
      hover: shown(this.hover.actor),
      data: A.data,
    };
  }

  /** Default reactions to simulation events: numbers, particles, sound. Games add their own with game.events.on(). */
  setupEvents() {
    const ev = this.events;
    const listener = () => (this.player ? this.player.eyePosition : [0, 0, 0]);
    const mine = (a) => this.player && a === this.player.actor;
    let lastError = 0;

    ev.on('damage', (e) => {
      const t = e.target;
      if (!t || !this.player || e.final <= 0) return;
      if (this.damageNumbers) {
        this.floatText.spawn(String(e.final), [t.feet[0], t.feet[1] + t.height + 0.25, t.feet[2]],
          { color: this.damageColors[e.type] || [1, 1, 1], crit: e.crit });
      }
      this.particles.burst('hit', e.point || t.chest);
      playSoundAt(e.crit ? 'crit' : (mine(t) ? 'hurt' : 'hit'), t.feet, listener(), 40);
    });
    ev.on('heal', (e) => {
      if (!this.player || e.amount <= 0) return;
      const t = e.target;
      this.floatText.spawn(`+${Math.round(e.amount)}`, [t.feet[0], t.feet[1] + t.height + 0.25, t.feet[2]], { color: [0.45, 1, 0.55] });
      this.particles.burst('heal', t.feet);
      playSoundAt('heal', t.feet, listener(), 30);
    });
    ev.on('death', (a) => {
      if (this.player) playSoundAt(mine(a) ? 'die' : 'enemydie', a.feet, listener(), 40);
    });
    // Generic notifications a script sends with player.notify(name, payload).
    // 'toast' floats text over the local player; 'floatText' puts it at a position.
    const floating = (e) => {
      const A = this.player && this.player.actor;
      const at = e.pos || (A && [A.feet[0], A.feet[1] + A.height + 0.9, A.feet[2]]);
      if (!at) return;
      this.floatText.spawn(e.text, at, {
        color: e.color || [1, 0.94, 0.63], life: e.life ?? 2.2, rise: e.rise ?? 0.8, scale: e.scale ?? 2, outline: e.outline || [0.05, 0.03, 0.03],
      });
    };
    ev.on('toast', floating);
    ev.on('floatText', floating);
    ev.on('fx', (e) => this.particles.burst(e.preset, e.pos, { count: e.count }));
    ev.on('sound', (e) => {
      if (e.pos && this.player) playSoundAt(e.name, e.pos, listener(), 45);
      else playSound(e.name);
    });
    ev.on('melee', (e) => { if (this.player) playSoundAt('swing', e.source.feet, listener(), 35); });
    ev.on('aggro', (a) => this.particles.burst('notice', [a.feet[0], a.feet[1] + a.height + 0.2, a.feet[2]], { count: 1 }));
    ev.on('ability-failed', (e) => {
      const now = performance.now();
      if (e.reason !== 'cooldown' && e.reason !== 'busy' && now - lastError > 300) { lastError = now; playSound('error'); }
    });
  }

  /**
   * A spawn buried in geometry leaves the player stuck with no obvious cause —
   * an easy mistake to make when writing map JSON by hand. Lift the spawn to
   * free space if we can, and say so loudly rather than failing silently.
   */
  resolveSpawn(spawn) {
    const half = [0.35, 0.9, 0.35];
    if (!this.collision.pointInSolid(spawn, half)) {
      this.spawnWarning = '';
      return spawn;
    }
    for (let lift = 0.5; lift <= 12; lift += 0.5) {
      const candidate = [spawn[0], spawn[1] + lift, spawn[2]];
      if (!this.collision.pointInSolid(candidate, half)) {
        this.spawnWarning = `info_player_start is inside solid geometry — lifted ${lift.toFixed(1)}m`;
        console.warn('[fount]', this.spawnWarning, spawn);
        return candidate;
      }
    }
    this.spawnWarning = 'info_player_start is inside solid geometry and could not be freed';
    console.warn('[fount]', this.spawnWarning, spawn);
    return spawn;
  }

  bindInput() {
    const canvas = this.canvas;

    window.addEventListener('keydown', (e) => {
      // Typing in the console (or any text field) must not also drive the game.
      if (this.typingElsewhere(e)) return;
      if (e.code === 'Tab') e.preventDefault();
      // Arrow keys would scroll the page, and they're the one look control
      // that works even where the mouse can't be captured at all.
      if (e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
      this.input.keyDown(e.code);
      unlockAudio();
      if (e.code === 'KeyR' && e.shiftKey) this.restart();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.input.keyUp(e.code); });
    window.addEventListener('blur', () => {
      this.keys.clear(); this.input.clear(); this.dragLook = false; this.mouseClient = null;
    });

    canvas.addEventListener('click', () => {
      unlockAudio();
      if (!this.editorMode && document.pointerLockElement !== canvas) this.requestLook();
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      if (this.pointerLocked) this.lookBlocked = false;
    });

    // Pointer lock can be refused for reasons the page cannot see: an embedded
    // frame, a browser policy, a stale user gesture. Left unhandled that is a
    // silent dead mouse, so record it and let the drag fallback take over.
    document.addEventListener('pointerlockerror', () => {
      this.pointerLocked = false;
      this.lookBlocked = true;
      console.warn('[fount] pointer lock was refused — drag-to-look and arrow keys still work.');
    });

    document.addEventListener('mousemove', (e) => {
      this.mouseClient = [e.clientX, e.clientY];
      if (this.pointerLocked) {
        this.applyLook(e.movementX, e.movementY);
        return;
      }
      if (!this.dragLook) return;
      const dx = e.clientX - this.lastMouse[0];
      const dy = e.clientY - this.lastMouse[1];
      this.lastMouse = [e.clientX, e.clientY];
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      this.applyLook(dx, dy);
    });

    // Top-down: the cursor stays free and every button is just an input action.
    canvas.addEventListener('mousedown', (e) => {
      if (this.mode !== 'topdown') return;
      unlockAudio();
      this.input.mouseDown(e.button);
      e.preventDefault();
    });
    canvas.addEventListener('contextmenu', (e) => { if (this.mode === 'topdown') e.preventDefault(); });
    canvas.addEventListener('mouseleave', () => { if (this.mode === 'topdown') this.mouseClient = null; });
    canvas.addEventListener('wheel', (e) => {
      const cam = this.mapConfig.camera;
      if (this.mode === 'topdown' && this.topCamera && cam && cam.wheelZoom) {
        this.topCamera.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      if (this.mode === 'topdown') return;
      if (e.button !== 0) return;
      if (this.pointerLocked) {
        this.mouseDown = true;
        return;
      }
      // Without pointer lock, hold-and-drag aims. The shot is deferred to
      // mouseup so a drag doesn't also fire a bullet at whatever you passed.
      this.dragLook = true;
      this.dragDistance = 0;
      this.lastMouse = [e.clientX, e.clientY];
      e.preventDefault();
    });

    window.addEventListener('mouseup', (e) => {
      this.input.mouseUp(e.button);
      if (this.dragLook) {
        this.dragLook = false;
        if (this.dragDistance < 6) this.fire();
      }
      this.mouseDown = false;
    });
  }

  /** True when keystrokes belong to the console or another text field. */
  typingElsewhere(e) {
    if (this.console && this.console.open) return true;
    const el = e.target;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  /** The one place camera angles move, whatever the input route. */
  applyLook(dx, dy) {
    if (!this.player) return;
    this.player.angles[1] -= dx * this.sensitivity;
    this.player.angles[0] = clamp(this.player.angles[0] + dy * this.sensitivity, -89, 89);
  }

  requestLook() {
    if (this.mode === 'topdown') return; // the cursor is the interface here
    const result = this.canvas.requestPointerLock();
    // Newer browsers return a promise; an unhandled rejection here is exactly
    // how this failure used to disappear without a trace.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        this.lookBlocked = true;
        console.warn('[fount] pointer lock was refused — drag-to-look and arrow keys still work.');
      });
    }
  }

  restart() {
    if (!this.mapDoc) return;
    // Restarting a map you arrived at by door puts you back at that door.
    if (this.lastArrival) this.arrival = { landmark: this.lastArrival.landmark, carry: null };
    this.loadMapDocument(this.mapDoc);
  }

  /** Where the player is looking, used by console spawn commands. */
  aimPoint(maxRange = 60) {
    if (this.mode === 'topdown' && this.hover && this.hover.ground) {
      return [this.hover.ground[0], this.hover.ground[1] + 0.3, this.hover.ground[2]];
    }
    const origin = this.player.eyePosition;
    const end = add(origin, mul(this.player.forward, maxRange));
    const trace = this.collision.traceRay(origin, end);
    const point = trace.hit ? trace.endPos : end;
    // Lift off the surface so a spawned entity isn't born inside the floor.
    return [point[0], point[1] + 0.3, point[2]];
  }

  wishDirection() {
    if (this.player.dead) return [0, 0, 0];
    const forward = anglesToForward([0, this.player.angles[1], 0]);
    const right = anglesToRight(this.player.angles);
    let wish = [0, 0, 0];
    if (this.input.isDown('forward')) wish = add(wish, forward);
    if (this.input.isDown('back')) wish = sub(wish, forward);
    if (this.input.isDown('right')) wish = add(wish, right);
    if (this.input.isDown('left')) wish = sub(wish, right);
    wish[1] = 0;
    return wish;
  }

  // Hitscan: trace the world first, then see whether any NPC body is closer.
  // Where it lands decides the ragdoll impulse point, so a head hit throws the
  // head and a leg hit drops them.
  fire() {
    const player = this.player;
    if (player.dead || player.ammo <= 0 || player.fireCooldown > 0) return;
    player.fireCooldown = 0.11;
    player.ammo--;
    playSound('shoot');

    const origin = player.eyePosition;
    const dir = player.forward;
    const maxRange = 120;
    const end = add(origin, mul(dir, maxRange));

    if (this.net && this.net.connected) this.net.reportShot(origin, dir);

    const worldTrace = this.collision.traceRay(origin, end);
    let bestDist = worldTrace.hit ? worldTrace.fraction * maxRange : maxRange;
    let hitEntity = null;
    let hitPoint = worldTrace.endPos;

    // Remote players are checked against the same ray as NPCs, so geometry
    // between you and them still blocks the shot.
    if (this.net && this.net.connected) {
      const remote = this.net.pickPlayer(origin, dir, bestDist);
      if (remote) {
        const point = add(origin, mul(dir, remote.t));
        this.net.reportHit(remote.player.id, point.map((n) => +n.toFixed(2)));
        playSoundAt('impact', point, this.player.eyePosition, 40);
        return;
      }
    }

    for (const entity of this.world.entities) {
      if (entity.removed || entity.classname !== 'npc_grunt' || entity.state.dead) continue;
      const ctrl = entity.state.controller;
      const c = ctrl.position;
      const h = ctrl.halfExtents;
      const min = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
      const max = [c[0] + h[0], c[1] + h[1] + 0.35, c[2] + h[2]];
      const t = rayBox(origin, dir, min, max);
      if (t !== null && t < bestDist) {
        bestDist = t;
        hitEntity = entity;
        hitPoint = add(origin, mul(dir, t));
      }
    }

    if (hitEntity) {
      const isHeadshot = hitPoint[1] > hitEntity.state.controller.position[1] + 0.55;
      const damage = isHeadshot ? 100 : 25;
      hitEntity.state.health -= damage;
      this.world.fireOutput(hitEntity, 'OnDamaged', null, String(hitEntity.state.health));

      if (hitEntity.state.health <= 0) {
        killNPC(hitEntity, this.world, {
          impulse: mul(dir, isHeadshot ? 16 : 9),
          hitPoint,
          impulseRadius: isHeadshot ? 0.55 : 1.0,
        });
        this.player.kills++;
      } else {
        playSoundAt('impact', hitPoint, this.player.eyePosition, 30);
        playSoundAt('hurt', hitPoint, this.player.eyePosition, 30);
      }
    } else if (worldTrace.hit) {
      playSoundAt('impact', hitPoint, this.player.eyePosition, 40);
      // Shooting a physics prop shoves it, which makes the world feel reactive.
      for (const entity of this.world.entities) {
        if (entity.removed || !entity.state.body) continue;
        const b = entity.state.body;
        const min = sub(b.position, b.halfExtents);
        const max = add(b.position, b.halfExtents);
        const t = rayBox(origin, dir, min, max);
        if (t !== null && t <= bestDist + 0.5) {
          b.addImpulse(mul(dir, 7));
          break;
        }
      }
    }

    // Bullets nudge bodies too.
    for (const ragdoll of this.ragdolls.ragdolls) {
      if (dist(ragdoll.center, hitPoint) < 1.2) {
        const idx = ragdoll.nearestParticle(hitPoint);
        ragdoll.applyImpulse(mul(dir, 6), ragdoll.positions[idx], 0.7);
      }
    }
  }

  /** Keyboard look. Needs no mouse capture, so it works everywhere. */
  keyboardLook(dt) {
    const turn = 115 * dt;
    if (this.keys.has('ArrowLeft')) this.applyLook(-turn / this.sensitivity, 0);
    if (this.keys.has('ArrowRight')) this.applyLook(turn / this.sensitivity, 0);
    if (this.keys.has('ArrowUp')) this.applyLook(0, -turn / this.sensitivity);
    if (this.keys.has('ArrowDown')) this.applyLook(0, turn / this.sensitivity);
  }

  stepTopDown(dt) {
    if (this.online) { this.stepOnline(dt); return; }
    stepTopDownPlayer(this, dt);
    this.world.update(dt);
    this.actors.update(dt);
    this.particles.update(dt);
    this.floatText.update(dt);
  }

  step(dt) {
    if (this.mode === 'topdown') { this.stepTopDown(dt); return; }
    const player = this.player;
    player.prevPosition = [...player.controller.position];
    this.keyboardLook(dt);
    player.fireCooldown = Math.max(0, player.fireCooldown - dt);
    player.damageFlash = Math.max(0, player.damageFlash - dt * 2.2);

    if (player.dead) {
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) {
        // On a server the respawn is the server's to grant: it picks the spawn
        // point and the moment, and replies with a 'respawn' we act on. Coming
        // back to life locally would be a claim the server does not honour.
        if (this.net && this.net.connected) this.net.requestRespawn();
        else player.respawn();
      }
    } else if (player.noclip) {
      // Free flight, ignoring geometry entirely. Space/Shift climb and drop.
      const wish = this.wishDirection();
      const forward = anglesToForward(player.angles);
      const vertical = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ShiftLeft') ? 1 : 0);
      const speed = player.controller.maxSpeed * 2.2;
      const dir = len(wish) > 0 ? norm(wish) : [0, 0, 0];
      // Pitch matters while flying, so W follows where you're actually looking.
      const move = add(mul(dir, speed), mul(forward, len(wish) > 0 ? forward[1] * speed : 0));
      player.controller.position = add(player.controller.position, mul(move, dt));
      player.controller.position[1] += vertical * speed * dt;
      player.controller.velocity = [0, 0, 0];
    } else {
      const wish = this.wishDirection();
      const wantJump = this.input.isDown('jump');
      const wasAir = !player.controller.onGround;
      player.controller.update(this.collision, wish, wantJump, dt);

      if (player.controller.justJumped) playSound('jump', 0.6);
      if (player.controller.justLanded && wasAir) playSound('land', 0.5);

      // Footsteps keyed to distance travelled rather than time, so they stay
      // in sync whether walking or sprinting.
      if (player.controller.onGround) {
        const speed = Math.hypot(player.controller.velocity[0], player.controller.velocity[2]);
        player.stepAccum += speed * dt;
        if (player.stepAccum > 2.2) {
          player.stepAccum = 0;
          playSound('step', 0.5);
        }
      }

      if (player.position[1] < -60 && !(this.net && this.net.connected)) {
        // Offline only: on a server, health belongs to the server, which does
        // this check itself. Doing it locally too would mean two authorities
        // disagreeing about who is alive.
        player.takeDamage(1000, null);
      }
    }

    // Keyboard fire. Several bindings because the obvious one (Space) is jump,
    // and because a player whose browser refuses mouse capture still needs a
    // way to shoot. Ctrl is the classic FPS fire key; F and Enter are safe
    // alternatives that no browser shortcut claims on their own.
    const keyboardFire = this.input.isDown('fire');
    if (this.mouseDown || keyboardFire) this.fire();

    this.world.update(dt);
    this.actors.update(dt);
    this.particles.update(dt);
    this.floatText.update(dt);
    this.ragdolls.update(this.collision, dt);
    if (this.net && this.net.connected) this.net.reportSelf();
  }

  render() {
    const aspect = this.renderer.resize();
    this.renderAspect = aspect;
    const player = this.player;
    const alpha = this.renderAlpha ?? 1;

    if (this.online && this.online.ready) this.online.session.updateRender(this.frameDt);

    let camera, yaw;
    if (this.mode === 'topdown' && this.topCamera) {
      this.topCamera.update(this.frameDt, player.actor.drawPosition(alpha));
      camera = this.topCamera.state();
      yaw = this.topCamera.yaw;
    } else {
      camera = {
        // View angles are deliberately *not* interpolated: they come straight
        // from input, and blending them would add a frame of aim latency.
        position: player.interpolatedEye(alpha),
        forward: player.forward,
        fov: this.fov ?? 78,
      };
      yaw = player.angles[1];
    }
    this.updateHover();

    this.env.pointLights = this.world.collectPointLights();
    this.renderer.setTime(this.renderTime);
    this.renderer.setFade(this.fade.alpha);

    this.renderer.beginShadowPass();
    this.renderer.drawWorld(true);
    this.world.draw(this.renderer, true);
    this.ragdolls.draw(this.renderer, true, alpha);
    if (this.net) this.net.draw(this.renderer, true);
    this.renderer.endShadowPass();

    this.renderer.beginFrame(camera, this.env, aspect);
    this.renderer.drawWorld(false);
    this.world.draw(this.renderer, false);
    this.actors.draw(this.renderer, yaw, alpha);
    this.particles.draw(this.renderer);
    this.floatText.draw(this.renderer);
    if (this.online) this.nameplates.draw(this.renderer);
    this.ragdolls.draw(this.renderer, false, alpha);
    if (this.net) this.net.draw(this.renderer, false);
    this.renderer.endFrame();
  }

  updateHUD() {
    if (!this.hud) return;
    const p = this.player;
    this.hud.update({
      health: Math.ceil(p.health),
      ammo: p.ammo,
      kills: p.kills,
      ragdolls: this.ragdolls.count,
      fps: Math.round(this.fps),
      dead: p.dead,
      damageFlash: p.damageFlash,
      entities: this.world.entities.length,
      map: this.mapName,
      pointerLocked: this.pointerLocked,
      lookBlocked: this.lookBlocked,
      debug: this.spawnWarning || this.debugText,
      // For games that replace the stock HUD: see getHudState() and docs/rpg.md.
      mode: this.mode,
      cursor: this.mode === 'topdown' ? 'free' : (this.pointerLocked ? 'locked' : 'free'),
      fade: this.fade.alpha,
      player: this.mode === 'topdown' ? this.getHudState() : null,
    });
  }

  frame(now) {
    // start() is called immediately while load() is still in flight, so the
    // first frames run before there's a world to draw.
    if (!this.world || !this.player) {
      requestAnimationFrame((t) => this.frame(t));
      return;
    }
    if (!this.lastTime) this.lastTime = now;
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // A long stall (tab in background) must not be simulated all at once.
    if (frameTime > 0.25) frameTime = 0.25;
    this.frameDt = frameTime;
    this.renderTime += frameTime;   // drives animated materials, independent of pause and timescale
    this.updateFade(frameTime);

    this.fpsAccum += frameTime;
    this.frameCount++;
    if (this.fpsAccum >= 0.4) {
      this.fps = this.frameCount / this.fpsAccum;
      this.fpsAccum = 0;
      this.frameCount = 0;
    }

    if (!this.paused) {
      this.accumulator += frameTime * (this.timescale ?? 1);
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      // Only reachable if a single frame exceeded the 0.25s clamp's worth of
      // steps, which it cannot — kept as a guard against a spiral of death.
      if (steps === MAX_SUBSTEPS && this.accumulator > FIXED_DT) this.accumulator = 0;
    }

    // Physics runs at a fixed rate but frames land between steps, so drawing
    // raw step output makes objects advance in uneven hops. Rendering the
    // in-between state is what turns that into smooth motion.
    this.renderAlpha = clamp(this.accumulator / FIXED_DT, 0, 1);

    this.render();
    this.updateHUD();
    requestAnimationFrame((t) => this.frame(t));
  }

  start() {
    requestAnimationFrame((t) => this.frame(t));
  }
}

export { defineEntity, pointInBrush };
