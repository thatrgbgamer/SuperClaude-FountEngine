// Client networking. Connects to a Fount server, reports this player's state,
// and draws everyone else.
//
// Remote players are rendered ~100ms behind the newest snapshot and
// interpolated between the two snapshots straddling that time. Rendering the
// latest snapshot directly would mean teleporting on every packet; buffering
// one tick of slack buys smooth motion at the cost of a little latency, which
// is the standard trade and the right one for a shooter this size.

import { add, sub, mul, len, clamp } from './math.js';
import { playSoundAt } from './audio.js';

const INTERP_DELAY_MS = 100;
const SEND_RATE_MS = 50;            // 20Hz, matching the server tick
const SNAPSHOT_HISTORY = 20;
const RECONNECT_DELAY_MS = 2000;

export class NetClient {
  constructor(game, options = {}) {
    this.game = game;
    this.url = options.url || defaultServerUrl();
    this.socket = null;
    this.connected = false;
    this.selfId = null;
    this.serverName = '';
    this.players = new Map();       // id -> { name, color, snapshots: [], ... }
    this.lastSend = 0;
    this.chatLog = [];
    this.onChat = null;
    this.onStatus = null;
    this.wantReconnect = options.autoReconnect !== false;
    this.name = options.name || localStorage.getItem('fount.name') || '';
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  connect() {
    if (this.socket) return;
    this.status(`Connecting to ${this.url}...`);
    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.status(`Could not connect: ${err.message}`);
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.status('Connected.');
      if (this.name) this.send({ t: 'name', name: this.name });
    });

