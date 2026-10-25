const DATABASE_NAME = 'rap-protein-preview-snapshots';
const DATABASE_VERSION = 1;
const STORE_NAME = 'snapshots';
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

let databasePromise;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = request.onblocked = () => resolve(null);
  });

  return databasePromise;
}

export async function readProteinPreviewSnapshot(key) {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    let blob = null;
    request.onsuccess = () => {
      const record = request.result;
      if (!record?.blob) return;
      blob = record.blob;
      store.put({ ...record, lastUsedAt: Date.now() });
    };
    transaction.oncomplete = () => resolve(blob);
    transaction.onerror = transaction.onabort = () => resolve(null);
  });
}

export async function writeProteinPreviewSnapshot(key, blob) {
  if (!blob || blob.size <= 0 || blob.size > MAX_ENTRY_BYTES) return false;
  const database = await openDatabase();
  if (!database) return false;

  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put({ key, blob, size: blob.size, lastUsedAt: Date.now() });
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
      let cachedBytes = records.reduce((total, record) => total + (record.size || 0), 0);
      let cachedEntries = records.length;
      for (const record of records) {
        if (cachedEntries <= MAX_CACHE_ENTRIES && cachedBytes <= MAX_CACHE_BYTES) break;
        store.delete(record.key);
        cachedEntries -= 1;
        cachedBytes -= record.size || 0;
      }
    };
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = transaction.onabort = () => resolve(false);
  });
}
