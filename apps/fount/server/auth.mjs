// Accounts and sessions, self-hosted: a name and a password, no third party.
//
// Passwords are hashed with scrypt and a random salt per account, and compared
// in constant time. A session token is 256 random bits shown to the client once;
// only its SHA-256 is stored, so a leaked database does not hand out logins.
// A magic token is a one-time login an operator can mint (for a player who
// forgot their password, or to hand out a trial account). Failed attempts are
// rate limited by address and by account, and slow down the more there are.
//
// A host that wants single sign-on instead passes `authenticator` to the server:
// an async function that gets the hello and returns { accountName } or null.

import crypto from 'node:crypto';
import { StoreError } from './store.mjs';

const scrypt = (password, salt, keylen, params) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, keylen, params, (err, key) => (err ? reject(err) : resolve(key)));
});

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

export class AuthError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** Hash a password into one self-describing string: scrypt$N$r$p$salt$hash. */
export async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  const want = Buffer.from(hash, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

/** Counts failures per key and says how long to wait: 0 for the first few, then doubling up to a ceiling. */
export class AttemptLimiter {
  constructor({ free = 4, baseSeconds = 2, maxSeconds = 600, forgetSeconds = 900 } = {}) {
    Object.assign(this, { free, baseSeconds, maxSeconds, forgetSeconds });
    this.state = new Map();
  }

  /** Seconds until this key may try again (0 if it may try now). */
  wait(key, now = Date.now()) {
    const s = this.state.get(key);
    if (!s) return 0;
    if (now - s.last > this.forgetSeconds * 1000) { this.state.delete(key); return 0; }
    return Math.max(0, Math.ceil((s.until - now) / 1000));
  }

  fail(key, now = Date.now()) {
    const s = this.state.get(key) || { count: 0, until: 0, last: now };
    s.count++;
    s.last = now;
    if (s.count > this.free) s.until = now + Math.min(this.maxSeconds, this.baseSeconds * 2 ** (s.count - this.free - 1)) * 1000;
    this.state.set(key, s);
    if (this.state.size > 10000) for (const [k, v] of this.state) if (now - v.last > this.forgetSeconds * 1000) this.state.delete(k);
  }

  succeed(key) { this.state.delete(key); }
}

export const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9_ .'-]{1,18}[A-Za-z0-9]$/;

export class Auth {
  constructor(store, options = {}) {
    this.store = store;
    this.sessionDays = options.sessionDays ?? 30;
    this.minPassword = options.minPassword ?? 8;
    this.params = options.scrypt || SCRYPT;
    this.byAddress = new AttemptLimiter(options.addressLimit);
    this.byAccount = new AttemptLimiter(options.accountLimit);
    this.allowRegistration = options.allowRegistration !== false;
  }

  validName(name) { return typeof name === 'string' && NAME_RULE.test(name) && !/  /.test(name); }

  validPassword(password) {
    return typeof password === 'string' && password.length >= this.minPassword && password.length <= 128;
  }

  async startSession(account) {
    const token = newToken();
    await this.store.putSession(sha256(token), account.id, Date.now() + this.sessionDays * 86400000);
    await this.store.updateAccount(account.id, { lastLogin: Date.now() });
    return token;
  }

  throttle(address, name) {
    const wait = Math.max(this.byAddress.wait(address), name ? this.byAccount.wait(String(name).toLowerCase()) : 0);
    if (wait > 0) throw new AuthError('throttled', `Too many attempts. Try again in ${wait} seconds.`, { retryAfter: wait });
  }

  async register(name, password, address = '') {
    if (!this.allowRegistration) throw new AuthError('closed', 'New accounts are not being created on this server.');
    this.throttle(address);
    if (!this.validName(name)) throw new AuthError('bad-name', 'Account names are 3 to 20 letters, digits, spaces and . _ \' -');
    if (!this.validPassword(password)) throw new AuthError('bad-password', `Passwords must be ${this.minPassword} to 128 characters.`);
    let account;
    try {
      account = await this.store.createAccount({ name, hash: await hashPassword(password, this.params) });
    } catch (err) {
      if (err instanceof StoreError && err.code === 'name-taken') throw new AuthError('name-taken', 'That account name is taken.');
      throw err;
    }
    return { account, token: await this.startSession(account) };
  }

  async login(name, password, address = '') {
    this.throttle(address, name);
    const account = typeof name === 'string' ? await this.store.findAccount(name) : null;
    // Hash something even for an unknown name, so a wrong name and a wrong password take the same time.
    const ok = await verifyPassword(String(password ?? ''), account ? account.hash : 'scrypt$16384$8$1$00$00').catch(() => false);
    if (!account || !ok) {
      this.byAddress.fail(address);
      this.byAccount.fail(String(name).toLowerCase());
      throw new AuthError('bad-login', 'That name and password do not match.');
    }
    if (account.banned) throw new AuthError('banned', `This account is banned${account.banReason ? `: ${account.banReason}` : '.'}`);
    this.byAddress.succeed(address);
    this.byAccount.succeed(String(name).toLowerCase());
    return { account, token: await this.startSession(account) };
  }

  /** The account a session token belongs to, or null. */
  async verifyToken(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const session = await this.store.getSession(sha256(token));
    if (!session) return null;
    const account = await this.store.getAccount(session.accountId);
    return account && !account.banned ? account : null;
  }

  async logout(token) { if (typeof token === 'string') await this.store.deleteSession(sha256(token)); }

  async changePassword(account, oldPassword, newPassword) {
    if (!(await verifyPassword(String(oldPassword ?? ''), account.hash))) throw new AuthError('bad-login', 'The current password is wrong.');
    if (!this.validPassword(newPassword)) throw new AuthError('bad-password', `Passwords must be ${this.minPassword} to 128 characters.`);
    await this.store.updateAccount(account.id, { hash: await hashPassword(newPassword, this.params) });
    await this.store.deleteSessionsFor(account.id);   // every other device is signed out
    return this.startSession(account);
  }

  // ---- operator tools --------------------------------------------------------------

  /** A one-time login for an account (a forgotten password; a trial). The operator hands the string over. */
  async issueMagicToken(accountName, ttlSeconds = 3600) {
    const account = await this.store.findAccount(accountName);
    if (!account) throw new AuthError('no-such-account', `There is no account called "${accountName}".`);
    const token = newToken();
    await this.store.putMagic(sha256(token), account.id, Date.now() + ttlSeconds * 1000);
    return token;
  }

  async loginWithMagic(token, address = '') {
    this.throttle(address);
    const m = typeof token === 'string' ? await this.store.takeMagic(sha256(token)) : null;
    const account = m ? await this.store.getAccount(m.accountId) : null;
    if (!account) { this.byAddress.fail(address); throw new AuthError('bad-login', 'That login link has expired or was already used.'); }
    if (account.banned) throw new AuthError('banned', 'This account is banned.');
    return { account, token: await this.startSession(account) };
  }

  /** Create an account with a magic token and no password: the holder sets one, or plays on a session. */
  async createWithMagic(name, ttlSeconds = 86400) {
    if (!this.validName(name)) throw new AuthError('bad-name', 'Account names are 3 to 20 letters, digits, spaces and . _ \' -');
    const account = await this.store.createAccount({ name, hash: `disabled$${crypto.randomBytes(8).toString('hex')}` });
    return { account, magic: await this.issueMagicToken(name, ttlSeconds) };
  }

  async ban(name, reason = '') {
    const a = await this.store.findAccount(name);
    if (!a) throw new AuthError('no-such-account', `There is no account called "${name}".`);
    await this.store.updateAccount(a.id, { banned: true, banReason: reason });
    await this.store.deleteSessionsFor(a.id);
    return a;
  }

  async unban(name) {
    const a = await this.store.findAccount(name);
    if (!a) throw new AuthError('no-such-account', `There is no account called "${name}".`);
    await this.store.updateAccount(a.id, { banned: false, banReason: null });
    return a;
  }
}
