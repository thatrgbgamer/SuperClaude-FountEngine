// The client half of chat and parties: keeps the chat log and the party frame
// the server sends, and gives a game's UI one place to call and to listen to.
//
//   game.chat.say('hello')            game.chat.whisper('Bob', 'hi')    game.chat.send('party', 'push now')
//   game.chat.lines                    the last 100 lines: { ch, from, text, to, ts }
//   game.parties.invite('Bob')         accept() decline() leave() kick(n) promote(n) disband()
//   game.parties.state                 null, or { id, leader, members: [{ id, name, hp, mh, res, map, online, ... }] }
//   game.parties.invitation            null, or { from, until }
//   game.chat.emote('wave')            game.chat.ignore('Bob')           game.chat.report('Bob', 'spam')
//
// Events on game.events: 'chat-line' (line), 'party-changed' (state), 'party-invite' (invitation), 'emote' ({ actor, id }).

const MAX_LINES = 100;

export class ChatClient {
  constructor(game) { this.game = game; this.lines = []; }

  get session() { return this.game.online ? this.game.online.session : null; }
  get online() { return !!this.session; }

  receive(msg) {
    const line = { ch: msg.ch || 'say', from: msg.from || null, text: String(msg.text || ''), to: msg.to || null, echo: !!msg.echo, ts: Date.now() };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    this.game.events.emit('chat-line', line);
  }

  send(channel, text, to = '') {
    const s = this.session;
    if (!s || !text) return false;
    s.chat(String(text), channel, to);
    return true;
  }

  say(text) { return this.send('say', text); }
  whisper(name, text) { return this.send('whisper', text, name); }
  emote(id) { const s = this.session; if (!s) return false; s.send({ t: 'emote', id: String(id) }); return true; }
  ignore(name) { const s = this.session; if (s) s.send({ t: 'social', op: 'ignore', name: String(name) }); return !!s; }
  unignore(name) { const s = this.session; if (s) s.send({ t: 'social', op: 'unignore', name: String(name) }); return !!s; }
  report(name, reason = '') { const s = this.session; if (s) s.send({ t: 'social', op: 'report', name: String(name), reason: String(reason) }); return !!s; }

  /**
   * Parse what a player typed into a chat box: "/w Bob hi", "/p text", "/g text", "/world text",
   * "/invite Bob", "/e wave", "/ignore Bob". Anything else is said aloud. Returns true if it did something.
   */
  submit(input) {
    const text = String(input || '').trim();
    if (!text) return false;
    if (text[0] !== '/') return this.say(text);
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    const P = this.game.parties;
    switch (cmd.toLowerCase()) {
      case 's': case 'say': return this.say(arg);
      case 'p': case 'party': return this.send('party', arg);
      case 'g': case 'guild': return this.send('guild', arg);
      case 'world': case 'w1': return this.send('world', arg);
      case 'w': case 'whisper': case 'tell': { const [to, ...msg] = rest; return this.whisper(to, msg.join(' ')); }
      case 'e': case 'emote': return this.emote(arg);
      case 'ignore': return this.ignore(arg);
      case 'unignore': return this.unignore(arg);
      case 'invite': return P.invite(arg);
      case 'accept': return P.accept();
      case 'decline': return P.decline();
      case 'leave': return P.leave();
      case 'kick': return P.kick(arg);
      case 'promote': return P.promote(arg);
      default: return false;
    }
  }
}

export class PartyClient {
  constructor(game) { this.game = game; this.state = null; this.invitation = null; }

  get session() { return this.game.online ? this.game.online.session : null; }
  get inParty() { return !!this.state; }
  get leader() { return this.state ? this.state.members.find((m) => m.id === this.state.leader) || null : null; }
  has(name) { return !!this.state && this.state.members.some((m) => m.name === name); }
  get isLeader() { const s = this.session; return !!(this.state && s && this.state.leader === s.playerId); }

  receive(msg) {
    if (msg.ev === 'state') {
      this.state = msg.party || null;
      if (this.state) this.invitation = null;
      this.game.events.emit('party-changed', this.state);
    } else if (msg.ev === 'invite') {
      this.invitation = { from: String(msg.from || ''), until: Date.now() + (Number(msg.ttl) || 60) * 1000 };
      this.game.events.emit('party-invite', this.invitation);
    }
  }

  clear() { this.state = null; this.invitation = null; }

  op(op, name = '') {
    const s = this.session;
    if (!s) return false;
    s.send({ t: 'party', op, name: String(name) });
    return true;
  }

  invite(name) { return this.op('invite', name); }
  accept() { const ok = this.op('accept'); this.invitation = null; return ok; }
  decline() { const ok = this.op('decline'); this.invitation = null; return ok; }
  leave() { return this.op('leave'); }
  kick(name) { return this.op('kick', name); }
  promote(name) { return this.op('promote', name); }
  disband() { return this.op('disband'); }
}
