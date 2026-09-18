// Entity system with Source-style outputs and inputs.
//
// The IO system is the reason this engine is worth authoring for: level logic
// is declared as data ("when this trigger fires OnStartTouch, send Open to
// door_1 after 0.5s") rather than written as code. That means a whole level's
// behaviour is a JSON file Claude can write, review, and revise in one edit.

import { add, sub, mul, dist, norm } from './math.js';

const registry = new Map();

/**
 * Register a behaviour for a classname.
 * spec: { spawn(entity, world), think(entity, world, dt), inputs: {Name(entity, world, ctx)}, draw(entity, renderer, shadowPass) }
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

let nextId = 1;

export class Entity {
  constructor(data) {
    this.id = nextId++;
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
  }

  get(key, fallback) {
    const v = this.kv[key];
    return v === undefined ? fallback : v;
  }
}

export class EntityWorld {
  constructor(context) {
    // `context` carries engine services (collision, ragdolls, audio, player)
    // so entity behaviours never reach for globals.
    this.context = context;
    this.entities = [];
    this.byName = new Map();
    this.pendingEvents = [];
    this.time = 0;
  }

  spawn(data) {
    const entity = new Entity(data);
    this.entities.push(entity);
    if (entity.name) {
      if (!this.byName.has(entity.name)) this.byName.set(entity.name, []);
      this.byName.get(entity.name).push(entity);
    }
    const def = registry.get(entity.classname);
    if (def && def.spawn) def.spawn(entity, this);
    return entity;
  }

  find(name) {
    return this.byName.get(name) || [];
  }

  findByClass(classname) {
    return this.entities.filter((e) => e.classname === classname && !e.removed);
  }

  remove(entity) {
    entity.removed = true;
  }

  /**
   * Fire a named output. Every connection listening for it is queued with its
   * own delay, so `OnDeath -> open door after 2s` needs no timer bookkeeping
   * in the entity that died.
   */
  fireOutput(entity, outputName, activator = null, overrideParam = undefined) {
    if (!entity.connections) return;
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

  /** Send an input directly to every entity matching `targetName`. */
  sendInput(targetName, inputName, ctx = {}) {
    if (!targetName) return;
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
      if (def && def.inputs && def.inputs[inputName]) {
        def.inputs[inputName](target, this, ctx);
        continue;
      }

      if (inputName === 'Enable') { target.enabled = true; continue; }
      if (inputName === 'Disable') { target.enabled = false; continue; }
      if (inputName === 'Kill') { this.remove(target); continue; }
      if (inputName === 'Toggle') { target.enabled = !target.enabled; continue; }
    }
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
      if (def && def.think) def.think(entity, this, dt);
    }

    if (this.entities.some((e) => e.removed)) {
      for (const [name, list] of this.byName) {
        const filtered = list.filter((e) => !e.removed);
        if (filtered.length) this.byName.set(name, filtered);
        else this.byName.delete(name);
      }
      this.entities = this.entities.filter((e) => !e.removed);
    }
  }

  draw(renderer, shadowPass = false) {
    for (const entity of this.entities) {
      if (entity.removed) continue;
      const def = registry.get(entity.classname);
      if (def && def.draw) def.draw(entity, renderer, shadowPass, this);
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
}
