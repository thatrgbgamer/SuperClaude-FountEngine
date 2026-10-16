// Everything an online server knows about a game, loaded once from its folder:
// the config, sprites, abilities, statuses, faction relations, maps, and the
// game's own server scripts. It reads the same files the browser does, through
// the same loader (engine/assets.js), so the two cannot disagree.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpriteLibrary } from '../engine/sprites.js';
import { BUILTIN_SPRITES } from '../engine/builtin_sprites.js';
import { AbilitySystem } from '../engine/abilities.js';
import { Relations } from '../engine/combat.js';
import { loadAssets, mergeConfig, pickMapConfig } from '../engine/assets.js';

export class GameData {
  constructor(root, log = console.log) {
    this.root = path.resolve(root);
    this.log = log;
    this.config = {};
    this.sprites = new SpriteLibrary();
    this.sprites.registerAll(BUILTIN_SPRITES);
    this.abilityDefs = new Map();
    this.abilityRegistry = new AbilitySystem(null, this.abilityDefs);
    this.relations = new Relations();
    this.loaded = new Set();
    this.maps = new Map();
    this.hooks = [];          // the game's hook objects, one per script that exports `hooks`
    this.scripts = [];
  }

  /** Read JSON from inside the game folder. A path that escapes it is refused. */
  readJson(rel) {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`"${rel}" is outside the game folder`);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (err) { throw new Error(`Could not read ${rel}: ${err.code || err.message}`); }
    try { return JSON.parse(text); } catch (err) { throw new Error(`${rel} is not valid JSON: ${err.message}`); }
  }

  mapExists(rel) {
    if (typeof rel !== 'string' || !rel) return false;
    const full = path.resolve(this.root, rel);
    return (full === this.root || full.startsWith(this.root + path.sep)) && fs.existsSync(full) && fs.statSync(full).isFile();
  }

  assetDeps() {
    return {
      fetchJson: async (url) => this.readJson(url),
      sprites: this.sprites, abilities: this.abilityRegistry, relations: this.relations, loaded: this.loaded,
    };
  }

  /** Load game.json (or an inline config object), then the scripts it names. */
  async loadConfig(source = 'game/game.json') {
    const cfg = typeof source === 'string' ? this.readJson(source) : source;
    this.config = mergeConfig(this.config, cfg);
    await loadAssets(cfg, this.assetDeps());
    await this.loadScripts(cfg.scripts);
    return cfg;
  }

  /**
   * Import the game's server-side scripts: `scripts.server` (server only) and
   * `scripts.shared` (also loaded by the browser). A script may export
   * `serverInstall(gameData)` (called once) and `hooks` (see Instance).
   */
  async loadScripts(scripts) {
    if (!scripts) return;
    for (const rel of [].concat(scripts.shared || [], scripts.server || [])) {
      if (this.scripts.includes(rel)) continue;
      const full = path.resolve(this.root, rel);
      if (!full.startsWith(this.root + path.sep)) throw new Error(`Script "${rel}" is outside the game folder`);
      let mod;
      try { mod = await import(pathToFileURL(full).href); } catch (err) {
        throw new Error(`Could not load server script ${rel}: ${err.message}. Server scripts run in Node, so they cannot use fetch, localStorage, window or document at load time.`);
      }
      this.scripts.push(rel);
      if (mod.serverInstall) await mod.serverInstall(this);
      if (mod.hooks) this.hooks.push(mod.hooks);
    }
  }

  /** A map's document, cached. Its own sprites/abilities/statuses are loaded the first time. */
  async map(rel) {
    let entry = this.maps.get(rel);
    if (!entry) {
      const doc = this.readJson(rel);
      await loadAssets(pickMapConfig(doc), this.assetDeps());
      entry = { doc, config: mergeConfig(this.config, pickMapConfig(doc)) };
      this.maps.set(rel, entry);
    }
    return entry;
  }

  /** Call a hook on every script that defines it; the first non-undefined answer wins for hooks that return one. */
  callHook(name, ...args) {
    let result;
    for (const h of this.hooks) {
      if (typeof h[name] !== 'function') continue;
      const r = h[name](...args);
      if (r !== undefined && result === undefined) result = r;
    }
    return result;
  }
}
