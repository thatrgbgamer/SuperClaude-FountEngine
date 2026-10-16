// Client-side networking for an online game: the connection, prediction of the
// local player, interpolation of everyone else, and clock sync. Pure and
// DOM-free, so the same NetSession drives the browser game and a headless bot
// (the load test, and the two-client tests).
//
// The model, in one paragraph. The server owns the world. Every 1/30 s the
// client sends one movement COMMAND, an intended direction that applies to the
// next four 1/120 s physics steps. It also runs those same four steps itself,
// straight away, with the same movement function the server uses, so the local
// player responds instantly (prediction). The server's snapshots carry the
// number of the last command it has applied and the player's state after it;
// the client resets to that state and replays the commands the server has not
// seen yet (reconciliation). With no lag, nothing moves. With lag, the replay
// lands where the server will, and any difference is eased out, never snapped.
// Everyone else is drawn 100 ms in the past, between the two snapshots either
// side of that moment, so their motion is smooth rather than 30 Hz steps.

import { Emitter } from './events.js';
import { CharacterController } from './physics.js';
import { stepMovement } from './actor.js';
import {
  PROTOCOL_VERSION, STEPS_PER_COMMAND, SIM_DT, makeHello, degreesToFacing, round2,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Works out the server's clock from snapshot timestamps. The fastest recent
 * packet is the one closest to "no queueing delay", so the offset is the
 * minimum of (local arrival - server stamp) over a sliding window.
 */
export class ClockSync {
  constructor(window = 90) { this.window = window; this.samples = []; this.offset = null; }

  observe(serverMs, localMs) {
    this.samples.push(localMs - serverMs);
    if (this.samples.length > this.window) this.samples.shift();
    this.offset = Math.min(...this.samples);
  }

  serverNow(localMs) { return this.offset === null ? localMs : localMs - this.offset; }
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

function lerpAngle(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

/** A short history of one actor's position, sampled at a moment in the past. */
export class Track {
  constructor() { this.buffer = []; }

  push(t, x, y, z, fa) {
    const last = this.buffer[this.buffer.length - 1];
    // A teleport (respawn, portal) must not be drawn as a sprint across the map.
    if (last && Math.hypot(x - last.x, z - last.z) > 8) this.buffer.length = 0;
    if (last && t <= last.t) return;
    this.buffer.push({ t, x, y, z, fa });
    if (this.buffer.length > 40) this.buffer.shift();
  }

  /** Position at server time `t`: interpolated between samples, and extrapolated briefly if we have run past the newest. */
  sample(t, maxExtrapolateMs = 150) {
    const b = this.buffer;
    if (!b.length) return null;
    if (t <= b[0].t) return { ...b[0] };
    const last = b[b.length - 1];
    if (t >= last.t) {
      const prev = b.length > 1 ? b[b.length - 2] : null;
      if (!prev || t - last.t > maxExtrapolateMs) return { ...last };
      const k = (t - last.t) / Math.max(1, last.t - prev.t);
      return { t, x: last.x + (last.x - prev.x) * k, y: last.y + (last.y - prev.y) * k, z: last.z + (last.z - prev.z) * k, fa: last.fa };
    }
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1], c = b[i];
      if (a.t <= t && t <= c.t) {
        const k = (t - a.t) / Math.max(1, c.t - a.t);
        return { t, x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k, fa: lerpAngle(a.fa, c.fa, k) };
      }
    }
    return { ...last };
  }
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/**
 * Runs the local player's own movement ahead of the server and reconciles with
 * it. `body` describes the player's controller (it comes from the server in the
 * welcome, so the two cannot disagree).
 */
export class Predictor {
  constructor(collision, body, feet) {
    this.collision = collision;
    this.controller = new CharacterController({
      position: [feet[0], feet[1] + body.hy, feet[2]],
      halfExtents: [body.hx, body.hy, body.hz],
      acceleration: body.acc,
      friction: body.fr,
      gravity: body.g,
      stepHeight: body.step,
    });
    this.speed = body.speed;
    this.canMove = true;
    this.pending = [];       // finished commands the server has not acknowledged
    this.current = null;     // the command being played out right now: { q, mv, f, done }
    this.nextSeq = 0;
    this.lockedUntil = 0;    // local clock (ms): optimistic root while a cast the server will root us for begins
    this.now = 0;
  }

  /** Start a command. Values are rounded now, so what is predicted is exactly what is sent. */
  begin(mv, f) {
    let x = Math.round(mv[0] * 100) / 100, z = Math.round(mv[1] * 100) / 100;
    const m = Math.hypot(x, z);
    if (m > 1) { x /= m; z /= m; }
    this.current = { q: this.nextSeq++, mv: [x, z], f: f ? [Math.round(f[0] * 100) / 100, Math.round(f[1] * 100) / 100] : null, done: 0 };
    return this.current;
  }

  moveFor(cmd) {
    return this.canMove && this.now >= this.lockedUntil ? cmd.mv : [0, 0];
  }

  /** One physics step of the current command. Returns the command when its last step has run. */
  step(dt = SIM_DT) {
    const c = this.current;
    if (!c) return null;
    stepMovement(this.controller, this.collision, this.moveFor(c), this.speed, dt);
    c.done++;
    if (c.done >= STEPS_PER_COMMAND) {
      this.pending.push(c);
      this.current = null;
      return c;
    }
    return null;
  }

  /**
   * The server says: having applied your command `ack`, you are here. Rewind to
   * that, replay everything newer, and report how far the result is from where
   * we thought we were.
   */
  reconcile(ack, own) {
    const c = this.controller;
    const before = [c.position[0], c.position[1], c.position[2]];
    c.position = [own.p[0], own.p[1], own.p[2]];
    c.velocity = [own.v[0], own.v[1], own.v[2]];
    c.onGround = !!own.og;
    this.speed = own.sp;
    this.canMove = !!own.cm;

    while (this.pending.length && this.pending[0].q <= ack) this.pending.shift();
    const replay = (cmd, steps) => {
      for (let i = 0; i < steps; i++) stepMovement(c, this.collision, this.canMove ? cmd.mv : [0, 0], this.speed, SIM_DT);
    };
    for (const cmd of this.pending) replay(cmd, STEPS_PER_COMMAND);
    if (this.current) replay(this.current, this.current.done);

    return [c.position[0] - before[0], c.position[1] - before[1], c.position[2] - before[2]];
  }

  get feet() { const p = this.controller.position; return [p[0], p[1] - this.controller.halfExtents[1], p[2]]; }
}

// ---------------------------------------------------------------------------
// Remote actors
// ---------------------------------------------------------------------------

/**
 * What the client knows about an actor it does not simulate. It offers the same
 * read-only surface as a real Actor (feet, chest, health, faction...), so
 * hover picking, damage numbers and nameplates need not care which they have.
 */
export class RemoteActor {
  constructor(id, session) {
    this.id = id;
    this.session = session;
    this.track = new Track();
    this.kind = 'npc';
    this.name = '';
    this.faction = 'neutral';
    this.spriteName = null;
    this.spriteScale = 1;
    this.radius = 0.35;
    this.height = 1.7;
    this.health = 1;
    this.maxHealth = 1;
    this.dead = false;
    this.statuses = [];
    this.actionName = null;
    this.actionSeq = 0;
    this.playerId = null;
    this.publicData = {};
    this.pos = [0, 0, 0];
    this.facing = [0, 1];
    this.velocity = [0, 0];
    this.facingDeg = 0;
    this.isSelf = false;
    this.sprite = null;        // attached by the game layer, which owns sprite libraries
    this.data = {};
    this.resist = {};
    this.stats = {};
    this.corpseTime = 0;
    this.deadFor = 0;
    this.resources = {};
    this.cooldowns = {};
    this.casting = null;
    this.intent = { move: [0, 0], face: null };   // the local player's input, written by the controller each step
    this.localAction = null;                       // an animation the client started before the server confirmed it
  }

  /** Where to draw, already interpolated or predicted for this frame. */
  drawPosition() { return this.pos; }

  canAfford(cost) {
    for (const [name, amount] of Object.entries(cost || {})) {
      const r = this.resources[name];
      if (!r || r.value < amount) return false;
    }
    return true;
  }

  canCast() { return !this.dead && !this.casting; }
  canAct() { return !this.dead; }

  /** Apply the changed fields of a snapshot entry. */
  apply(d, serverMs) {
    if (d.k !== undefined) this.kind = d.k === 'p' ? 'player' : 'npc';
    if (d.nm !== undefined) this.name = d.nm;
    if (d.fc !== undefined) this.faction = d.fc;
    if (d.sp !== undefined) this.spriteName = d.sp;
    if (d.sc !== undefined) this.spriteScale = d.sc;
    if (d.r !== undefined) this.radius = d.r;
    if (d.h !== undefined) this.height = d.h;
    if (d.hp !== undefined) this.health = d.hp;
    if (d.mh !== undefined) this.maxHealth = d.mh;
    if (d.d !== undefined) this.dead = !!d.d;
    if (d.ac !== undefined) this.actionName = d.ac;
    if (d.as !== undefined) this.actionSeq = d.as;
    if (d.st !== undefined) this.statuses = d.st.map((id) => ({ def: { id }, id }));
    if (d.pid !== undefined) this.playerId = d.pid;
    if (d.pd !== undefined) this.publicData = d.pd;
    if (d.ct !== undefined) this.corpseTime = d.ct;
    if (d.vx !== undefined || d.vz !== undefined) this.velocity = [d.vx ?? this.velocity[0], d.vz ?? this.velocity[1]];
    if (d.fa !== undefined) { this.facingDeg = d.fa; }
    if (d.x !== undefined || d.z !== undefined || d.y !== undefined || d.fa !== undefined) {
      const last = this.track.buffer[this.track.buffer.length - 1];
      this.track.push(serverMs, d.x ?? (last ? last.x : 0), d.y ?? (last ? last.y : 0), d.z ?? (last ? last.z : 0), d.fa ?? this.facingDeg);
    }
  }

  get feet() { return this.pos; }
  get position() { return [this.pos[0], this.pos[1] + this.height / 2, this.pos[2]]; }
  get halfHeight() { return this.height / 2; }
  get chest() { return [this.pos[0], this.pos[1] + this.height * 0.62, this.pos[2]]; }
  get moving() { return this.velocity[0] * this.velocity[0] + this.velocity[1] * this.velocity[1] > 0.12; }

  isHostile(other) {
    return !!this.session && other !== this && this.session.relations.hostile(this.faction, other.faction);
  }

  hasStatus(id) { return this.statuses.some((s) => s.id === id); }
  cooldownRemaining(id) { return this.isSelf ? Math.max(0, (this.session.own && this.session.own.cd && this.session.own.cd[id]) || 0) : 0; }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

const alwaysHostileExceptSame = {
  hostile: (a, b) => a !== b && a !== 'neutral' && b !== 'neutral',
};

/**
 * One online connection. Events (all emitted on the session):
 *   welcome(msg)  reject(reason)  close(info)  snapshot(s)  travel(msg)
 *   net-event(ev)           a gameplay event, in order: damage, heal, death, fx, sound, notify...
 *   actor-added(ra)  actor-removed(ra)
 *   entity-state(id, state, extras)  entity-spawn(spawn)  entity-remove(id)
 *   denied({id, reason})    an ability intent the server refused
 */
export class NetSession extends Emitter {
  constructor(options) {
    super();
    this.url = options.url;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.now = options.now || (() => (globalThis.performance ? performance.now() : Date.now()));
    this.hello = options.hello || {};
    this.relations = options.relations || alwaysHostileExceptSame;
    this.interpDelayMs = options.interpDelayMs ?? 100;

    this.socket = null;
    this.connected = false;
    this.clock = new ClockSync();
    this.actors = new Map();
    this.projectiles = [];
    this.selfActorId = null;
    this.playerId = null;
    this.self = null;
    this.own = null;
    this.ack = -1;
    this.predictor = null;
    this.errorOffset = [0, 0, 0];
    this.worldTime = 0;
    this.tickHz = 30;
    this.rttMs = null;
    this.abilityLookup = options.abilityLookup || null;   // (id) -> ability definition, so a cast bar can show a name
    this.lastSnapshotAt = 0;
    this.stats = { snapshots: 0, bytesIn: 0, bytesOut: 0, corrections: 0, maxError: 0 };
    this.welcome = null;
    this._pingTimer = null;
  }

  // ---- connection ---------------------------------------------------------------

  /** Open the socket and perform the handshake. Resolves with the welcome, rejects with a readable reason. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason) => { if (!settled) { settled = true; reject(new Error(reason)); } };
      let socket;
      try { socket = new this.WebSocketImpl(this.url); } catch (err) { fail(`Could not connect: ${err.message}`); return; }
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.connected = true;
        this.send(makeHello(this.hello));
      });
      socket.addEventListener('message', (e) => {
        const text = typeof e.data === 'string' ? e.data : String(e.data);
        this.stats.bytesIn += text.length;
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.t === 'welcome' && !settled) { settled = true; resolve(msg); }
        if (msg.t === 'reject') fail(msg.reason || 'The server refused the connection.');
        this.handle(msg);
      });
      socket.addEventListener('close', (e) => {
        this.connected = false;
        clearInterval(this._pingTimer);
        fail(e.reason || 'The connection closed before the game started.');
        this.emit('close', { code: e.code, reason: e.reason });
      });
      socket.addEventListener('error', () => fail('Connection error.'));
    });
  }

  close(reason = 'left') {
    clearInterval(this._pingTimer);
    if (this.socket) try { this.socket.close(1000, reason); } catch { /* already closed */ }
    this.connected = false;
  }

  send(msg) {
    if (!this.socket || this.socket.readyState !== 1) return;
    const text = JSON.stringify(msg);
    this.stats.bytesOut += text.length;
    this.socket.send(text);
  }

  // ---- incoming -------------------------------------------------------------------

  handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.welcome = msg;
        this.playerId = msg.id;
        this.selfActorId = msg.actor;
        this.tickHz = msg.tickHz || 30;
        this.worldTime = msg.worldTime || 0;
        this.clearWorld();
        // The local actor exists from the welcome, before its first snapshot, so the
        // game has something to put the camera on while the map loads.
        this.self = new RemoteActor(msg.actor, this);
        this.self.isSelf = true;
        this.self.name = msg.name;
        this.self.kind = 'player';
        this.self.faction = 'player';
        this.self.pos = [...msg.spawn];
        this.actors.set(msg.actor, this.self);
        this.emit('welcome', msg);
        clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => this.send({ t: 'ping', c: this.now() }), 2000);
        if (this._pingTimer.unref) this._pingTimer.unref();
        break;
      case 's': this.applySnapshot(msg); break;
      case 'pong': this.rttMs = this.now() - msg.c; break;
      case 'denied': this.emit('denied', msg); break;
      case 'travel': this.emit('travel', msg); break;
      case 'reject': this.emit('reject', msg.reason); break;
      default: this.emit('message', msg);
    }
  }

  clearWorld() {
    this.actors.clear();
    this.projectiles = [];
    this.self = null;
    this.own = null;
    this.predictor = null;
    this.ack = -1;
    this.errorOffset = [0, 0, 0];
  }

  /**
   * Called by the game once it has loaded the welcome's map: it supplies the
   * collision world the local player's movement is predicted against.
   */
  attachWorld(collision) {
    const w = this.welcome;
    this.predictor = new Predictor(collision, w.body, w.spawn);
    if (this.own) this.predictor.reconcile(this.ack, this.own);
  }

  applySnapshot(s) {
    const local = this.now();
    this.stats.snapshots++;
    this.clock.observe(s.ts, local);
    this.lastSnapshotAt = local;
    if (s.wt !== undefined) this.worldTime = s.wt;

    for (const id of s.x || []) {
      const ra = this.actors.get(id);
      if (ra) { this.actors.delete(id); this.emit('actor-removed', ra); }
    }
    for (const d of s.a || []) {
      let ra = this.actors.get(d.i);
      let created = false;
      if (!ra) {
        ra = new RemoteActor(d.i, this);
        ra.isSelf = d.i === this.selfActorId;
        this.actors.set(d.i, ra);
        if (ra.isSelf) this.self = ra;
        created = true;
      }
      ra.apply(d, s.ts);
      if (created) this.emit('actor-added', ra);
    }

    // Entries about the local actor must update the object created at the welcome.
    if (s.own) {
      this.own = { ...this.own, ...s.own };
      this.ack = s.ack;
      if (this.self) {
        this.self.resources = Object.fromEntries(Object.entries(this.own.res || {}).map(([k, v]) => [k, { value: v[0], max: v[1] }]));
        this.self.cooldowns = this.own.cd || {};
        const cast = this.own.cast;
        this.self.casting = cast ? { def: (this.abilityLookup && this.abilityLookup(cast.id)) || { id: cast.id, name: cast.id }, t: cast.t, total: cast.total } : null;
        this.self.respawnTimer = this.own.rt || 0;
        if (this.own.hb !== undefined) this.hotbar = this.own.hb;
        if (this.own.dd !== undefined) this.self.data = this.own.dd;
        if (this.own.st) this.self.statuses = this.own.st.map((x) => ({ def: { id: x.id }, id: x.id, remaining: x.r, duration: x.d, stacks: x.k }));
      }
      if (this.predictor) {
        const err = this.predictor.reconcile(s.ack, this.own);
        const mag = Math.hypot(err[0], err[1], err[2]);
        if (mag > 1e-4) {
          this.stats.corrections++;
          this.stats.maxError = Math.max(this.stats.maxError, mag);
          // Small errors ease out over a few frames; a big one (teleport, respawn) is accepted at once.
          if (mag > 2.5) this.errorOffset = [0, 0, 0];
          else this.errorOffset = [this.errorOffset[0] - err[0], this.errorOffset[1] - err[1], this.errorOffset[2] - err[2]];
        }
      }
    }

    this.projectiles = (s.p || []).map((p) => ({ id: p[0], pos: [p[1], p[2], p[3]], vel: [p[4], p[5]], sprite: p[6], scale: p[7], tint: p[8] }));
    for (const e of s.es || []) this.emit('entity-spawn', e);
    for (const e of s.e || []) this.emit('entity-state', e.i, e.s, e);
    for (const id of s.er || []) this.emit('entity-remove', id);
    for (const ev of s.ev || []) this.emit('net-event', ev);
    this.emit('snapshot', s);
  }

  // ---- outgoing: called by the game --------------------------------------------------

  /**
   * One physics step (1/120 s) of the local player. `intent` is { mv: [x, z], f: [x, z] | null }:
   * what the player is asking for right now. Every fourth step finishes a command, which is sent.
   */
  step(dt, intent) {
    const p = this.predictor;
    if (!p) return;
    p.now = this.now();
    if (!p.current) p.begin(intent.mv, intent.f);
    const done = p.step(dt);
    if (done) {
      const msg = { t: 'i', q: done.q, mv: done.mv };
      if (done.f) msg.f = done.f;
      this.send(msg);
    }
  }

  /** Ask to use an ability. The server decides; a refusal arrives as 'denied'. */
  useAbility(id, aim = {}, castTime = 0, rooting = false) {
    const m = { t: 'ab', id };
    const a = {};
    if (aim.dir) a.d = [round2(aim.dir[0]), round2(aim.dir[1])];
    if (aim.point) a.p = aim.point.map(round2);
    if (aim.target) a.tg = typeof aim.target === 'object' ? aim.target.id : aim.target;
    if (Object.keys(a).length) m.aim = a;
    this.send(m);
    // The server will root us for the cast; start standing still now rather than
    // run ahead and be pulled back.
    if (rooting && castTime > 0 && this.predictor) this.predictor.lockedUntil = this.now() + castTime * 1000;
  }

  interact(entityId) { this.send({ t: 'ia', e: entityId }); }

  chat(text, channel = 'say', to = '') { this.send({ t: 'chat', text, ch: channel, to }); }

  // ---- per frame: where to draw everything --------------------------------------------

  /** The server's time as the client estimates it right now. */
  serverTime() { return this.clock.serverNow(this.now()); }

  /**
   * Place every actor for drawing. Others are interpolated at (server now -
   * interpolation delay); the local player is the predicted position plus a
   * decaying correction. Call once per rendered frame with the frame's dt.
   */
  updateRender(dtSeconds) {
    const rt = this.serverTime() - this.interpDelayMs;
    for (const ra of this.actors.values()) {
      if (ra.isSelf && this.predictor) {
        const f = this.predictor.feet;
        ra.pos = [f[0] + this.errorOffset[0], f[1] + this.errorOffset[1], f[2] + this.errorOffset[2]];
        const face = this.predictor.current && this.predictor.current.f;
        if (face) ra.facing = face;
        else if (ra.velocity && ra.moving) ra.facing = degreesToFacing(ra.facingDeg);
        else ra.facing = degreesToFacing(ra.facingDeg);
        continue;
      }
      const s = ra.track.sample(rt);
      if (s) { ra.pos = [s.x, s.y, s.z]; ra.facing = degreesToFacing(s.fa); }
    }
    const k = Math.exp(-12 * dtSeconds);
    this.errorOffset = [this.errorOffset[0] * k, this.errorOffset[1] * k, this.errorOffset[2] * k];
  }
}

export { PROTOCOL_VERSION };
