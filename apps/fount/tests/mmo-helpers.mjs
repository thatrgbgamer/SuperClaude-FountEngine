// Shared scaffolding for the online tests: a throwaway game folder to serve, and
// a headless bot that plays through the real protocol with the real NetSession.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMap } from '../engine/map.js';
import { NetSession } from '../engine/netcode.js';
import { Relations } from '../engine/combat.js';
import { SIM_DT, STEPS_PER_COMMAND, COMMAND_HZ } from '../engine/protocol.js';

const SPRITE = {
  name: 'dummy', size: [4, 4], palette: { '.': null, k: '#222222' },
  animations: { idle: { frames: [['kkkk', 'kkkk', 'kkkk', 'kkkk']] }, death: { loop: false, frames: [['....', '....', '....', 'kkkk']] } },
};

const ABILITIES = {
  strike: { name: 'Strike', cooldown: 0.4, castTime: 0.1, targeting: 'direction', range: 1.6, anim: 'attack',
    effects: [{ type: 'melee', range: 1.6, arc: 120, damage: { type: 'physical', amount: [20, 20] } }] },
  bolt: { name: 'Bolt', cooldown: 1, cost: { mana: 10 }, castTime: 0.2, targeting: 'direction', range: 14,
    effects: [{ type: 'projectile', speed: 16, radius: 0.3, damage: { type: 'fire', amount: [30, 30] } }] },
  secret: { name: 'Secret', cooldown: 1, targeting: 'self', effects: [] },
};

const floor = (half) => ({ type: 'box', min: [-half, -1, -half], max: [half, 0, half] });

export function makeGameFolder(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fount-mmo-'));
  const write = (rel, data) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data));
  };
  write('game/game.json', {
    name: 'testgame',
    server: { startMap: 'game/maps/arena.json' },
    player: { health: 100, speed: 6, resources: { mana: { max: 50, regen: 3 } }, hotbar: ['strike', 'bolt'], respawnDelay: 1 },
    spriteDefs: [SPRITE],
    abilities: ABILITIES,
    ...extra.config,
  });
  write('game/maps/arena.json', {
    name: 'arena',
    brushes: [floor(30), { type: 'box', min: [4, 0, -3], max: [5, 3, 3] }],
    instance: extra.arenaInstance || { policy: 'shared', cap: 50 },
    entities: [
      { classname: 'info_player_start', origin: [-10, 0, 0], angles: [0, 0, 0] },
      { classname: 'info_landmark', name: 'from_room', origin: [10, 0, 10], angles: [0, 180, 0] },
      { classname: 'actor_npc', name: 'imp', title: 'Imp', sprite: 'dummy', origin: [0, 0, 12], health: 60, speed: 3, aggroRadius: 9, senses: 'radius', attackRange: 1.2,
        attack: { interval: 1, windup: 0.2, damage: { type: 'physical', amount: 7 } } },
      { classname: 'func_hazard', name: 'lava', min: [20, -0.2, -3], max: [24, 0.2, 3], damage: { amount: 5 }, interval: 0.5 },
      { classname: 'trigger_changelevel', name: 'door', min: [12, 0, 8], max: [15, 2, 12], map: 'game/maps/room.json', landmark: 'from_arena' },
      ...(extra.arenaEntities || []),
    ],
  });
  write('game/maps/room.json', {
    name: 'room',
    brushes: [floor(12)],
    instance: extra.roomInstance || { policy: 'party', cap: 5 },
    entities: [
      { classname: 'info_player_start', origin: [0, 0, 0] },
      { classname: 'info_landmark', name: 'from_arena', origin: [-6, 0, 6], angles: [0, 0, 0] },
      { classname: 'trigger_changelevel', name: 'back', min: [-10, 0, 8], max: [-8, 2, 10], map: 'game/maps/arena.json', landmark: 'from_room' },
    ],
  });
  return root;
}

export function cleanup(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** A headless player. Sends commands at 30 Hz like the browser, predicts like the browser, and records what it hears. */
export class Bot {
  constructor(port, root, hello = {}, options = {}) {
    this.root = root;
    this.url = `ws://127.0.0.1:${port}`;
    this.intent = { mv: [0, 0], f: null };
    this.events = [];
    this.denied = [];
    this.travels = [];
    this.welcomes = [];
    this.timer = null;
    this.session = new NetSession({ url: this.url, hello: { game: 'testgame', ...hello }, relations: new Relations(), interpDelayMs: 100, ...options });
    this.session.on('net-event', (e) => this.events.push(e));
    this.session.on('denied', (m) => this.denied.push(m));
    this.session.on('travel', (m) => this.travels.push(m));
    this.session.on('welcome', (w) => { this.welcomes.push(w); this.attach(w); });
    this.entityStates = new Map();
    this.entitySpawns = [];
    this.entityRemoves = [];
    this.session.on('entity-state', (id, state, extra) => this.entityStates.set(id, { state, ...extra }));
    this.session.on('entity-spawn', (e) => this.entitySpawns.push(e));
    this.session.on('entity-remove', (id) => this.entityRemoves.push(id));
  }

  /** Load the welcome's map so movement can be predicted against its collision. */
  attach(w) {
    const doc = JSON.parse(fs.readFileSync(path.join(this.root, w.map), 'utf8'));
    this.collision = buildMap(doc).collision;
    this.session.attachWorld(this.collision);
  }

  async join() {
    const w = await this.session.connect();
    this.start();
    return w;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (let i = 0; i < STEPS_PER_COMMAND; i++) this.session.step(SIM_DT, this.intent);
      this.session.updateRender(1 / COMMAND_HZ);
    }, 1000 / COMMAND_HZ);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  leave() { this.stop(); this.session.close(); }
  /** Drop the connection without saying goodbye. */
  drop() { this.stop(); try { this.session.socket.close(); } catch { /* ok */ } }

  walk(x, z) { this.intent = { mv: [x, z], f: null }; }
  stand() { this.intent = { mv: [0, 0], f: null }; }

  get self() { return this.session.self; }
  get feet() { return this.session.self ? this.session.self.pos : null; }
  actorNamed(name) { return [...this.session.actors.values()].find((a) => a.name === name) || null; }
  eventsOf(type) { return this.events.filter((e) => e.ty === type); }
}
