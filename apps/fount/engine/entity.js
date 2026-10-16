// Entity system with Source-style outputs and inputs.
//
// The IO system is the reason this engine is worth authoring for: level logic
// is declared as data ("when this trigger fires OnStartTouch, send Open to
// door_1 after 0.5s") rather than written as code. That means a whole level's
// behaviour is a JSON file Claude can write, review, and revise in one edit.
//
// Online games run an entity in two places. The SERVER half owns its logic and
// state (spawn, think, inputs, interact); the CLIENT half only shows it (spawn,
// think for cosmetics, draw) from state the server replicates. A class opts in
// by splitting its definition:
//
//   defineEntity('portal_gate', {
//     server: { spawn, think, inputs, interact, replicate, visibleTo },
//     client: { spawn, think, draw, apply },
//   });
//
// A flat class (spawn/think/draw/inputs at the top level) keeps working: in a
// single-player game both halves run on the one entity, exactly as before. In an
// online game a flat class runs entirely on the server and the client calls only
// its draw(), against entity.state as replicated (plain values only).

const registry = new Map();

/**
 * Register a behaviour for a classname.
 * spec: flat { spawn, think, inputs, interact, draw }, or split { server: {...}, client: {...} }.
 */
export function defineEntity(classname, spec) {
  registry.set(classname, spec);
}

export function getEntityDefinition(classname) {
  return registry.get(classname);
}

export function registeredClassnames() {
  return [...registry.keys()].sort();
}

/** True for a class written as { server, client } halves rather than a flat spec. */
export function isSplit(spec) {
  return !!(spec && (spec.server || spec.client));
}

// ---------------------------------------------------------------------------
// Replicable state
// ---------------------------------------------------------------------------

function isPlain(v, depth = 0) {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return true;
  if (depth > 3) return false;
  if (Array.isArray(v)) return v.length <= 64 && v.every((x) => isPlain(x, depth + 1));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.values(v).every((x) => isPlain(x, depth + 1));
  }
  return false;
}

/** The plain-data part of an entity's state: what replicates by default. Keys starting with "_" stay private. */
export function plainState(state) {
  const out = {};
  for (const [k, v] of Object.entries(state || {})) {
    if (k[0] !== '_' && isPlain(v)) out[k] = v;
  }
  return out;
}

let nextId = 1;
const warnedDraw = new Set();

export class Entity {
  constructor(data, id = null) {
    this.id = id ?? nextId++;
    this.classname = data.classname;
    this.name = data.name || '';
    this.origin = data.origin ? [...data.origin] : [0, 0, 0];
    this.angles = data.angles ? [...data.angles] : [0, 0, 0];
    // Copied, not shared: fireOutput() marks `once` connections as fired on
    // the connection object, and restart() re-spawns from the same map JSON.
    this.connections = (data.connections || []).map((c) => ({ ...c }));
    this.kv = { ...data };
    this.removed = false;
    this.enabled = data.enabled !== false;
    this.state = {};
    this.dynamic = false;        // spawned at runtime rather than from the map file
    this.visibleTo = null;       // (player) => boolean, server side: hide this entity from some players
    this.playerStates = null;
  }

  get(key, fallback) {
    const v = this.kv[key];
    return v === undefined ? fallback : v;
  }

  /**
   * State that belongs to one player rather than to the entity: a herb this
   * player has picked, a key only they can see. Created on first use. In a
   * single-player game there is one player and this is just a second `state`.
   */
  stateFor(playerId) {
    if (!this.playerStates) this.playerStates = new Map();
    let s = this.playerStates.get(playerId);
    if (!s) this.playerStates.set(playerId, (s = {}));
    return s;
  }

  /** Show this entity to only the given players (ids), or to everyone with null. */
  showOnlyTo(playerIds) {
    this.visibleTo = playerIds ? (p) => playerIds.includes(p.id) : null;
  }
}

/**
 * Give a world context the helpers every entity expects for finding players.
 * `context.players` is the live array of players; the creator keeps it current.
 */
export function installPlayerHelpers(context) {
  if (!Array.isArray(context.players)) context.players = [];
  const alive = (p, includeDead) => includeDead || !p.actor.dead;
  context.playerOf ||= (actor) => context.players.find((p) => p.actor === actor) || null;
  context.playersInRadius ||= (point, radius, options = {}) => context.players.filter((p) => {
    if (!alive(p, options.includeDead)) return false;
    const f = p.actor.feet;
    return Math.hypot(f[0] - point[0], f[2] - point[2]) <= radius;
  });
  context.playersInBox ||= (min, max, options = {}) => context.players.filter((p) => {
    if (!alive(p, options.includeDead)) return false;
    const f = p.actor.feet;
    return f[0] > min[0] && f[0] < max[0] && f[2] > min[2] && f[2] < max[2] && f[1] > min[1] - 1.5 && f[1] < max[1] + 1.5;
  });
  return context;
}

