/*
 * juhyeonDS - save data kept in this browser (IndexedDB) and user settings (localStorage).
 * Licensed under the GNU General Public License v3 or later.
 */

const DB_NAME = 'juhyeonds';
const STORE = 'saves';
const FILES = 'files'; // small system files such as user-supplied BIOS images
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('이 브라우저는 저장소(IndexedDB)를 지원하지 않습니다'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('저장소를 열 수 없습니다'));
    req.onblocked = () => reject(new Error('저장소가 다른 탭에서 사용 중입니다'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run(mode, fn, storeName) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName || STORE, mode);
        const req = fn(tx.objectStore(storeName || STORE));
        let result;
        if (req) req.onsuccess = () => (result = req.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('저장이 취소되었습니다'));
      })
  );
}

/** @returns {Promise<{id, name, title, data: Uint8Array, updated: number}|undefined>} */
export function getSave(id) {
  return run('readonly', (store) => store.get(id));
}

export function putSave(id, name, title, data) {
  return run('readwrite', (store) => store.put({ id, name, title, data, updated: Date.now() }));
}

export function deleteSave(id) {
  return run('readwrite', (store) => store.delete(id));
}

export function listSaves() {
  return run('readonly', (store) => store.getAll()).then((rows) =>
    (rows || []).sort((a, b) => b.updated - a.updated)
  );
}

/** @returns {Promise<{arm9: Uint8Array, arm7: Uint8Array}|null>} */
export function getBios() {
  return run('readonly', (store) => store.get('bios'), FILES).then((row) =>
    row && row.arm9 && row.arm7 ? { arm9: row.arm9, arm7: row.arm7 } : null
  );
}

export function putBios(arm9, arm7) {
  return run('readwrite', (store) => store.put({ id: 'bios', arm9, arm7 }), FILES);
}

export function deleteBios() {
  return run('readwrite', (store) => store.delete('bios'), FILES);
}

/** Asks the browser not to evict our data when storage runs low. Best effort. */
export function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

// ------------------------------------------------------------ settings
const SETTINGS_KEY = 'juhyeonds.settings';
const DEFAULTS = {
  vpad: 'auto',
  layout: 'auto',
  filter: 'pixel',
  volume: 100,
  language: 1,
  streamDivider: 1,
  showFps: false,
  driveAutoSync: false,
  mode: 'local',
  googleClientId: '',
};

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return Object.assign({}, DEFAULTS, raw);
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    /* private mode or storage disabled: settings just won't persist */
  }
}
