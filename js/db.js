// Persistenza locale su IndexedDB (nessun server). Store: waypoints, tracks, points (punti traccia), kv.
const DB_NAME = 'seanav';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('waypoints', { keyPath: 'id' });
      db.createObjectStore('tracks', { keyPath: 'id' });
      const pts = db.createObjectStore('points', { autoIncrement: true });
      pts.createIndex('trackId', 'trackId');
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  const result = await fn(t);
  await done;
  return result;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- generici ----
export const getAll = (store) => tx(store, 'readonly', (t) => wrap(t.objectStore(store).getAll()));
export const get = (store, key) => tx(store, 'readonly', (t) => wrap(t.objectStore(store).get(key)));
export const put = (store, value, key) =>
  tx(store, 'readwrite', (t) => wrap(key === undefined ? t.objectStore(store).put(value) : t.objectStore(store).put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', (t) => wrap(t.objectStore(store).delete(key)));

// ---- waypoint ----
export const getWaypoints = () => getAll('waypoints');
export const saveWaypoint = (w) => put('waypoints', w);
export const deleteWaypoint = (id) => del('waypoints', id);

// ---- tracce ----
export const getTracks = () => getAll('tracks');
export const saveTrack = (tr) => put('tracks', tr);

export function addPoint(trackId, p) {
  return put('points', { trackId, ...p });
}

export function getTrackPoints(trackId) {
  return tx('points', 'readonly', (t) => wrap(t.objectStore('points').index('trackId').getAll(trackId)));
}

export async function deleteTrack(trackId) {
  await tx(['tracks', 'points'], 'readwrite', async (t) => {
    t.objectStore('tracks').delete(trackId);
    const idx = t.objectStore('points').index('trackId');
    await new Promise((res, rej) => {
      const c = idx.openKeyCursor(IDBKeyRange.only(trackId));
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return res();
        t.objectStore('points').delete(cur.primaryKey);
        cur.continue();
      };
      c.onerror = () => rej(c.error);
    });
  });
}

/** Salva una traccia completa (import). */
export async function saveTrackWithPoints(track, points) {
  await tx(['tracks', 'points'], 'readwrite', (t) => {
    t.objectStore('tracks').put(track);
    for (const p of points) t.objectStore('points').put({ trackId: track.id, ...p });
  });
}

// ---- impostazioni / chiave-valore ----
export const kvGet = (k) => get('kv', k);
export const kvSet = (k, v) => put('kv', v, k);

export async function clearAll() {
  await tx(['waypoints', 'tracks', 'points', 'kv'], 'readwrite', (t) => {
    for (const s of ['waypoints', 'tracks', 'points', 'kv']) t.objectStore(s).clear();
  });
}
