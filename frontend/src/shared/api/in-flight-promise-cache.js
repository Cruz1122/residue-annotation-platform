export function createInFlightPromiseCache() {
  const pending = new Map();

  function getOrCreate(key, load) {
    const normalizedKey = String(key ?? '');
    const existing = pending.get(normalizedKey);
    if (existing) return existing;

    const promise = Promise.resolve().then(load);
    pending.set(normalizedKey, promise);
    const remove = () => {
      if (pending.get(normalizedKey) === promise) pending.delete(normalizedKey);
    };
    void promise.then(remove, remove);
    return promise;
  }

  return { getOrCreate };
}
