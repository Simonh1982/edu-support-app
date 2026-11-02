// The learner's own devices only (WP-110; blueprint §10.2–10.3): a tiny key-value store in IndexedDB
// for the saved view and the edit queue (shared/offline.js). Shared computers never open it. This is
// the only file in web/ that touches IndexedDB. Errors are thrown to the caller, which logs only
// their names.
import { OFFLINE_DB } from "./shared/offline.js";

export const DEVICE_STORE = "kv";
const DB_VERSION = 1;

/**
 * Opens the store lazily. Returns { get, set, delete, clear } (all async), or null if this browser
 * has no IndexedDB, in which case the page falls back to memory.
 */
export function openDeviceStore({ name = OFFLINE_DB, idb = globalThis.indexedDB } = {}) {
  if (!idb || typeof idb.open !== "function") return null;
  let opening = null;

  function database() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = idb.open(name, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DEVICE_STORE)) db.createObjectStore(DEVICE_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("open failed"));
        request.onblocked = () => reject(new Error("blocked"));
      }).catch((err) => {
        opening = null; // try again next time
        throw err;
      });
    }
    return opening;
  }

  async function run(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, mode);
      const request = action(tx.objectStore(DEVICE_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    });
  }

  return {
    get: (key) => run("readonly", (s) => s.get(key)),
    set: async (key, value) => void (await run("readwrite", (s) => s.put(value, key))),
    delete: async (key) => void (await run("readwrite", (s) => s.delete(key))),
    clear: async () => void (await run("readwrite", (s) => s.clear())),
  };
}
