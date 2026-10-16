// Parties, chat, emotes and speech bubbles.
//
// Players find each other by name. A party is a short list of player ids with a
// leader; its frame data (health, level, which map) is pushed to every member on
// a timer whatever the distance, because interest management would otherwise
// hide a party member who wandered off. Chat has channels with their own
// audience and rate limit; everything a client says is length-capped, rate
// limited and checked before it reaches anyone.
//
// The game keeps its own opinions through hooks (all optional):
//   chatFilter(text, player, channel)  -> false to refuse, a string to replace the text
//   guildOf(player)                    -> a guild id, to enable the guild channel
//   partyMember(player)                -> extra plain fields shown in the party frame (class, level)
//   chatReport(report)                 -> called when a player reports another

import { parseChat } from '../engine/protocol.js';

const DEFAULT_RATES = { say: [6, 6000], party: [8, 6000], guild: [8, 6000], whisper: [8, 6000], world: [3, 30000], emote: [4, 6000] };
const EMOTES = { wave: 'waves.', cheer: 'cheers!', laugh: 'laughs.', cry: 'cries.', dance: 'dances.', bow: 'bows.', point: 'points ahead.', sit: 'sits down.' };
const BUBBLE_MS = 5000, EMOTE_MS = 3000, INVITE_MS = 60000;
const IGNORE_KEY = 'socialIgnored';

export class Social {
  constructor({ manager, gameData, store = null, log = () => {} }) {
    Object.assign(this, { manager, gameData, store, log });
    const cfg = gameData.config.server || {};
    this.partySize = cfg.partySize ?? 5;
    this.sayRadius = cfg.sayRadius ?? 40;
    this.rates = { ...DEFAULT_RATES, ...(cfg.chatRates || {}) };
    this.emotes = cfg.emotes || EMOTES;
    this.parties = new Map();        // party id -> { id, leader, members: [player ids], last: string }
    this.partyOf = new Map();        // player id -> party id
    this.invites = new Map();        // target player id -> { party, from, expires }
    this.windows = new Map();        // "playerId:key" -> timestamps
    this.lastText = new Map();       // player id -> { text, at }
    this.mutes = new Map();          // player id -> until (ms)
    this.history = [];               // the last chat lines, kept for reports
    this.counter = 0;
    this.off = [];
  }

