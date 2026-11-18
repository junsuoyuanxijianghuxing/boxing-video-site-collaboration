import { randomBytes, toBase64Url } from './shared/util.mjs';
import { readCapped } from './shared/read-bytes.mjs';

const CONFIG_OBJECT = 'config/runtime.keys';
const MAX_CONFIG_BYTES = 8192;
// How stale the admin list may get once an owner exists. Key material is never re-read.
const OWNER_REFRESH_MS = 60 * 1000;

// The Sites Secret input surface is not available in every client build, and the
// storage upload tool refuses credential files by design. So the Function creates
// its own key material on first use and keeps it in the site's private bucket,
// which the anonymous database role cannot read.
export class RuntimeKeys {
  constructor(storage, env) {
    this.storage = storage;
    this.env = env;
    this.value = null;
    this.loading = null;
    this.readAt = 0;
  }

  fromEnv(name) {
    const value = typeof this.env === 'function' ? this.env(name) : undefined;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  // A storage hiccup must never surface as a failed login: unresolved key material
  // degrades to "not ready", which the caller answers with a stable 503 code.
  async load() {
    if (this.value?.appDataKey) {
      // The key material never changes, but the owner slot can be claimed by a *different*
      // instance after this one cached the list — and then every request that lands here
      // serves the owner as a plain viewer, which reads as "管理员权限老掉". Re-read the
      // list: every request until an owner exists, then at most once a minute.
      const ttl = this.value.adminEmails.length ? OWNER_REFRESH_MS : 0;
      if (Date.now() - this.readAt >= ttl) await this.#syncOwners();
      return this.value;
    }
    if (!this.loading) {
      this.loading = this.#read().catch(() => null).then((loaded) => {
        this.loading = null;
        if (loaded?.appDataKey) { this.value = loaded; this.readAt = Date.now(); }
        return loaded ?? blank();
      });
    }
    return this.loading;
  }

  // A failed read keeps whatever is cached; a config object whose data key differs from the
  // cached one is ignored, because swapping keys would silently undecrypt every video.
  async #syncOwners() {
    this.readAt = Date.now();
    const stored = await this.#download();
    if (!stored || !isValidKey(stored.appDataKey) || stored.appDataKey !== this.value.appDataKey) return;
    this.value.adminEmails = parseEmails(stored.adminEmails);
  }

  async #read() {
    const appDataKey = this.fromEnv('APP_DATA_KEY');
    const sessionSecret = this.fromEnv('SESSION_SECRET');
    const stored = await this.#download();
    const storedUsable = isValidKey(stored?.appDataKey) && isValidKey(stored?.sessionSecret) && stored.appDataKey !== stored.sessionSecret;

    // Existing videos and password hashes were wrapped with the key the site has
    // actually been serving. If a Secret is later added with a different value,
    // preferring it would silently make all of that undecryptable, so a mismatch
    // refuses to start instead of guessing. A 503 is visible and reversible;
    // decrypting with the wrong key destroys access quietly.
    if (appDataKey && storedUsable && appDataKey !== stored.appDataKey) {
      console.error('runtime key conflict: APP_DATA_KEY from the environment differs from config/runtime.keys');
      return null;
    }
    if (appDataKey && sessionSecret && appDataKey !== sessionSecret && (!storedUsable || appDataKey === stored.appDataKey)) {
      return {
        appDataKey,
        sessionSecret: storedUsable ? stored.sessionSecret : sessionSecret,
        adminEmails: parseEmails(storedUsable ? stored.adminEmails : this.fromEnv('ADMIN_EMAILS')),
        source: 'env',
      };
    }
    if (storedUsable) {
      return { ...stored, adminEmails: parseEmails(stored.adminEmails), source: 'storage' };
    }
    return this.#create();
  }

  async #download() {
    if (!this.storage) return null;
    try {
      const object = await this.storage.download(CONFIG_OBJECT);
      const bytes = await readCapped(object, MAX_CONFIG_BYTES, { timeoutMs: 5000 });
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  // upsert:false makes a concurrent second writer fail, so every isolate ends up
  // reading the same object instead of inventing different keys. Keys that cannot
  // be persisted are refused: a key that dies with the isolate would leave already
  // wrapped videos undecryptable.
  async #create() {
    if (!this.storage) return null;
    const candidate = {
      version: 1,
      createdAt: new Date().toISOString(),
      appDataKey: toBase64Url(randomBytes(32)),
      sessionSecret: toBase64Url(randomBytes(32)),
      adminEmails: parseEmails(this.fromEnv('ADMIN_EMAILS')),
    };
    try {
      await this.storage.upload(CONFIG_OBJECT, new TextEncoder().encode(JSON.stringify(candidate)), {
        contentType: 'application/octet-stream', upsert: false,
      });
    } catch {
      return await this.#download() ?? null;
    }
    const confirmed = await this.#download();
    if (!confirmed || confirmed.appDataKey !== candidate.appDataKey) return null;
    return { ...candidate, adminEmails: parseEmails(confirmed.adminEmails), source: 'storage' };
  }

  async save() {
    if (!this.storage || !this.value || this.value.source === 'env') return false;
    const { appDataKey, sessionSecret, adminEmails, createdAt, version } = this.value;
    try {
      await this.storage.upload(CONFIG_OBJECT, new TextEncoder().encode(JSON.stringify({
        version: version ?? 1, createdAt, appDataKey, sessionSecret, adminEmails,
      })), { contentType: 'application/octet-stream', upsert: true });
      return true;
    } catch {
      return false;
    }
  }

  // The owner slot is claimed by the first authenticated account while it is empty,
  // then locked. It lives in the private bucket, not in a table, so a direct
  // database write cannot grant administration.
  async claimOwner(email) {
    try {
      const current = await this.load();
      if (!current.appDataKey || current.adminEmails.length > 0) return false;
      const normalized = String(email ?? '').toLowerCase();
      if (!normalized) return false;
      current.adminEmails = [normalized];
      if (!await this.save()) {
        current.adminEmails = [];
        return false;
      }
      const owners = parseEmails((await this.#download())?.adminEmails);
      if (owners.length === 0) return false;
      current.adminEmails = owners;
      return owners.includes(normalized);
    } catch {
      // Ownership bookkeeping is never a reason a viewer cannot get in.
      return false;
    }
  }

  // The admin list is the only part of the config object that is allowed to change after
  // the site exists; the key material must never move. A failed write rolls the cached
  // list back, so an instance never believes it granted a right the bucket does not hold.
  async setAdminEmails(emails) {
    const list = parseEmails(emails);
    if (!list.length || !this.value?.appDataKey) return false;
    if (this.value.source === 'env') return false;
    const previous = this.value.adminEmails;
    this.value.adminEmails = list;
    if (await this.save()) { this.readAt = Date.now(); return true; }
    this.value.adminEmails = previous;
    return false;
  }

  async adminEmails() {
    const current = await this.load();
    return current.adminEmails;
  }

  async isPrivileged(email) {
    const current = await this.load();
    if (!current.appDataKey) return false;
    return current.adminEmails.includes(String(email ?? '').toLowerCase());
  }
}

function blank() {
  return { appDataKey: null, sessionSecret: null, adminEmails: [], source: 'unavailable' };
}

function isValidKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function parseEmails(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((item) => /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(item)))];
}

export function assertSignablePath(path) {
  const value = String(path ?? '');
  if (value === CONFIG_OBJECT || value.startsWith('config/')) throw new Error('config object is not signable');
  return value;
}

export { CONFIG_OBJECT };
