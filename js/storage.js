// Small storage helpers.
// - localStorage: tokens and small settings (JSON-encoded).
// - IndexedDB database "karaokry", store "kv": lyrics cache and the saved game.
// Every read and write is wrapped so a blocked or full storage never breaks the
// current session. When IndexedDB is missing, values live in memory instead.

const DB_NAME = 'karaokry';
const STORE = 'kv';

const memory = new Map();
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function committed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function prefixRange(prefix) {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

export async function kvGet(key) {
  const db = await openDb();
  if (db) {
    try {
      const value = await done(db.transaction(STORE).objectStore(STORE).get(key));
      if (value !== undefined) return value;
    } catch {
      // fall through to memory
    }
  }
  return memory.get(key);
}

export async function kvSet(key, value) {
  const db = await openDb();
  if (db) {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      await committed(tx);
      memory.delete(key);
      return true;
    } catch {
      // storage full or blocked: keep it for this session only
    }
  }
  memory.set(key, value);
  return false;
}

// Deletes clear the memory copy only after awaiting the database, so a write that
// was started earlier always lands first and never reappears after the delete.
export async function kvDelete(key) {
  const db = await openDb();
  memory.delete(key);
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await committed(tx);
  } catch {
    // ignore
  }
}

export async function kvCount(prefix) {
  let count = 0;
  for (const key of memory.keys()) if (key.startsWith(prefix)) count++;
  const db = await openDb();
  if (!db) return count;
  try {
    return count + (await done(db.transaction(STORE).objectStore(STORE).count(prefixRange(prefix))));
  } catch {
    return count;
  }
}

export async function kvDeletePrefix(prefix) {
  const db = await openDb();
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(prefixRange(prefix));
    await committed(tx);
  } catch {
    // ignore
  }
}

export function lsGet(key, fallback = null) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function lsRemove(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}
