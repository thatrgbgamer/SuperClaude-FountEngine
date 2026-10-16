// The wire protocol between an online client and a Fount server. Shared by
// both ends, so each message has exactly one definition and one validator.
//
// Messages are compact JSON objects: a short type in `t`, short field names, and
// numbers rounded to the precision that matters. WebSocket is ordered and
// reliable, so there is no separate unreliable channel: a stale position
// snapshot is simply superseded by the next one, and events ride the same
// stream and arrive in order.
//
// Never trust a number from the other end. Every incoming message goes through
// a parse function here that returns a clean copy or null; the server acts only
// on what those return.

/** Bump when the shape of any message changes incompatibly. A mismatch is refused at the handshake. */
export const PROTOCOL_VERSION = 1;

export const SIM_HZ = 120;                 // physics steps per second, same as the offline game
export const STEPS_PER_COMMAND = 4;        // one movement command covers this many steps
export const COMMAND_HZ = SIM_HZ / STEPS_PER_COMMAND; // 30 commands (and server ticks) per second
export const SIM_DT = 1 / SIM_HZ;

export const LIMITS = {
  maxMessageBytes: 16 * 1024,
  maxIntentsPerSecond: 90,    // commands are 30/s; the headroom is for bursts after a stall
  maxQueuedCommands: 6,       // a client further ahead than this has its oldest commands dropped
  nameLength: 20,
  chatLength: 200,
  idLength: 64,
};

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clampNum = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const round2 = (n) => Math.round(n * 100) / 100;
export const round1 = (n) => Math.round(n * 10) / 10;

/** Facing as whole degrees, in the engine's yaw convention (0 faces +X, 90 faces -Z). */
export function facingToDegrees(f) {
  return Math.round((Math.atan2(-f[1], f[0]) * 180) / Math.PI);
}

export function degreesToFacing(deg) {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r)];
}

// Components are only bounded to something sane here. Bringing a vector down to
// unit length is done by scaling, never by clamping each component, which would
// bend its direction.
function vec2(v) {
  if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) return null;
  return [clampNum(v[0], -1e6, 1e6), clampNum(v[1], -1e6, 1e6)];
}

function unit2(v) {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-6 ? [v[0] / l, v[1] / l] : null;
}

function vec3(v, limit = 100000) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return null;
  return v.map((n) => clampNum(n, -limit, limit));
}

const cleanString = (s, max) => (typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '');

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * First message on a connection. `game` and `engine` identify what the client
 * is built from; a server refuses a mismatch with a message a player can read,
 * rather than failing later in some unrelated way.
 */
export function makeHello(fields) {
  return { t: 'hello', v: PROTOCOL_VERSION, ...fields };
}

export function parseHello(msg) {
  if (!msg || msg.t !== 'hello') return { error: 'The first message must be a hello.' };
  if (msg.v !== PROTOCOL_VERSION) {
    return { error: `This client speaks protocol ${msg.v}, the server speaks ${PROTOCOL_VERSION}. Update whichever is older.` };
  }
  return {
    hello: {
      game: cleanString(msg.game, 64),
      build: cleanString(msg.build, 64),
      name: cleanString(msg.name, LIMITS.nameLength),
      token: cleanString(msg.token, 256),
      map: cleanString(msg.map, 200),
      character: cleanString(msg.character, 64),
      class: cleanString(msg.class, 32),
      resume: cleanString(msg.resume, 128),
    },
  };
}

/** A movement command: `q` is the client's sequence number, `mv` the intended direction, `f` an optional facing. */
export function parseCommand(msg) {
  if (!Number.isInteger(msg.q) || msg.q < 0) return null;
  const mv = vec2(msg.mv);
  if (!mv) return null;
  const mag = Math.hypot(mv[0], mv[1]);
  if (mag > 1) { mv[0] /= mag; mv[1] /= mag; }       // a diagonal at full tilt must not be faster
  const f = msg.f === undefined ? null : (vec2(msg.f) && unit2(vec2(msg.f)));
  return { q: msg.q, mv, f: f || null };
}

export function parseAbility(msg) {
  const id = cleanString(msg.id, LIMITS.idLength);
  if (!id) return null;
  const aim = {};
  if (msg.aim) {
    const d = vec2(msg.aim.d);
    const dir = d && unit2(d);
    if (dir) aim.dir = dir;
    const p = vec3(msg.aim.p);
    if (p) aim.point = p;
    if (Number.isInteger(msg.aim.tg)) aim.targetId = msg.aim.tg;
  }
  return { id, aim };
}

export function parseInteract(msg) {
  return Number.isInteger(msg.e) ? { entityId: msg.e } : null;
}

export function parseChat(msg) {
  const text = cleanString(msg.text, LIMITS.chatLength);
  if (!text) return null;
  return { text, channel: cleanString(msg.ch, 16) || 'say', to: cleanString(msg.to, LIMITS.nameLength) };
}

export function parsePing(msg) {
  return isNum(msg.c) ? { c: msg.c } : null;
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------
//
//   welcome  { t, v, id, serverTime, worldTime, tickHz, map, instance, spawn, name }
//   reject   { t, reason }
//   s        snapshot (see server/replication.mjs for the fields)
//   denied   { t, id, reason }          an ability intent the server refused
//   travel   { t, map, instance, landmark }   the client should load another map
//   pong     { t, c, s }
//   chat, party, notice ...             social messages (see the social module)
//   kick     { t, reason }

export function reject(reason) { return { t: 'reject', reason }; }
