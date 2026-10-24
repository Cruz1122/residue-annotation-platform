const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function defaultNow() {
  return Date.now();
}

function defaultSchedule(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function defaultCancel(timer) {
  globalThis.clearTimeout(timer);
}

function defaultRevoke(url) {
  if (!String(url ?? '').startsWith('blob:')) return;
  globalThis.URL?.revokeObjectURL?.(url);
}

/**
 * Keeps authenticated structure object URLs alive for a short, bounded period
 * after a viewer is unmounted. The source key must identify the exact published
 * structure (including an archive member when applicable).
 */
export function createStructureUrlCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  now = defaultNow,
  schedule = defaultSchedule,
  cancel = defaultCancel,
  revoke = defaultRevoke,
} = {}) {
  const entries = new Map();

  const revokeEntry = (entry) => {
    if (!entry || entry.revoked) return;
    entry.revoked = true;
    if (entry.timer !== null) cancel(entry.timer);
    if (entry.url) revoke(entry.url);
  };

  const remove = (key, entry) => {
    if (entries.get(key) !== entry) return false;
    entries.delete(key);
    revokeEntry(entry);
    return true;
  };

  const scheduleExpiry = (entry) => {
    if (entry.timer !== null || entry.refs > 0 || !Number.isFinite(ttlMs)) return;
    entry.timer = schedule(() => {
      entry.timer = null;
      if (entry.refs > 0) return;
      const age = Math.max(0, now() - entry.lastUsedAt);
      if (age >= ttlMs) remove(entry.key, entry);
      else scheduleExpiry(entry);
    }, Math.max(0, ttlMs - Math.max(0, now() - entry.lastUsedAt)));
  };

  const enforceLimit = () => {
    const limit = Math.max(1, Math.trunc(maxEntries));
    while (entries.size > limit) {
      const candidate = [...entries.values()]
        .filter((entry) => entry.refs === 0 && !entry.promise)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) break;
      remove(candidate.key, candidate);
    }
  };

  const acquire = (key, loader) => {
    const normalizedKey = String(key ?? '');
    if (!normalizedKey) {
      return {
        promise: Promise.reject(new Error('A structure cache key is required.')),
        release: () => {},
      };
    }

    let entry = entries.get(normalizedKey);
    if (!entry) {
      entry = {
        key: normalizedKey,
        url: '',
        promise: null,
        refs: 0,
        lastUsedAt: now(),
        timer: null,
        revoked: false,
      };
      entry.promise = Promise.resolve()
        .then(() => loader())
        .then((url) => {
          if (!url) throw new Error('The structure loader returned an empty URL.');
          if (entry.revoked) {
            revoke(url);
            throw new Error('The structure cache entry was cleared while loading.');
          }
          entry.url = String(url);
          entry.promise = null;
          entry.lastUsedAt = now();
          enforceLimit();
          scheduleExpiry(entry);
          return entry.url;
        })
        .catch((error) => {
          entry.promise = null;
          remove(normalizedKey, entry);
          throw error;
        });
      entries.set(normalizedKey, entry);
      enforceLimit();
    }

    if (entry.timer !== null) {
      cancel(entry.timer);
      entry.timer = null;
    }
    entry.refs += 1;
    entry.lastUsedAt = now();
    let released = false;
    return {
      promise: entry.url ? Promise.resolve(entry.url) : entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUsedAt = now();
        scheduleExpiry(entry);
        enforceLimit();
      },
    };
  };

  const clear = () => {
    for (const [key, entry] of entries) remove(key, entry);
  };

  const snapshot = () => [...entries.values()].map((entry) => ({
    key: entry.key,
    url: entry.url,
    refs: entry.refs,
    pending: Boolean(entry.promise),
  }));

  return { acquire, clear, snapshot };
}

export const structureUrlCache = createStructureUrlCache();

export function acquireStructureUrl(key, loader) {
  return structureUrlCache.acquire(key, loader);
}

export function clearStructureUrlCache() {
  structureUrlCache.clear();
}
