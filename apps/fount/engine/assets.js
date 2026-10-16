// Loading a game's data (sprites, abilities, statuses, particle presets,
// faction relations) from a config block. The browser game and an online server
// both call this, so the two always interpret the same files the same way.
//
// The caller says how to fetch JSON (the browser uses fetch, the server reads
// disk) and where the results go, so this file touches neither.

import { defineStatuses } from './actor.js';

/**
 * deps: {
 *   fetchJson(url) -> Promise<object>,
 *   sprites,            a SpriteLibrary
 *   abilities,          an AbilitySystem (or anything with define())
 *   relations,          a Relations
 *   particles,          optional: a ParticleSystem (a server has none)
 *   loaded,             a Set remembering what has been loaded, so each file is read once
 * }
 */
export async function loadAssets(cfg, deps) {
  const { fetchJson, sprites, abilities, relations, particles, loaded } = deps;
  const resolve = async (x) => (typeof x === 'string' ? fetchJson(x) : x);

  for (const src of [].concat(cfg.sprites || [])) {
    const key = typeof src === 'string' ? src : `inline:${JSON.stringify(src)}`;
    if (loaded.has(key)) continue;
    const data = await resolve(src);
    sprites.registerAll([].concat(data.sprites || data));
    loaded.add(key);
  }
  for (const def of cfg.spriteDefs || []) {
    const key = `inline:${JSON.stringify(def)}`;
    if (loaded.has(key)) continue;
    sprites.register(def);
    loaded.add(key);
  }

  const once = async (name, value, apply) => {
    if (value === undefined) return;
    const key = typeof value === 'string' ? value : `inline:${name}:${JSON.stringify(value)}`;
    if (loaded.has(key)) return;
    apply(await resolve(value));
    loaded.add(key);
  };
  await once('abilities', cfg.abilities, (d) => abilities.define(d.abilities || d));
  await once('statuses', cfg.statuses, (d) => defineStatuses(d.statuses || d));
  if (particles) await once('particles', cfg.particles, (d) => particles.defineAll(d.particles || d));

  for (const [pair, state] of Object.entries(cfg.relations || {})) {
    const [a, b] = pair.split('|');
    relations.set(a, b, state);
  }
}

// Sections that merge key by key when a map overrides the game's config;
// everything else the map says replaces the game's value outright.
const MERGED_SECTIONS = ['camera', 'render', 'player', 'nav', 'server'];

export function mergeConfig(base, over) {
  const out = { ...base, ...over };
  for (const k of MERGED_SECTIONS) if (base[k] || over[k]) out[k] = { ...(base[k] || {}), ...(over[k] || {}) };
  return out;
}

/** The parts of a map document that configure the engine rather than describe geometry. */
export function pickMapConfig(doc) {
  const out = {};
  for (const k of ['mode', 'camera', 'render', 'player', 'nav', 'server', 'instance', 'sprites', 'spriteDefs', 'abilities', 'statuses', 'particles', 'relations']) {
    if (doc[k] !== undefined) out[k] = doc[k];
  }
  return out;
}