export class EntityWorld {
  /**
   * `side` says which halves of a class run here: 'both' (single player: the
   * default), 'server' (an online instance) or 'client' (an online player).
   */
  constructor(context, options = {}) {
    // `context` carries engine services (collision, ragdolls, audio, player)
    // so entity behaviours never reach for globals.
    this.context = installPlayerHelpers(context);
    this.side = options.side || 'both';
    this.runsServer = this.side !== 'client';
    this.runsClient = this.side !== 'server';
    this.entities = [];
    this.byName = new Map();
    this.byId = new Map();
    this.pendingEvents = [];
    this.time = 0;
    this.nextDynamicId = options.firstDynamicId ?? 1_000_000;
    this.onSpawn = null;     // (entity) hook: the replication layer announces runtime spawns
    this.onRemove = null;
  }

  // ---- choosing which half of a class runs here ----------------------------

  serverHalf(def) { return isSplit(def) ? (def.server || null) : def; }
  clientHalf(def) { return isSplit(def) ? (def.client || null) : null; }

  /**
   * Create an entity. `options.id` fixes its id (map entities get theirs from
   * their position in the file, so server and client agree); runtime spawns get
   * the next dynamic id and are announced to clients.
   */
  spawn(data, options = {}) {
    const dynamic = options.dynamic ?? this.mapSpawnDone === true;
    const id = options.id ?? (dynamic ? this.nextDynamicId++ : null);
    const entity = new Entity(data, id);
    entity.dynamic = dynamic;
    this.entities.push(entity);
    this.byId.set(entity.id, entity);
    if (entity.name) {
      if (!this.byName.has(entity.name)) this.byName.set(entity.name, []);
      this.byName.get(entity.name).push(entity);
    }
    const def = registry.get(entity.classname);
    if (def) {
      if (this.runsServer) { const h = this.serverHalf(def); if (h && h.spawn) h.spawn(entity, this); }
      if (this.runsClient) { const h = this.clientHalf(def); if (h && h.spawn) h.spawn(entity, this); }
    }
    if (dynamic && this.onSpawn) this.onSpawn(entity);
    return entity;
  }

  /** Call once all map entities exist: from here on, spawn() means a runtime spawn. */
  finishMapSpawn() { this.mapSpawnDone = true; }

  find(name) {
    return this.byName.get(name) || [];
  }

  findById(id) { return this.byId.get(id) || null; }

  findByClass(classname) {
    return this.entities.filter((e) => e.classname === classname && !e.removed);
  }

  remove(entity) {
    if (entity.removed) return;
    entity.removed = true;
    if (this.onRemove) this.onRemove(entity);
  }

  /** Forget everything held for a player who has left. */
  forgetPlayer(playerId) {
    for (const e of this.entities) if (e.playerStates) e.playerStates.delete(playerId);
  }

  /**
   * Fire a named output. Every connection listening for it is queued with its
   * own delay, so `OnDeath -> open door after 2s` needs no timer bookkeeping
   * in the entity that died. Only the server half runs logic, so a client
   * world ignores this.
   */
  fireOutput(entity, outputName, activator = null, overrideParam = undefined) {
    if (!this.runsServer || !entity.connections) return;
    for (const conn of entity.connections) {
      if (conn.output !== outputName) continue;
      if (conn._fired && conn.once) continue;
      conn._fired = true;
      this.pendingEvents.push({
        time: this.time + (conn.delay || 0),
        target: conn.target,
        input: conn.input,
        param: overrideParam !== undefined ? overrideParam : conn.param,
        activator,
        caller: entity,
      });
    }
  }

  inputsOf(def) {
    const h = this.serverHalf(def);
    return h && h.inputs ? h.inputs : null;
  }

