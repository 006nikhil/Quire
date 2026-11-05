// Tiny IndexedDB layer. Stores:
//   books      { id, kind, title, author, cover(Blob), format, size, addedAt, openedAt, progress, loc, pages, finished }
//   files      { id, blob }                  — the book file itself, kept apart so listing stays light
//   highlights { id, bookId, cfi, text, note, color, chapter, createdAt, sentAt, type }
//   kv         { k, v }                      — settings, Marginalia cache, auth, epub locations

const DB_NAME = 'quire';
let dbp;
function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('highlights')) {
          const s = d.createObjectStore('highlights', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId');
        }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

export const db = {
  async get(s, k) { return req((await store(s)).get(k)); },
  async all(s) { return req((await store(s)).getAll()); },
  async put(s, v) { return req((await store(s, 'readwrite')).put(v)); },
  async del(s, k) { return req((await store(s, 'readwrite')).delete(k)); },
  async byIndex(s, idx, v) { return req((await store(s)).index(idx).getAll(v)); },
  async kvGet(k, d) { const r = await this.get('kv', k); return r ? r.v : d; },
  async kvSet(k, v) { return this.put('kv', { k, v }); },
  async patch(s, k, fields) { const o = await this.get(s, k); if (!o) return; Object.assign(o, fields); await this.put(s, o); return o; },
};

// settings live in localStorage too for instant boot
const SETTINGS_KEY = 'quire.settings';
const DEFAULTS = {
  readerTheme: 'paper', font: 'newyork', fontSize: 100, lineHeight: 1.55, margin: 22, justify: true, hyphenate: true,
  comicFit: 'screen', comicDir: 'ltr', comicMode: 'page', comicSpread: true,
  lastBook: null, shelfFilter: 'all', sort: 'recent',
};
export const settings = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } })());
export function saveSettings(patch) { Object.assign(settings, patch); localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

export async function storageInfo() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: e ? e.usage : 0, quota: e ? e.quota : 0, persisted };
  } catch (e) { return { usage: 0, quota: 0, persisted: false }; }
}