    socket.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.handle(msg);
    });

    socket.addEventListener('close', (e) => {
      this.connected = false;
      this.socket = null;
      this.players.clear();
      this.selfId = null;
      const why = e.reason || 'connection closed';
      this.status(`Disconnected: ${why}`);
      // A kick or ban should stay disconnected rather than fighting the server.
      if (this.wantReconnect && e.code !== 4001 && e.code !== 4003) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    socket.addEventListener('error', () => {
      this.status('Connection error.');
    });
  }

  disconnect() {
    this.wantReconnect = false;
    if (this.socket) this.socket.close(1000, 'left');
    this.socket = null;
    this.connected = false;
    this.players.clear();
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  status(text) {
    this.statusText = text;
    if (this.onStatus) this.onStatus(text);
    console.log('[net]', text);
  }

  pushChat(from, text) {
    this.chatLog.push({ from, text, at: Date.now() });
    while (this.chatLog.length > 60) this.chatLog.shift();
    if (this.onChat) this.onChat(from, text);
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  handle(msg) {
    const game = this.game;
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.id;
        this.serverName = msg.serverName;
        if (!this.name) this.name = msg.name;
        // The server decides whether its players may use cheat commands. The
        // console reads this, so an honest player is stopped from noclipping
        // into a kick rather than being punished for trying.
        this.cheatsAllowed = !!msg.cheatsAllowed;
        this.anticheat = msg.anticheat || 'unknown';
        this.status(`Joined ${msg.serverName} as ${this.name}`);
        for (const p of msg.players || []) this.upsert(p);
        // A map load builds a fresh Player, so the spawn has to be applied
        // after it lands, not before.
        if (msg.map && msg.map !== game.currentMapPath) this.loadServerMap(msg.map, msg.spawn);
        else if (msg.spawn) this.teleportSelf(msg.spawn);
        break;

      case 'join':
        this.upsert(msg.player);
        this.pushChat(null, `${msg.player.name} joined`);
        break;

      case 'leave': {
        const p = this.players.get(msg.id);
        if (p) this.pushChat(null, `${p.name} left`);
        this.players.delete(msg.id);
        break;
      }

      case 'rename': {
        const p = this.players.get(msg.id);
        if (p) p.name = msg.name;
        break;
      }

      case 'state':
        for (const snap of msg.players) {
          if (snap.id === this.selfId) {
            // The server owns scoring, so read our own back rather than
            // trusting a local counter that only knows about NPC kills.
            this.selfStats = { kills: snap.kills, deaths: snap.deaths };
            continue;
          }
          this.upsert(snap);
        }
        break;

      case 'shoot':
        playSoundAt('shoot', msg.origin, game.player.eyePosition, 50);
        break;

      case 'hit':
        if (msg.target === this.selfId) {
          // The server has already decided the damage and the resulting
          // health; take its number rather than recomputing one locally that
          // could drift (or be edited).
          game.player.takeDamage(msg.damage, null, true);
          if (typeof msg.health === 'number') game.player.health = msg.health;
        }
        break;

      // The server rejected a move as impossible and put us back. Honest
      // clients see this on a bad desync; a cheating one sees its movement
      // undone, which is what makes the cheat pointless rather than punished.
      case 'correct':
        this.teleportSelf(msg.pos);
        this.corrections = (this.corrections || 0) + 1;
        if (this.corrections === 1 || this.corrections % 25 === 0) {
          this.status(`Server corrected your position (${msg.reason || 'invalid move'})`);
        }
        break;

      case 'kill': {
        const victim = msg.victim === this.selfId ? null : this.players.get(msg.victim);
        const at = msg.point || (victim ? victim.pos : null);
        // Everyone sees a body drop, including for the local player's death.
        const feet = msg.victim === this.selfId
          ? [game.player.position[0], game.player.position[1] - 0.9, game.player.position[2]]
          : (victim ? victim.pos : at);
        if (feet) {
          const body = game.ragdolls.spawn({
            origin: feet,
            yaw: victim ? victim.angles[1] : game.player.angles[1],
            velocity: [0, 0, 0],
            tint: victim ? victim.color : [1, 1, 1],
            materials: {
              body: game.built.materialIndex.get('cloth') ?? 9,
              skin: game.built.materialIndex.get('flesh') ?? 8,
            },
          });
          if (msg.impulse && len(msg.impulse) > 0) body.applyImpulse(msg.impulse, at, 0.9);
        }
        if (victim) victim.dead = true;
        break;
      }

      case 'respawn': {
        if (msg.id === this.selfId) {
          game.player.dead = false;
          game.player.health = msg.health ?? game.player.maxHealth;
          game.player.respawnTimer = 0;
          if (msg.pos) this.teleportSelf(msg.pos);
          break;
        }
        const p = this.players.get(msg.id);
        if (p) { p.dead = false; p.snapshots.length = 0; }
        break;
      }

      case 'chat':
        this.pushChat(msg.from, msg.text);
        break;

      case 'cmdresult':
        this.pushChat(null, msg.text);
        if (game.console) game.console.print(msg.text);
        break;

      case 'kicked':
        this.wantReconnect = false;
        this.pushChat(null, `You were removed: ${msg.reason}`);
        break;

      case 'map':
        this.loadServerMap(msg.map, msg.spawn);
        break;

      default:
    }
  }

  /** Move the local player where the server says, without fighting collision. */
  teleportSelf(pos) {
    this.game.player.teleport(pos);
    this.reportSelf(true);
  }

  /** Load (or restart) the server's map, then stand where the server put us. */
  loadServerMap(mapPath, spawn = null) {
    const game = this.game;
    if (game.currentMapPath === mapPath) {
      game.restart();
      if (spawn) this.teleportSelf(spawn);
      return;
    }
    this.status(`Loading ${mapPath}...`);
    game.load(mapPath)
      .then(() => { if (spawn) this.teleportSelf(spawn); })
      .catch((err) => this.status(`Map load failed: ${err.message}`));
  }

  upsert(snap) {
    let p = this.players.get(snap.id);
    if (!p) {
      p = { id: snap.id, name: snap.name, color: snap.color || [1, 1, 1], snapshots: [], dead: false };
      this.players.set(snap.id, p);
    }
    p.name = snap.name ?? p.name;
    p.color = snap.color || p.color;
    p.health = snap.health;
    p.kills = snap.kills;
    p.deaths = snap.deaths;
    p.dead = snap.dead;
    p.pos = snap.pos;
    p.angles = snap.angles;
    p.snapshots.push({ at: Date.now(), pos: snap.pos, angles: snap.angles, moving: snap.moving });
    while (p.snapshots.length > SNAPSHOT_HISTORY) p.snapshots.shift();
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  reportSelf(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSend < SEND_RATE_MS) return;
    this.lastSend = now;
    const player = this.game.player;
    const speed = Math.hypot(player.controller.velocity[0], player.controller.velocity[2]);
    this.send({
      t: 'input',
      pos: player.controller.position.map((n) => +n.toFixed(3)),
      angles: player.angles.map((n) => +n.toFixed(1)),
      moving: speed > 0.6,
    });
  }

  reportShot(origin, dir) {
    this.send({ t: 'shoot', origin: origin.map((n) => +n.toFixed(2)), dir: dir.map((n) => +n.toFixed(3)) });
  }

  // The client reports WHO it hit, because client-side hit detection is what
  // makes shooting feel immediate. It deliberately does not report how much
  // damage: the server recomputes that from its own rewound trace.
  reportHit(targetId, point) {
    this.send({ t: 'hit', target: targetId, point });
  }

  /**
   * Damage this client simulated for itself — an NPC, an explosion, a fall.
   * NPCs run per-client, so the server cannot see these and would otherwise
   * think a player who just died locally is still at full health. Safe to
   * trust because the only outcome a liar can buy is their own death.
   */
  reportSelfDamage(amount) {
    if (!(amount > 0)) return;
    this.send({ t: 'selfdamage', amount: Math.min(1000, Math.round(amount)) });
  }

  requestRespawn() {
    if (this.lastRespawnRequest && Date.now() - this.lastRespawnRequest < 500) return;
    this.lastRespawnRequest = Date.now();
    this.send({ t: 'respawn' });
  }

  chat(text) {
    if (text.startsWith('/')) this.send({ t: 'cmd', text: text.slice(1) });
    else this.send({ t: 'chat', text });
  }

  setName(name) {
    this.name = name;
    localStorage.setItem('fount.name', name);
    this.send({ t: 'name', name });
  }

  // -------------------------------------------------------------------------
  // Rendering remote players
  // -------------------------------------------------------------------------

  /** Position/orientation at the interpolation time, or null if unknown yet. */
  sampleRemote(p, renderTime) {
    const snaps = p.snapshots;
    if (!snaps.length) return null;
    if (snaps.length === 1) return { pos: snaps[0].pos, angles: snaps[0].angles, moving: snaps[0].moving };

    for (let i = snaps.length - 1; i > 0; i--) {
      const b = snaps[i];
      const a = snaps[i - 1];
      if (a.at <= renderTime && renderTime <= b.at) {
        const span = b.at - a.at;
        const t = span > 0 ? clamp((renderTime - a.at) / span, 0, 1) : 1;
        return {
          pos: [
            a.pos[0] + (b.pos[0] - a.pos[0]) * t,
            a.pos[1] + (b.pos[1] - a.pos[1]) * t,
            a.pos[2] + (b.pos[2] - a.pos[2]) * t,
          ],
          angles: b.angles,
          moving: b.moving,
        };
      }
    }
    // Behind or ahead of the buffer: fall back to the newest known state.
    const last = snaps[snaps.length - 1];
    return { pos: last.pos, angles: last.angles, moving: last.moving };
  }

  /** Ray-vs-box against remote players, so shots can actually hit them. */
  pickPlayer(origin, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const p of this.players.values()) {
      if (p.dead || !p.pos) continue;
      const c = p.pos;
      const min = [c[0] - 0.35, c[1] - 0.9, c[2] - 0.35];
      const max = [c[0] + 0.35, c[1] + 1.25, c[2] + 0.35];
      const t = rayBox(origin, dir, min, max);
      if (t !== null && t < bestT) { bestT = t; best = { player: p, t }; }
    }
    return best;
  }

  draw(renderer, shadowPass) {
    const game = this.game;
    if (!game.built) return;
    const bodyLayer = game.built.materialIndex.get('cloth') ?? 9;
    const skinLayer = game.built.materialIndex.get('flesh') ?? 8;
    const renderTime = Date.now() - INTERP_DELAY_MS;

    for (const p of this.players.values()) {
      if (p.dead) continue;
      const sample = this.sampleRemote(p, renderTime);
      if (!sample) continue;

      const feet = [sample.pos[0], sample.pos[1] - 0.9, sample.pos[2]];
      const yawRad = (sample.angles[1] || 0) * Math.PI / 180;
      const right = [Math.sin(yawRad), 0, Math.cos(yawRad)];
      const forward = [Math.cos(yawRad), 0, -Math.sin(yawRad)];

      p.walk = (p.walk || 0) + (sample.moving ? 0.25 : -(p.walk || 0) * 0.2);
      const swing = Math.sin(p.walk) * (sample.moving ? 0.34 : 0);

      for (const side of [-1, 1]) {
        const hip = add([feet[0], feet[1] + 0.92, feet[2]], mul(right, 0.14 * side));
        const foot = add([hip[0], feet[1] + 0.06, hip[2]], mul(forward, swing * side));
        const knee = [(hip[0] + foot[0]) / 2, (hip[1] + foot[1]) / 2 + 0.04, (hip[2] + foot[2]) / 2];
        renderer.drawSegment(hip, knee, 0.07, bodyLayer, p.color, shadowPass);
        renderer.drawSegment(knee, foot, 0.055, bodyLayer, p.color, shadowPass);
      }

      renderer.drawSegment(
        [feet[0], feet[1] + 0.92, feet[2]], [feet[0], feet[1] + 1.5, feet[2]],
        0.13, bodyLayer, p.color, shadowPass,
      );

      const shoulder = [feet[0], feet[1] + 1.44, feet[2]];
      for (const side of [-1, 1]) {
        const sh = add(shoulder, mul(right, 0.2 * side));
        const hand = add([sh[0], feet[1] + 0.9, sh[2]], mul(forward, -swing * side * 0.6));
        renderer.drawSegment(sh, hand, 0.05, bodyLayer, p.color, shadowPass);
      }

      renderer.drawSphere([feet[0], feet[1] + 1.66, feet[2]], 0.13, skinLayer, p.color, shadowPass);
    }
  }

  get playerCount() { return this.players.size + (this.connected ? 1 : 0); }

  scoreboard() {
    const rows = [...this.players.values()].map((p) => ({ name: p.name, kills: p.kills || 0, deaths: p.deaths || 0 }));
    if (this.connected) {
      const self = this.selfStats || { kills: this.game.player.kills, deaths: this.game.player.deaths || 0 };
      rows.push({ name: this.name + ' (you)', kills: self.kills || 0, deaths: self.deaths || 0 });
    }
    return rows.sort((a, b) => b.kills - a.kills);
  }
}

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

function defaultServerUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

export { defaultServerUrl };