  /** Send an input directly to every entity matching `targetName`. */
  sendInput(targetName, inputName, ctx = {}) {
    if (!targetName || !this.runsServer) return;
    const targets = targetName === '!activator' && ctx.activator
      ? [ctx.activator]
      : targetName === '!caller' && ctx.caller
        ? [ctx.caller]
        : this.find(targetName);

    for (const target of targets) {
      if (target.removed) continue;
      const def = registry.get(target.classname);

      // A class's own handler always wins. The universal fallbacks below are
      // conveniences for entities that don't implement them — running them
      // first would mean `Kill` on an NPC deleted it outright instead of
      // letting npc_grunt's handler play the death and leave a ragdoll.
      const inputs = def ? this.inputsOf(def) : null;
      if (inputs && inputs[inputName]) {
        inputs[inputName](target, this, ctx);
        continue;
      }

      if (inputName === 'Enable') { target.enabled = true; continue; }
      if (inputName === 'Disable') { target.enabled = false; continue; }
      if (inputName === 'Kill') { this.remove(target); continue; }
      if (inputName === 'Toggle') { target.enabled = !target.enabled; continue; }
    }
  }

  /** Let a player use an entity (talk, loot, open). Returns true if the class handles interaction. */
  interactWith(entity, player) {
    if (!this.runsServer || entity.removed || !entity.enabled) return false;
    const def = registry.get(entity.classname);
    const h = def && this.serverHalf(def);
    if (!h || !h.interact) return false;
    h.interact(entity, this, player);
    return true;
  }

  /** Does this entity's class define interact()? Used to find something near a player to talk to. */
  isInteractive(entity) {
    const def = registry.get(entity.classname);
    const h = def && this.serverHalf(def);
    return !!(h && h.interact);
  }

  update(dt) {
    this.time += dt;

    // Snapshot before dispatch: an input that fires another output must land
    // on the next pass rather than mutating the list mid-iteration.
    if (this.pendingEvents.length) {
      const due = [];
      const remaining = [];
      for (const ev of this.pendingEvents) {
        (ev.time <= this.time ? due : remaining).push(ev);
      }
      this.pendingEvents = remaining;
      for (const ev of due) {
        this.sendInput(ev.target, ev.input, { activator: ev.activator, caller: ev.caller, param: ev.param });
      }
    }

    for (const entity of this.entities) {
      if (entity.removed || !entity.enabled) continue;
      const def = registry.get(entity.classname);
      if (!def) continue;
      if (this.runsServer) { const h = this.serverHalf(def); if (h && h.think) h.think(entity, this, dt); }
      if (this.runsClient) { const h = this.clientHalf(def); if (h && h.think) h.think(entity, this, dt); }
    }

    if (this.entities.some((e) => e.removed)) {
      for (const [name, list] of this.byName) {
        const filtered = list.filter((e) => !e.removed);
        if (filtered.length) this.byName.set(name, filtered);
        else this.byName.delete(name);
      }
      for (const e of this.entities) if (e.removed) this.byId.delete(e.id);
      this.entities = this.entities.filter((e) => !e.removed);
    }
  }

  draw(renderer, shadowPass = false) {
    if (!this.runsClient) return;
    for (const entity of this.entities) {
      if (entity.removed) continue;
      const def = registry.get(entity.classname);
      if (!def) continue;
      const draw = isSplit(def) ? (def.client && def.client.draw) : def.draw;
      if (!draw) continue;
      if (this.side === 'client' && !isSplit(def)) {
        // A flat class drawing from replicated state may reach for something its
        // spawn() would have created on a client. Say so once rather than crash the frame.
        try { draw(entity, renderer, shadowPass, this); } catch (err) {
          if (!warnedDraw.has(entity.classname)) {
            warnedDraw.add(entity.classname);
            console.warn(`[fount] ${entity.classname}.draw failed on the client (${err.message}). A flat class runs only on the server online; split it into { server, client } halves.`);
          }
        }
      } else {
        draw(entity, renderer, shadowPass, this);
      }
    }
  }

  collectPointLights() {
    const lights = [];
    for (const entity of this.entities) {
      if (entity.removed || !entity.enabled) continue;
      if (entity.classname !== 'light') continue;
      lights.push({
        position: entity.origin,
        color: entity.get('color', [1, 0.9, 0.7]).map((c) => c * entity.get('brightness', 1)),
        radius: entity.get('radius', 8),
      });
    }
    return lights;
  }

  // ---- replication ------------------------------------------------------------

  /** What the server tells clients about an entity: its class's replicate(), else its plain state. */
  replicate(entity) {
    const def = registry.get(entity.classname);
    const h = def && this.serverHalf(def);
    if (h && h.replicate) return h.replicate(entity, this) || {};
    return plainState(entity.state);
  }

  /** Client side: take replicated state from the server. */
  applyReplicated(entity, data) {
    const def = registry.get(entity.classname);
    const h = def && this.clientHalf(def);
    if (h && h.apply) h.apply(entity, data, this);
    else Object.assign(entity.state, data);
  }
}

