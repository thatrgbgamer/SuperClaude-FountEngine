// Developer console: a Quake-style drop-down with commands and cvars.
//
// Commands are registered as data, so a game (or the multiplayer server's
// admin layer) adds its own with one call and gets help text, tab-completion
// and history for free.

import { getEntityDefinition } from './entity.js';

const HISTORY_LIMIT = 80;
const OUTPUT_LIMIT = 200;

export class GameConsole {
  constructor(game) {
    this.game = game;
    this.commands = new Map();
    this.cvars = new Map();
    this.history = [];
    this.historyIndex = -1;
    this.lines = [];
    this.open = false;
    this.onExternalCommand = null; // set by the netcode to relay admin commands

    this.buildDom();
    this.registerBuiltins();

    window.addEventListener('keydown', (e) => this.handleKey(e), true);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /** register('noclip', 'Toggle collision', (args, ctx) => string | void) */
  register(name, help, run, options = {}) {
    this.commands.set(name.toLowerCase(), {
      name, help, run, usage: options.usage || '', cheat: !!options.cheat,
    });
  }

  /**
   * Cheat commands are blocked on a server that hasn't enabled them — the same
   * rule Quake and Source use, and here it is protective as much as fair: the
   * anticheat cannot tell an honest player's noclip from a cheat client's, so
   * without this the console would be a way to get yourself kicked.
   */
  cheatsBlocked() {
    const net = this.game && this.game.net;
    if (!net || !net.connected) return false;      // single-player: your game, your rules
    return !net.cheatsAllowed;
  }

  /**
   * A cvar is a named value with a setter, so `set` and tab-completion work
   * uniformly instead of each tunable needing its own bespoke command.
   */
  registerCvar(name, help, get, set, options = {}) {
    this.cvars.set(name.toLowerCase(), { name, help, get, set, cheat: !!options.cheat });
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  print(text, kind = 'out') {
    for (const line of String(text).split('\n')) {
      this.lines.push({ text: line, kind });
    }
    while (this.lines.length > OUTPUT_LIMIT) this.lines.shift();
    this.renderOutput();
  }

  echo(text) { this.print(text, 'out'); }
  warn(text) { this.print(text, 'warn'); }
  error(text) { this.print(text, 'err'); }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /** Split on whitespace but keep "quoted strings" as one argument. */
  static tokenize(line) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }

  execute(line, source = 'local') {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    // Semicolons chain commands, which is what makes aliases and config
    // one-liners possible.
    if (trimmed.includes(';')) {
      for (const part of trimmed.split(';')) this.execute(part, source);
      return;
    }

    const tokens = GameConsole.tokenize(trimmed);
    const name = tokens[0].toLowerCase();
    const args = tokens.slice(1);

    const command = this.commands.get(name);
    if (command) {
      if (command.cheat && this.cheatsBlocked()) {
        this.warn(`${command.name} is disabled on this server.`);
        return;
      }
      try {
        const result = command.run(args, { source, console: this, game: this.game });
        if (result !== undefined && result !== null) this.print(result);
      } catch (err) {
        this.error(`${name}: ${err.message}`);
      }
      return;
    }

    // Bare cvar name prints it; `name value` sets it. Reading is always
    // allowed; writing a cheat-protected one is not, on a server that says so.
    const cvar = this.cvars.get(name);
    if (cvar) {
      if (!args.length) {
        this.print(`${cvar.name} = ${cvar.get()}`);
      } else if (cvar.cheat && this.cheatsBlocked()) {
        this.warn(`${cvar.name} is locked on this server.`);
      } else {
        this.setCvar(cvar, args.join(' '));
      }
      return;
    }

    this.error(`Unknown command "${tokens[0]}". Type help for a list.`);
  }

  setCvar(cvar, raw) {
    const current = cvar.get();
    let value = raw;
    if (typeof current === 'number') {
      value = parseFloat(raw);
      if (!Number.isFinite(value)) { this.error(`${cvar.name} expects a number`); return; }
    } else if (typeof current === 'boolean') {
      value = !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
    }
    cvar.set(value);
    this.print(`${cvar.name} = ${cvar.get()}`);
  }

  complete(prefix) {
    const lower = prefix.toLowerCase();
    const names = [...this.commands.keys(), ...this.cvars.keys()];
    return names.filter((n) => n.startsWith(lower)).sort();
  }

  // -------------------------------------------------------------------------
  // Built-in commands
  // -------------------------------------------------------------------------

  registerBuiltins() {
    const game = () => this.game;
    const player = () => this.game.player;
    const world = () => this.game.world;

    this.register('help', 'List commands, or show help for one', (args) => {
      if (args.length) {
        const c = this.commands.get(args[0].toLowerCase());
        const v = this.cvars.get(args[0].toLowerCase());
        if (c) return `${c.name} ${c.usage}\n  ${c.help}`;
        if (v) return `${v.name} = ${v.get()}\n  ${v.help}`;
        return `No such command: ${args[0]}`;
      }
      const cmds = [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
      const vars = [...this.cvars.values()].sort((a, b) => a.name.localeCompare(b.name));
      const pad = (s) => s.padEnd(14);
      return 'Commands:\n'
        + cmds.map((c) => `  ${pad(c.name)} ${c.help}`).join('\n')
        + '\n\nVariables (name to read, name value to set):\n'
        + vars.map((v) => `  ${pad(v.name)} ${v.help}`).join('\n');
    }, { usage: '[command]' });

    this.register('clear', 'Clear the console output', () => {
      this.lines.length = 0;
      this.renderOutput();
    });

    this.register('echo', 'Print text back', (args) => args.join(' '));

    this.register('noclip', 'Toggle flying through walls', () => {
      const p = player();
      p.noclip = !p.noclip;
      if (p.noclip) p.controller.velocity = [0, 0, 0];
      return `noclip ${p.noclip ? 'ON' : 'off'}`;
    }, { cheat: true });

    this.register('god', 'Toggle invulnerability', () => {
      const p = player();
      p.godMode = !p.godMode;
      if (p.godMode) p.health = p.maxHealth;
      return `god ${p.godMode ? 'ON' : 'off'}`;
    }, { cheat: true });

    this.register('give', 'Give health or ammo', (args) => {
      const what = (args[0] || '').toLowerCase();
      const amount = parseFloat(args[1]) || 100;
      const p = player();
      if (what === 'health' || what === 'hp') { p.health = Math.min(p.maxHealth, p.health + amount); return `health = ${Math.ceil(p.health)}`; }
      if (what === 'ammo') { p.ammo += amount; return `ammo = ${p.ammo}`; }
      if (what === 'all') { p.health = p.maxHealth; p.ammo += 999; return 'gave health and ammo'; }
      return 'usage: give health|ammo|all [amount]';
    }, { usage: 'health|ammo|all [amount]', cheat: true });

    this.register('teleport', 'Move the player to coordinates', (args) => {
      const [x, y, z] = args.map(parseFloat);
      if (![x, y, z].every(Number.isFinite)) return 'usage: teleport <x> <y> <z>';
      player().teleport([x, y, z]);
      return `teleported to ${x} ${y} ${z}`;
    }, { usage: '<x> <y> <z>', cheat: true });

    this.register('where', 'Print the player position and angles', () => {
      const p = player().controller.position.map((n) => n.toFixed(2));
      const a = player().angles.map((n) => n.toFixed(1));
      return `position ${p.join(' ')}\nangles   ${a.join(' ')}`;
    });

    this.register('spawn', 'Spawn an entity at the crosshair', (args) => {
      const classname = args[0];
      if (!classname) return 'usage: spawn <classname> [key value ...]';
      const g = game();
      const origin = g.aimPoint ? g.aimPoint() : player().controller.position;
      const data = { classname, origin: origin.map((n) => +n.toFixed(2)) };
      for (let i = 1; i + 1 < args.length; i += 2) {
        const raw = args[i + 1];
        const num = parseFloat(raw);
        data[args[i]] = Number.isFinite(num) && String(num) === raw ? num : raw;
      }
      world().spawn(data);
      return `spawned ${classname} at ${data.origin.join(' ')}`;
    }, { usage: '<classname> [key value ...]', cheat: true });

    this.register('ragdoll', 'Drop a ragdoll at the crosshair', () => {
      const g = game();
      const origin = g.aimPoint ? g.aimPoint() : player().controller.position;
      g.ragdolls.spawn({
        origin,
        yaw: player().angles[1],
        velocity: [0, 1, 0],
        materials: { body: g.built.materialIndex.get('cloth') ?? 9, skin: g.built.materialIndex.get('flesh') ?? 8 },
      });
      return `ragdoll spawned (${g.ragdolls.count} bodies)`;
    });

    this.register('killall', 'Kill every NPC', () => {
      const w = world();
      const npcs = w.findByClass('npc_grunt');
      // Invoked directly rather than by name: most map NPCs have no `name`,
      // and a name lookup would silently skip them.
      for (const npc of npcs) {
        const def = getEntityDefinition(npc.classname);
        if (def && def.inputs && def.inputs.Kill) def.inputs.Kill(npc, w, {});
        else w.remove(npc);
      }
      return `killed ${npcs.length} NPC(s)`;
    });

    this.register('clearbodies', 'Remove all ragdolls', () => {
      const n = game().ragdolls.count;
      game().ragdolls.clear();
      return `removed ${n} bodies`;
    });

    this.register('ent', 'List entities, or inspect one by name', (args) => {
      const w = world();
      if (!args.length) {
        const counts = {};
        for (const e of w.entities) counts[e.classname] = (counts[e.classname] || 0) + 1;
        return Object.entries(counts).sort().map(([k, v]) => `  ${v}x ${k}`).join('\n') || '  (none)';
      }
      const found = w.find(args[0]);
      if (!found.length) return `No entity named "${args[0]}"`;
      return found.map((e) => `${e.classname} "${e.name}" origin ${e.origin.map((n) => n.toFixed(1)).join(' ')} enabled=${e.enabled}`).join('\n');
    }, { usage: '[name]' });

    this.register('fire', 'Send an input to a named entity', (args) => {
      const [target, input, param] = args;
      if (!target || !input) return 'usage: fire <entityName> <Input> [param]';
      world().sendInput(target, input, { param });
      return `sent ${input} to ${target}`;
    }, { usage: '<entityName> <Input> [param]' });

    this.register('map', 'Load a map by path, or restart the current one', (args) => {
      const g = game();
      if (!args.length) { g.restart(); return `restarted ${g.mapName}`; }
      g.load(args[0]).then(() => this.echo(`loaded ${args[0]}`)).catch((e) => this.error(String(e.message)));
      return `loading ${args[0]}...`;
    }, { usage: '[path]' });

    this.register('restart', 'Restart the current map', () => {
      game().restart();
      return 'restarted';
    });

    this.register('pause', 'Toggle simulation pause', () => {
      const g = game();
      g.paused = !g.paused;
      return `paused ${g.paused ? 'ON' : 'off'}`;
    });

    // --- multiplayer ---
    this.register('connect', 'Join a server (default: the one hosting this page)', (args) => {
      const g = game();
      if (!g.net) return 'Networking unavailable in this build.';
      if (args[0]) g.net.url = normaliseServerUrl(args[0]);
      g.net.wantReconnect = true;
      g.net.connect();
      return `connecting to ${g.net.url}`;
    }, { usage: '[host[:port]]' });

    // Top-down games run their own protocol (see multiplayer.md); `connect` above is the first-person one.
    this.register('online', 'Join a top-down game server (default: the one hosting this page)', (args) => {
      const g = game();
      const url = normaliseServerUrl(args[0] || location.host);
      g.playOnline(url, { hello: { name: args[1] } })
        .then(() => this.print('joined ' + url))
        .catch((e) => this.error(e.message));
      return `connecting to ${url}...`;
    }, { usage: '[host[:port]] [name]' });

    this.register('offline', 'Leave an online top-down game', () => {
      const g = game();
      if (!g.online) return 'Not playing online.';
      g.goOffline();
      return 'left the server (reload the map to play offline)';
    });

    this.register('disconnect', 'Leave the current server', () => {
      const g = game();
      if (!g.net || !g.net.connected) return 'Not connected.';
      g.net.disconnect();
      return 'disconnected';
    });

    this.register('say', 'Send a chat message (prefix with / for admin commands)', (args) => {
      const g = game();
      if (!g.net || !g.net.connected) return 'Not connected to a server.';
      const text = args.join(' ');
      if (!text) return 'usage: say <text>';
      g.net.chat(text);
    }, { usage: '<text>' });

    this.register('name', 'Set your player name', (args) => {
      const g = game();
      const next = args.join(' ').trim();
      if (!next) return `name = ${g.net ? g.net.name : '(offline)'}`;
      if (g.net) g.net.setName(next.slice(0, 20));
      return `name = ${next.slice(0, 20)}`;
    }, { usage: '<name>' });

    this.register('players', 'Show the scoreboard', () => {
      const g = game();
      if (!g.net || !g.net.connected) return 'Not connected to a server.';
      const rows = g.net.scoreboard();
      if (!rows.length) return 'No players.';
      return rows.map((r) => `  ${String(r.kills).padStart(3)}k ${String(r.deaths).padStart(3)}d  ${r.name}`).join('\n');
    });

    this.register('status', 'Show connection status', () => {
      const g = game();
      if (!g.net) return 'Networking unavailable.';
      return g.net.connected
        ? `connected to ${g.net.serverName || g.net.url} as ${g.net.name}\n${g.net.playerCount} player(s) online`
        : `not connected (${g.net.statusText || 'idle'})`;
    });

    this.register('bind', 'Show the key bindings', () => (
      'WASD        move\n'
      + 'Space       jump\n'
      + 'Mouse       look (click to capture) / drag to look\n'
      + 'Arrows      look without the mouse\n'
      + 'F, Enter    shoot\n'
      + 'Ctrl        shoot\n'
      + 'Shift+R     restart map\n'
      + '`  or  ~   toggle this console'
    ));

    // --- cvars ---
    this.registerCvar('sensitivity', 'Mouse look sensitivity',
      () => this.game.sensitivity, (v) => { this.game.sensitivity = v; });
    this.registerCvar('fov', 'Field of view in degrees',
      () => this.game.fov ?? 78, (v) => { this.game.fov = Math.max(50, Math.min(130, v)); });
    this.registerCvar('gravity', 'Player gravity',
      () => player().controller.gravity, (v) => { player().controller.gravity = v; }, { cheat: true });
    this.registerCvar('speed', 'Player max ground speed',
      () => player().controller.maxSpeed, (v) => { player().controller.maxSpeed = v; }, { cheat: true });
    this.registerCvar('jump', 'Player jump speed',
      () => player().controller.jumpSpeed, (v) => { player().controller.jumpSpeed = v; }, { cheat: true });
    this.registerCvar('timescale', 'Simulation speed multiplier',
      () => this.game.timescale ?? 1, (v) => { this.game.timescale = Math.max(0.05, Math.min(4, v)); }, { cheat: true });
    this.registerCvar('maxbodies', 'Maximum simultaneous ragdolls',
      () => this.game.ragdolls.maxRagdolls, (v) => { this.game.ragdolls.maxRagdolls = Math.max(1, Math.floor(v)); });
    this.registerCvar('showfps', 'Show the performance readout',
      () => this.game.showFps !== false, (v) => { this.game.showFps = v; });
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  buildDom() {
    const root = document.createElement('div');
    root.id = 'fount-console';
    root.innerHTML = `
      <div class="fc-output"></div>
      <div class="fc-inputrow"><span class="fc-prompt">&gt;</span><input class="fc-input" spellcheck="false" autocomplete="off"></div>
      <div class="fc-complete"></div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #fount-console {
        position: fixed; left: 0; right: 0; top: 0; height: 46vh; z-index: 50;
        background: rgba(8, 11, 16, 0.95); border-bottom: 1px solid rgba(111,211,199,0.4);
        display: none; flex-direction: column;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #e8ecf2; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      }
      #fount-console.fc-open { display: flex; }
      #fount-console .fc-output { flex: 1; overflow-y: auto; padding: 10px 14px; white-space: pre-wrap; word-break: break-word; }
      #fount-console .fc-line { margin: 0; }
      #fount-console .fc-cmd { color: #6fd3c7; }
      #fount-console .fc-warn { color: #e8b44a; }
      #fount-console .fc-err { color: #e2564d; }
      #fount-console .fc-inputrow { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
      #fount-console .fc-prompt { color: #6fd3c7; font-weight: 700; }
      #fount-console .fc-input { flex: 1; background: transparent; border: 0; outline: 0; color: #e8ecf2; font: inherit; }
      #fount-console .fc-complete { padding: 0 14px 8px; color: #8b97a8; min-height: 18px; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(root);

    this.root = root;
    this.outputEl = root.querySelector('.fc-output');
    this.inputEl = root.querySelector('.fc-input');
    this.completeEl = root.querySelector('.fc-complete');

    this.inputEl.addEventListener('keydown', (e) => this.handleInputKey(e));
    this.inputEl.addEventListener('input', () => this.updateCompletion());

    this.print('Fount console. Type help for commands, ` to close.', 'cmd');
  }

  renderOutput() {
    if (!this.outputEl) return;
    this.outputEl.innerHTML = this.lines
      .map((l) => `<p class="fc-line ${l.kind === 'out' ? '' : 'fc-' + l.kind}">${escapeHtml(l.text)}</p>`)
      .join('');
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  updateCompletion() {
    const value = this.inputEl.value;
    if (!value || value.includes(' ')) { this.completeEl.textContent = ''; return; }
    const matches = this.complete(value);
    this.completeEl.textContent = matches.length && matches.length < 30 ? matches.join('  ') : '';
  }

  setOpen(open) {
    this.open = open;
    this.root.classList.toggle('fc-open', open);
    if (open) {
      this.inputEl.focus();
      // Keys held when the console opens would otherwise stay stuck down.
      this.game.keys.clear();
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      this.inputEl.blur();
    }
  }

  handleKey(e) {
    // Backquote toggles; Escape closes. Capture phase so the game never sees it.
    if (e.code === 'Backquote' || (e.key === '~' && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.setOpen(!this.open);
      return;
    }
    if (this.open && e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.setOpen(false);
    }
    // Deliberately no stopPropagation here: this is a capture-phase listener,
    // so swallowing the event would stop it reaching the console's own input
    // field. The game ignores keys while the console is open instead.
  }

  handleInputKey(e) {
    if (e.code === 'Enter') {
      e.preventDefault();
      const line = this.inputEl.value;
      this.inputEl.value = '';
      this.completeEl.textContent = '';
      if (!line.trim()) return;
      this.print('> ' + line, 'cmd');
      this.history.unshift(line);
      while (this.history.length > HISTORY_LIMIT) this.history.pop();
      this.historyIndex = -1;
      this.execute(line);
      return;
    }

    if (e.code === 'Tab') {
      e.preventDefault();
      const matches = this.complete(this.inputEl.value);
      if (matches.length === 1) {
        this.inputEl.value = matches[0] + ' ';
      } else if (matches.length > 1) {
        // Fill in the longest shared prefix, the way a shell does.
        let prefix = matches[0];
        for (const m of matches) {
          while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
        }
        this.inputEl.value = prefix;
        this.print(matches.join('  '));
      }
      this.updateCompletion();
      return;
    }

    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      this.historyIndex += e.code === 'ArrowUp' ? 1 : -1;
      this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex));
      this.inputEl.value = this.historyIndex < 0 ? '' : this.history[this.historyIndex];
      this.updateCompletion();
    }
  }
}

/** Accepts "example.com", "example.com:8099" or a full ws:// URL. */
function normaliseServerUrl(input) {
  const raw = String(input).trim();
  if (/^wss?:\/\//i.test(raw)) return raw;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${raw}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