  start() {
    const ev = this.manager.events;
    this.off.push(ev.on('player-left', (p) => { if (!p.traveling) this.forget(p); }));
    this.off.push(ev.on('player-joined', (p) => this.rejoined(p)));
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); for (const o of this.off) o(); this.off = []; }

  // ---- finding people --------------------------------------------------------------

  *allPlayers() { for (const inst of this.manager.instances.values()) yield* inst.players; }
  byId(id) { for (const p of this.allPlayers()) if (p.id === id) return p; return null; }
  byName(name) {
    const want = String(name || '').toLowerCase();
    if (!want) return null;
    for (const p of this.allPlayers()) if (p.actor.name.toLowerCase() === want) return p;
    return null;
  }

  // ---- limits ------------------------------------------------------------------------

  allow(player, key) {
    const [n, ms] = this.rates[key] || [6, 6000];
    const k = `${player.id}:${key}`;
    const now = Date.now();
    const w = (this.windows.get(k) || []).filter((t) => now - t < ms);
    if (w.length >= n) { this.windows.set(k, w); return false; }
    w.push(now);
    this.windows.set(k, w);
    return true;
  }

  isMuted(player) { const u = this.mutes.get(player.id); return !!u && u > Date.now(); }
  mute(player, seconds) { this.mutes.set(player.id, Date.now() + seconds * 1000); }
  unmute(player) { this.mutes.delete(player.id); }

  ignores(player) { return (player.actor.data[IGNORE_KEY] ||= []); }
  isIgnoring(player, otherName) { return this.ignores(player).includes(String(otherName).toLowerCase()); }

  // ---- messages ----------------------------------------------------------------------

  system(player, text) { player.send({ t: 'chat', ch: 'system', text }); }
  broadcast(text) { for (const p of this.allPlayers()) this.system(p, text); }

  handle(player, msg) {
    switch (msg.t) {
      case 'chat': return this.chat(player, msg);
      case 'party': return this.partyOp(player, msg);
      case 'social': return this.socialOp(player, msg);
      case 'emote': return this.emote(player, msg);
    }
    return false;
  }

  chat(player, msg) {
    const c = parseChat(msg);
    if (!c) return;
    const A = player.actor;
    const channel = ['say', 'party', 'guild', 'whisper', 'world'].includes(c.channel) ? c.channel : 'say';
    if (this.isMuted(player)) return this.system(player, 'You are muted.');
    if (!this.allow(player, channel)) return this.system(player, 'You are talking too fast.');
    const last = this.lastText.get(player.id);
    const now = Date.now();
    if (last && last.text === c.text && now - last.at < 3000) return;          // an identical repeat is dropped quietly
    this.lastText.set(player.id, { text: c.text, at: now });

    let text = c.text;
    const verdict = this.gameData.callHook('chatFilter', text, player, channel);
    if (verdict === false) return this.system(player, 'That message was not sent.');
    if (typeof verdict === 'string') text = verdict.slice(0, 200);
    if (!text) return;

    const line = { t: 'chat', ch: channel, from: A.name, fid: A.id, text };
    let audience = [];
    if (channel === 'say') {
      const p = A.controller.position;
      audience = [...player.instance.players].filter((q) => {
        const o = q.actor.controller.position;
        return Math.hypot(o[0] - p[0], o[2] - p[2]) <= this.sayRadius;
      });
      this.bubble(A, text);
    } else if (channel === 'party') {
      const party = this.parties.get(this.partyOf.get(player.id));
      if (!party) return this.system(player, 'You are not in a party.');
      audience = party.members.map((id) => this.byId(id)).filter(Boolean);
    } else if (channel === 'guild') {
      const g = this.gameData.callHook('guildOf', player);
      if (g === undefined || g === null) return this.system(player, 'You are not in a guild.');
      audience = [...this.allPlayers()].filter((q) => this.gameData.callHook('guildOf', q) === g);
    } else if (channel === 'world') {
      audience = [...this.allPlayers()];
    } else {
      const to = this.byName(c.to);
      if (!to || to === player) return this.system(player, to ? 'You cannot whisper yourself.' : `${c.to || 'Nobody'} is not online.`);
      line.to = to.actor.name;
      if (!this.isIgnoring(to, A.name)) to.send(line);
      player.send({ ...line, echo: 1 });
      this.record(player, channel, text, to.actor.name);
      return;
    }
    for (const q of audience) {
      if (q !== player && this.isIgnoring(q, A.name)) continue;
      q.send(line);
    }
    this.record(player, channel, text);
  }

  record(player, channel, text, to = null) {
    this.history.push({ ts: Date.now(), ch: channel, from: player.actor.name, to, text, instance: player.instance.id });
    if (this.history.length > 500) this.history.splice(0, 100);
  }

  /** A speech bubble over an actor's head: replicated through its public data, cleared by tick(). */
  bubble(actor, text) {
    actor.publicData.bubble = { t: text, n: (actor.publicData.bubble ? actor.publicData.bubble.n : 0) + 1 };
    actor._bubbleUntil = Date.now() + BUBBLE_MS;
  }

  emote(player, msg) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const def = Object.prototype.hasOwnProperty.call(this.emotes, id) ? this.emotes[id] : null;
    if (!def) return;
    if (this.isMuted(player)) return;
    if (!this.allow(player, 'emote')) return;
    const A = player.actor;
    if (A.dead) return;
    A.publicData.emote = { id, n: (A.publicData.emote ? A.publicData.emote.n : 0) + 1 };
    A._emoteUntil = Date.now() + EMOTE_MS;
    const p = A.controller.position;
    const line = { t: 'chat', ch: 'emote', from: A.name, fid: A.id, text: `${A.name} ${def}` };
    for (const q of player.instance.players) {
      const o = q.actor.controller.position;
      if (Math.hypot(o[0] - p[0], o[2] - p[2]) <= this.sayRadius && (q === player || !this.isIgnoring(q, A.name))) q.send(line);
    }
  }

  socialOp(player, msg) {
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 24).toLowerCase() : '';
    const list = this.ignores(player);
    if (msg.op === 'ignore' && name) {
      if (name === player.actor.name.toLowerCase()) return this.system(player, 'You cannot ignore yourself.');
      if (!list.includes(name) && list.length < 100) list.push(name);
      this.system(player, `Ignoring ${name}.`);
    } else if (msg.op === 'unignore' && name) {
      const i = list.indexOf(name);
      if (i >= 0) list.splice(i, 1);
      this.system(player, `No longer ignoring ${name}.`);
    } else if (msg.op === 'report' && name) {
      if (!this.allow(player, 'report')) return this.system(player, 'You have reported too much; wait a moment.');
      const lines = this.history.filter((h) => h.from.toLowerCase() === name).slice(-10);
      const report = { by: player.actor.name, against: name, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : '', lines, at: Date.now() };
      if (this.store) this.store.addAudit({ actor: `player:${player.actor.name}`, action: 'chat-report', detail: report }).catch(() => {});
      this.gameData.callHook('chatReport', report);
      this.system(player, 'Thank you. Your report was sent to the moderators.');
    }
  }

  // ---- parties -----------------------------------------------------------------------

  partyFor(player) { return this.parties.get(this.partyOf.get(player.id)) || null; }

  partyOp(player, msg) {
    const op = msg.op;
    const party = this.partyFor(player);
    const A = player.actor;
    const target = typeof msg.name === 'string' ? this.byName(msg.name) : null;
    if (op === 'invite') {
      if (!target || target === player) return this.system(player, target ? 'You cannot invite yourself.' : `${msg.name || 'Nobody'} is not online.`);
      if (party && party.leader !== player.id) return this.system(player, 'Only the party leader can invite.');
      if (this.partyOf.has(target.id)) return this.system(player, `${target.actor.name} is already in a party.`);
      if (party && party.members.length >= this.partySize) return this.system(player, 'Your party is full.');
      if (this.isIgnoring(target, A.name)) return this.system(player, `${target.actor.name} is not accepting invitations.`);
      if (!this.allow(player, 'invite')) return this.system(player, 'You are inviting too fast.');
      this.invites.set(target.id, { party: party ? party.id : null, from: player.id, expires: Date.now() + INVITE_MS });
      target.send({ t: 'party', ev: 'invite', from: A.name, ttl: INVITE_MS / 1000 });
      this.system(player, `Invited ${target.actor.name}.`);
    } else if (op === 'accept') {
      const inv = this.invites.get(player.id);
      this.invites.delete(player.id);
      if (!inv || inv.expires < Date.now()) return this.system(player, 'You have no invitation.');
      if (this.partyOf.has(player.id)) return this.system(player, 'Leave your party first.');
      const from = this.byId(inv.from);
      if (!from) return this.system(player, 'The inviter is gone.');
      let dest = inv.party ? this.parties.get(inv.party) : this.partyFor(from);
      if (!dest) dest = this.create(from);
      if (dest.members.length >= this.partySize) return this.system(player, 'That party is full.');
      this.add(dest, player);
      this.notifyParty(dest, `${A.name} joined the party.`);
    } else if (op === 'decline') {
      const inv = this.invites.get(player.id);
      this.invites.delete(player.id);
      const from = inv && this.byId(inv.from);
      if (from) this.system(from, `${A.name} declined your invitation.`);
    } else if (op === 'leave') {
      if (!party) return;
      this.notifyParty(party, `${A.name} left the party.`);
      this.remove(party, player.id);
    } else if (op === 'kick' || op === 'promote') {
      if (!party || party.leader !== player.id) return this.system(player, 'Only the party leader can do that.');
      const id = target ? target.id : null;
      if (!id || id === player.id || !party.members.includes(id)) return this.system(player, 'That player is not in your party.');
      if (op === 'kick') {
        this.system(target, 'You were removed from the party.');
        this.notifyParty(party, `${target.actor.name} was removed from the party.`);
        this.remove(party, id);
      } else {
        party.leader = id;
        this.notifyParty(party, `${target.actor.name} is now the party leader.`);
        this.push(party, true);
      }
    } else if (op === 'disband') {
      if (!party || party.leader !== player.id) return this.system(player, 'Only the party leader can do that.');
      this.notifyParty(party, 'The party was disbanded.');
      this.disband(party);
    }
  }

  create(leader) {
    const party = { id: `pt${++this.counter}`, leader: leader.id, members: [], last: '' };
    this.parties.set(party.id, party);
    this.add(party, leader);
    return party;
  }

  add(party, player) {
    party.members.push(player.id);
    this.partyOf.set(player.id, party.id);
    this.setPartyId(player.id, party.id);
    this.push(party, true);
  }

  remove(party, id) {
    party.members = party.members.filter((m) => m !== id);
    this.partyOf.delete(id);
    this.setPartyId(id, null);
    const gone = this.byId(id);
    if (gone) gone.send({ t: 'party', ev: 'state', party: null });
    if (party.members.length <= 1) return this.disband(party);
    if (party.leader === id) {
      party.leader = party.members[0];
      this.notifyParty(party, `${this.nameOf(party.leader)} is now the party leader.`);
    }
    this.push(party, true);
  }

  disband(party) {
    for (const id of party.members) {
      this.partyOf.delete(id);
      this.setPartyId(id, null);
      const p = this.byId(id);
      if (p) p.send({ t: 'party', ev: 'state', party: null });
    }
    this.parties.delete(party.id);
  }

  setPartyId(id, partyId) { const p = this.byId(id); if (p) p.partyId = partyId; }
  nameOf(id) { const p = this.byId(id); return p ? p.actor.name : '?'; }
  notifyParty(party, text) { for (const id of party.members) { const p = this.byId(id); if (p) this.system(p, text); } }

  /** The frame every member sees. Sent regardless of distance, and only when something changed. */
  frame(party) {
    return {
      id: party.id,
      leader: party.leader,
      members: party.members.map((id) => {
        const p = this.byId(id);
        if (!p) return { id, name: '?', online: 0 };
        const A = p.actor;
        const res = {};
        for (const [k, r] of Object.entries(A.resources)) res[k] = [Math.round(r.value), r.max];
        return {
          id, name: A.name, hp: Math.max(0, Math.ceil(A.health)), mh: Math.ceil(A.maxHealth), dead: A.dead ? 1 : 0, res,
          map: p.instance ? p.instance.mapPath : null, online: p.disconnectedAt === null ? 1 : 0,
          ...(this.gameData.callHook('partyMember', p) || {}),
        };
      }),
    };
  }

  push(party, force = false) {
    const frame = this.frame(party);
    const str = JSON.stringify(frame);
    if (!force && str === party.last) return;
    party.last = str;
    const msg = { t: 'party', ev: 'state', party: frame };
    for (const id of party.members) { const p = this.byId(id); if (p) p.send(msg); }
  }

  rejoined(player) {
    const party = this.partyFor(player);
    if (party) { player.partyId = party.id; this.push(party, true); }
  }

  forget(player) {
    const party = this.partyFor(player);
    if (party) { this.notifyParty(party, `${player.actor.name} left the game.`); this.remove(party, player.id); }
    this.invites.delete(player.id);
    for (const [k, v] of this.invites) if (v.from === player.id) this.invites.delete(k);
    this.lastText.delete(player.id);
    this.mutes.delete(player.id);
    for (const k of [...this.windows.keys()]) if (k.startsWith(`${player.id}:`)) this.windows.delete(k);
  }

  tick() {
    const now = Date.now();
    for (const party of this.parties.values()) this.push(party);
    for (const [k, v] of this.invites) if (v.expires < now) this.invites.delete(k);
    for (const p of this.allPlayers()) {
      const A = p.actor;
      if (A._bubbleUntil && A._bubbleUntil < now) { delete A.publicData.bubble; A._bubbleUntil = 0; }
      if (A._emoteUntil && A._emoteUntil < now) { delete A.publicData.emote; A._emoteUntil = 0; }
    }
  }

  // ---- what a game script calls --------------------------------------------------------

  /** The player and any party members in the same instance within `radius` metres. */
  membersNear(player, radius = 40) {
    const party = this.partyFor(player);
    if (!party) return [player];
    const p = player.actor.controller.position;
    const out = [player];
    for (const id of party.members) {
      const q = this.byId(id);
      if (!q || q === player || q.instance !== player.instance || q.actor.dead) continue;
      const o = q.actor.controller.position;
      if (Math.hypot(o[0] - p[0], o[2] - p[2]) <= radius) out.push(q);
    }
    return out;
  }

  /** Split `total` among nearby party members: apply(member, share). The remainder goes to the earner. */
  shareXp(player, total, apply, options = {}) {
    const members = this.membersNear(player, options.radius ?? 40);
    const pool = Math.floor(total * (1 + (options.bonusPerMember ?? 0) * (members.length - 1)));
    const each = Math.floor(pool / members.length);
    for (const m of members) apply(m, m === player ? pool - each * (members.length - 1) : each);
    return members;
  }
}
