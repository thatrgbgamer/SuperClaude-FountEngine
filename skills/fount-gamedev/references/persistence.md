# Accounts, characters and persistence

For games on `server/mmo.mjs` with `--auth optional|required`. The engine stores accounts, characters, a gold ledger and an audit log. It does not know what a character *is* beyond what an actor already holds: your game's level, gold, inventory and quests live in `actor.data`, and whatever is in there is saved.

## Contents

- [Stores](#stores) · [Accounts and the HTTP API](#accounts-and-the-http-api) · [Characters](#characters)
- [The save record](#the-save-record-and-the-snapshot-interface) · [When saves happen](#when-saves-happen) · [Versioning](#versioning-and-migration)
- [Gold and the economy](#gold-and-the-economy) · [Collections](#free-form-collections) · [Moderation](#bans-and-the-audit-log) · [Backups](#backups)

## Stores

`createStore({ kind, path, module })` in `server/store.mjs`:

| kind | what | when |
|---|---|---|
| `sqlite` | one file (`<root>/data/fount.db`) via Node's built-in `node:sqlite`; WAL; consistent online backups | the default when Node has it (22.5+) |
| `file` | a folder of JSON files with atomic writes (`data/store`) | Node without sqlite, or when you want diffable data |
| `memory` | nothing persists | tests |
| `custom` | `{ kind: 'custom', module: './my-store.mjs' }` exporting `createStore(options)` | Postgres or anything else |
| `auto` | sqlite, falling back to file | default |

Every store implements the same contract (`tests/store-contract.mjs` is a conformance suite a custom store can run): accounts, sessions, magic tokens, characters (soft delete with restore), transactions, audit, free-form collections, `backup(dest)`, `close()`, `info()`.

Choose with `--store sqlite|file|memory` and `--data <dir>`.

## Accounts and the HTTP API

Account names are 3 to 20 characters (letters, digits, and `_ . ' -` inside). Passwords are 8 to 128 characters (`authOptions.minPassword` raises the minimum) and are stored only as scrypt hashes. Session tokens are stored only as SHA-256 hashes; a stolen database cannot be replayed as logins. Login attempts are limited per address and per account, with `Retry-After`.

```
POST   /api/register    { name, password }              → { token, account }
POST   /api/login       { name, password } | { magic }  → { token, account }
POST   /api/logout
GET    /api/me                                          → { account, characters }
POST   /api/password    { old, new }                    → { token }
GET    /api/characters                                  → { characters }
POST   /api/characters  { name, class }                 → { character }
DELETE /api/characters/:id  { confirm: "<name>" }
```

After login send `Authorization: Bearer <token>`. Errors are `{ error, code }` with a status a client can act on. Bodies are capped at 8 KB and each address is limited (`apiRateLimit`, 120/minute). Cross-origin pages need `corsOrigin`. Behind a proxy set `--trust-proxy`. One-time magic links (`auth.issueMagicToken(name)`) let an operator hand out an account without a password.

The client side is `engine/account.js` (`AccountClient`): keeps the token in `localStorage` (guarded, because storage can be blocked), turns server errors into exceptions with `.code`, and gives `hello(characterId)` and `socketUrl()` for connecting.

## Characters

An account holds up to `server.maxCharacters` (5). Names are 3 to 16 letters with spaces, apostrophes and hyphens inside, unique across the server. The `classes()` hook restricts classes; `nameAllowed(name)` can refuse names. Deleting needs the exact name typed and refuses while the character is in the world. `characterSummary(record, character)` adds fields (level, class art) to the character-select list.

Joining with a character is checked on the server: the token names the account and the character id must belong to it. A character already in the world (connected or lingering after a drop) is resumed rather than duplicated.

## The save record and the snapshot interface

```js
{ snapshot: actor.snapshot(), position: { map, feet, yaw }, savedAt }
```

`actor.snapshot()` is plain JSON: `name, health, maxHealth, resources, stats, statuses, cooldowns, data`. `actor.restore(snapshot)` is its inverse, and it is also what a portal uses to carry a character between maps, so *whatever survives a map change survives a logout*. Put your game's persistent state in `actor.data` (level, gold, inventory, quest flags). The engine adds only where the character stood. A dead character is saved at their respawn point. Scaled health (`setScale`, sidekicking) is saved unscaled.

A returning character arrives where they were, unless that spot is now inside a wall, in which case they get the map's normal arrival.

## When saves happen

On leaving, on joining, on every map change, every `autosaveSeconds` (45) per player, on `admin save`, and for everyone before a shutdown. Saves for one character are queued in order, so a slow disk never lets an older save overwrite a newer one. A failed save is logged and counted (`fount_save_failures_total`); the next one retries.

## Versioning and migration

`server.characterVersion` is the current version of *your* save format (default 1). Characters are stamped with it. When a character with an older version joins, `migrateCharacter(record, fromVersion, toVersion)` returns the upgraded record and the result is saved; with no hook the record passes through unchanged. A character *newer* than the server is refused, so an old server never corrupts new data.

## Gold and the economy

Gold lives at `actor.data.gold` (`server.goldField` renames it). Scripts must not edit it directly; use `world.context.economy`:

```js
economy.grant(player, 50, 'loot', { monster: 'imp' });
economy.spend(player, 20, 'shop');            // false if they cannot afford it
economy.transfer(from, to, 10, 'trade');
economy.balance(player);
```

Amounts are whole, positive numbers only (non-numbers, fractions, negatives and `NaN` are refused), so a bad client value cannot mint or steal gold. Every change goes to the transaction ledger with who, why and the balance after. `server/characters.mjs rollbackGold({ store, manager, economy, characterId, sinceId })` undoes gold changes since a ledger entry (for a duplication exploit), through the economy if the player is online or on the saved record if not. The admin command is `rollback-gold <characterId> <transactionId>`. Single player has the same `economy` with no ledger.

## Free-form collections

`store.getRecord(collection, key)`, `putRecord(collection, key, value)`, `deleteRecord(collection, key)` and `listRecords(collection, { prefix, limit })` give a game somewhere to keep banks, guilds, mail and auction listings without the engine knowing what they are. Keys are strings, values are JSON, and records are listed by key prefix.

## Bans and the audit log

`ban <account> [reason]` (admin) flags the account, deletes its sessions and removes anyone playing it. Banned accounts cannot log in. The audit log records character creation and deletion, admin commands (with who), chat reports and gold rollbacks: `audit [n]`.

## Backups

`store.backup(dest)` is consistent while the server runs. The server takes one every 60 minutes and keeps 14 (`--backup-minutes`, `--backup-keep`, `--backup-dir`); `backup` takes one now. Restore with the server stopped: `node server/mmo.mjs --restore <backup>` (the old data is moved aside as `*.before-restore-*`).
