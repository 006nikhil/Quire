import { $, $$, h, icon, esc, uid, toast, openSheet, confirmSheet, needEpub, makeCover, shrinkImage, blobUrl, packCover, forgetUrl, plural, fmtBytes, relTime, saveFile, closeAllSheets, topSheet } from './util.js';
import { db, settings, saveSettings, storageInfo } from './db.js';
import { formatOf, sniffFormat, openSource } from './source.js';
import { renderMarginalia, resetMarginalia, marginalia, openSignIn, openSendSheet } from './marginalia.js';

const APP_VERSION = 9;
const pages = { library: $('#page-library'), marginalia: $('#page-marginalia'), convert: $('#page-convert') };
let tab = 'library';

/* ───────────────────────────── navigation ───────────────────────────── */
function show(name) {
  if (name === tab && name === 'marginalia') { resetMarginalia(); }
  tab = name;
  Object.entries(pages).forEach(([k, p]) => { p.hidden = k !== name; });
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name));
  const p = pages[name];
  p.classList.remove('enter'); void p.offsetWidth; p.classList.add('enter');
  if (name === 'library') renderLibrary();
  if (name === 'marginalia') renderMarginalia(p);
  if (name === 'convert') renderConvert();
  history.replaceState(null, '', '#' + name);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => { if (t.dataset.tab === tab) pages[tab].scrollTo({ top: 0, behavior: 'smooth' }); show(t.dataset.tab); }));

/* ───────────────────────────── importing ───────────────────────────── */
async function importFiles(files) {
  files = [...files]; if (!files.length) return;
  let added = 0, lastId = null;
  for (const f of files) {
    const fmt = formatOf(f.name) || await sniffFormat(f);
    if (!fmt) { toast(`${f.name} isn’t a format Quire can read`); await new Promise((r) => setTimeout(r, 1500)); continue; }
    toast(files.length > 1 ? `Adding ${added + 1} of ${files.length}: ${f.name}` : `Adding ${f.name}`, 60000);
    try {
      let rec;
      if (fmt === 'doc') {
        const { convertToEpub } = await import('./convert.js');
        const r = await convertToEpub(f);
        rec = await addEpub(new File([r.blob], r.name, { type: 'application/epub+zip' }), { converted: f.name.split('.').pop().toUpperCase() });
      } else if (fmt === 'epub') rec = await addEpub(f);
      else rec = await addPaged(f, fmt);
      added++; lastId = rec.id;
    } catch (e) { console.error(e); toast(`${f.name}: ${e.message || 'could not be added'}`, 5000); await new Promise((r) => setTimeout(r, 1800)); }
  }
  if (added) toast(added === 1 ? 'Added to your library' : `${added} added to your library`);
  if (tab === 'library') renderLibrary();
  return lastId;
}

async function addEpub(file, extra = {}) {
  const ePub = await needEpub();
  const book = ePub(await file.arrayBuffer());
  let meta = {}, cover = null;
  try {
    await book.ready;
    meta = await book.loaded.metadata;
    const cu = await book.coverUrl();
    if (cu) cover = await shrinkImage(await (await fetch(cu)).blob(), 600);
  } catch (e) { console.warn(e); }
  const title = (meta.title || file.name.replace(/\.epub$/i, '')).trim();
  const author = (meta.creator || '').trim();
  try { book.destroy(); } catch (e) {}
  if (!cover) cover = await makeCover({ title, author, seed: title });
  cover = await packCover(cover);
  const rec = { id: uid(), kind: 'book', format: 'epub', title, author, cover, size: file.size, fileName: file.name, addedAt: Date.now(), openedAt: 0, progress: 0, loc: null, ...extra };
  await saveFileRecord(rec, file);
  await db.put('books', rec);
  return rec;
}

async function saveFileRecord(rec, file) {
  try { await db.put('files', { id: rec.id, blob: file }); }
  catch (e) {
    const st = await storageInfo();
    const free = st.quota ? st.quota - st.usage : 0;
    if (e && (e.name === 'QuotaExceededError' || /quota|space|storage/i.test(e.message || '')))
      throw new Error(`Not enough space to store it (${fmtBytes(file.size)} needed${free ? `, ${fmtBytes(free)} available to Quire` : ''}).`);
    throw new Error(`It could not be saved on this device (${e?.name || 'unknown error'}).`);
  }
  const back = await db.get('files', rec.id);
  if (!back || !back.blob) throw new Error('It could not be saved on this device.');
}

async function addPaged(file, fmt) {
  const src = await openSource(file, fmt, file.name);
  let cover = null;
  try { cover = await shrinkImage(await src.page(0), 600); } catch (e) {}
  const count = src.count; src.close();
  const title = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cover) cover = await makeCover({ title, seed: title, kind: 'comic' });
  cover = await packCover(cover);
  const rec = { id: uid(), kind: fmt === 'pdf' ? 'pdf' : 'comic', format: fmt, title, author: '', cover, size: file.size, fileName: file.name, addedAt: Date.now(), openedAt: 0, progress: 0, loc: 0, pages: count };
  if (file.size > 150 * 1024 * 1024) toast(`Saving ${title} on this iPhone. Large comics take a moment.`, 60000);
  await saveFileRecord(rec, file);
  await db.put('books', rec);
  return rec;
}

const fileIn = $('#file-in');
fileIn.addEventListener('change', async () => { const fs = [...fileIn.files]; fileIn.value = ''; if (fileIn._handler) { const fn = fileIn._handler; fileIn._handler = null; fn(fs); } else importFiles(fs); });
// iOS only lets you pick file types the page names. With no list it offers documents and images
// but greys out archives like .cbz. "application/octet-stream" maps to "any data file" on iOS,
// which makes every file selectable; Quire then works out what each file really is.
const ACCEPT = '.epub,.cbz,.cbr,.cb7,.cbt,.zip,.rar,.7z,.tar,.pdf,.txt,.md,.markdown,.html,.htm,.xhtml,.docx,.rtf,.fb2,application/octet-stream,application/zip,application/x-zip-compressed,application/x-cbz,application/vnd.comicbook+zip,application/x-cbr,application/vnd.comicbook-rar,application/x-rar-compressed,application/vnd.rar,application/x-7z-compressed,application/x-tar,application/epub+zip,application/pdf,text/*,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function pickFiles(handler) { fileIn._handler = handler || null; fileIn.setAttribute('accept', ACCEPT); fileIn.click(); }

// drag and drop anywhere
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dropping'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping'); if (e.dataTransfer.files.length) { if (tab === 'convert') convertMany([...e.dataTransfer.files]); else importFiles(e.dataTransfer.files); } });

/* ───────────────────────────── opening ───────────────────────────── */
async function openBook(id) {
  const rec = await db.get('books', id); if (!rec) return;
  const onClose = () => { if (tab === 'library') renderLibrary(); };
  if (rec.format === 'epub') { const { openEpub } = await import('./reader.js'); openEpub(rec, { onClose }); }
  else { const { openComic } = await import('./comic.js'); openComic(rec, { onClose }); }
}

/* ───────────────────────────── library ───────────────────────────── */
function bookHtml(b, thick) {
  return `<div class="book ${thick ? 'thick' : ''}"><div class="cover">${b.cover ? `<img src="${blobUrl(b.id, b.cover)}" alt="" decoding="async" data-cover="${b.id}">` : ''}</div></div>`;
}
function statusFor(b) {
  if (b.finished || b.progress >= 0.995) return 'Finished';
  if (!b.openedAt) return 'New';
  return Math.max(1, Math.round((b.progress || 0) * 100)) + '%';
}

/* Rebuild a cover from the book file itself (used when a stored cover is unreadable). */
const repairing = new Set();
async function repairCover(id) {
  if (repairing.has(id)) return; repairing.add(id);
  try {
    const b = await db.get('books', id); const f = await db.get('files', id);
    if (!b) return;
    let cover = null;
    if (f) {
      try {
        if (b.format === 'epub') {
          const ePub = await needEpub(); const book = ePub(await f.blob.arrayBuffer());
          await book.ready; const cu = await book.coverUrl();
          if (cu) cover = await shrinkImage(await (await fetch(cu)).blob(), 600);
          try { book.destroy(); } catch (e) {}
        } else {
          const src = await openSource(f.blob, b.format, b.fileName); cover = await shrinkImage(await src.page(0), 600); src.close();
        }
      } catch (e) { console.warn('cover rebuild', e); }
    }
    if (!cover) cover = await makeCover({ title: b.title, author: b.author, seed: b.title, kind: b.kind === 'book' ? 'book' : 'comic' });
    const fresh = await db.get('books', id);
    fresh.cover = await packCover(cover);
    await db.put('books', fresh);
    forgetUrl(id);
    const url = blobUrl(id, fresh.cover);
    $$(`img[data-cover="${id}"]`).forEach((im) => { im.src = url; });
  } finally { repairing.delete(id); }
}
// Covers saved by earlier versions were Blobs; convert them once, or rebuild them if already damaged.
async function migrateCovers(books) {
  for (const b of books) {
    if (!(b.cover instanceof Blob)) continue;
    let packed = null;
    try { packed = await packCover(b.cover); if (!packed.buf.byteLength) packed = null; } catch (e) { packed = null; }
    if (packed) { const fresh = await db.get('books', b.id); fresh.cover = packed; await db.put('books', fresh); b.cover = packed; }
    else await repairCover(b.id);
  }
}
document.addEventListener('error', (e) => { const id = e.target?.dataset?.cover; if (id) repairCover(id); }, true);

async function renderLibrary() {
  const page = pages.library;
  let books = await db.all('books');
  if (books.some((b) => b.cover instanceof Blob)) { await migrateCovers(books); books = await db.all('books'); }
  const filter = settings.shelfFilter;
  const shown = books.filter((b) => filter === 'all' || (filter === 'books' ? b.kind === 'book' : b.kind !== 'book'));
  const sorters = { recent: (a, b) => Math.max(b.openedAt, b.addedAt) - Math.max(a.openedAt, a.addedAt), title: (a, b) => a.title.localeCompare(b.title), added: (a, b) => b.addedAt - a.addedAt };
  shown.sort(sorters[settings.sort] || sorters.recent);
  const hero = books.filter((b) => b.openedAt && !(b.finished || b.progress >= 0.995)).sort((a, b) => b.openedAt - a.openedAt)[0];
  const hasComics = books.some((b) => b.kind !== 'book'), hasBooks = books.some((b) => b.kind === 'book');

  page.innerHTML = `
    <div class="head">
      <div><h1>Library</h1><div class="sub">${books.length ? `${plural(books.filter((b) => b.kind === 'book').length, 'book')}, ${plural(books.filter((b) => b.kind !== 'book').length, 'comic')}` : 'Nothing on the shelves yet'}</div></div>
      <div class="head-actions">
        <button class="icon-btn" data-l="settings" aria-label="Settings">${icon('gear')}</button>
        <button class="icon-btn" data-l="add" aria-label="Add books or comics">${icon('plus')}</button>
      </div>
    </div>
    ${hero ? `<div class="hero">
      <button data-open="${hero.id}" aria-label="Continue ${esc(hero.title)}">${bookHtml(hero, true)}</button>
      <div class="hero-meta"><div class="label">${hero.kind === 'book' ? 'Continue reading' : 'Pick up where you left off'}</div><h2>${esc(hero.title)}</h2>
        ${hero.author ? `<div class="author">${esc(hero.author)}</div>` : '<div class="author"></div>'}
        <div class="meter-row"><div class="meter"><i style="width:${Math.round((hero.progress || 0) * 100)}%"></i></div><span>${hero.kind !== 'book' && hero.pages ? `Page ${(+hero.loc || 0) + 1} of ${hero.pages}` : Math.round((hero.progress || 0) * 100) + '%'}</span></div>
        <button class="btn" data-open="${hero.id}">Continue</button></div></div>` : ''}
    ${books.length ? `<div class="shelf-bar">
      ${hasBooks && hasComics ? `<div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['books', 'Books'], ['comics', 'Comics']].map(([k, l]) => `<button data-filter="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>` : '<span></span>'}
      <button class="btn quiet" data-l="sort" style="height:34px;font-size:14px">${{ recent: 'Recent', title: 'Title', added: 'Date added' }[settings.sort]}</button>
    </div>
    <div class="grid">${shown.map((b) => `<button class="tile" data-open="${b.id}" data-id="${b.id}">
        <div style="position:relative">${bookHtml(b)}${(() => { const s = statusFor(b); return s === 'New' ? '<span class="badge">New</span>' : s === 'Finished' ? '<span class="badge done">Finished</span>' : ''; })()}</div>
        <div class="t">${esc(b.title)}</div>
        ${b.author ? `<div class="a">${esc(b.author)}</div>` : ''}
        ${b.openedAt && !(b.finished || b.progress >= 0.995) ? `<div class="meter"><i style="width:${Math.max(2, Math.round((b.progress || 0) * 100))}%"></i></div>` : ''}
      </button>`).join('')}</div>`
    : `<div class="empty">
        <div class="art">${emptyArt()}</div>
        <h2>Your shelves are empty</h2>
        <p>Add EPUBs, comics (CBZ, CBR, CB7), PDFs, or any document: Word, text, Markdown, web pages. Documents become EPUBs as they come in.</p>
        <button class="btn" data-l="add">${icon('plus')} Add files</button>
      </div>`}`;
}

function emptyArt() {
  const cols = ['#7A2E2A', '#2E4A6B', '#2F5B45', '#8A5A1E', '#5B3A62'];
  const hs = [120, 138, 112, 130, 104]; const ws = [22, 28, 20, 26, 22];
  let x = 6;
  return `<svg viewBox="0 0 150 150" aria-hidden="true">${hs.map((hh, i) => { const r = `<rect x="${x}" y="${142 - hh}" width="${ws[i]}" height="${hh}" rx="2" fill="${cols[i]}"/><line x1="${x + 3}" x2="${x + ws[i] - 3}" y1="${150 - hh}" y2="${150 - hh}" stroke="#F0D896" stroke-opacity=".6"/>`; x += ws[i] + 3; return r; }).join('')}<rect x="0" y="142" width="150" height="3" rx="1.5" fill="currentColor" opacity=".25"/></svg>`;
}

// tap vs long-press on tiles
(() => {
  const page = pages.library; let timer = null, pressed = null, longFired = false, sx = 0, sy = 0;
  page.addEventListener('touchstart', (e) => {
    const t = e.target.closest('.tile'); if (!t) return;
    pressed = t; longFired = false; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    timer = setTimeout(() => { longFired = true; navigator.vibrate && navigator.vibrate(12); bookMenu(t.dataset.id); }, 480);
  }, { passive: true });
  page.addEventListener('touchmove', (e) => { if (timer && (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8)) { clearTimeout(timer); timer = null; } }, { passive: true });
  page.addEventListener('touchend', () => { clearTimeout(timer); timer = null; });
  page.addEventListener('contextmenu', (e) => { const t = e.target.closest('.tile'); if (!t) return; e.preventDefault(); if (!longFired) bookMenu(t.dataset.id); });
  page.addEventListener('click', (e) => {
    if (longFired) { longFired = false; e.preventDefault(); return; }
    const o = e.target.closest('[data-open]'); if (o) return openBook(o.dataset.open);
    const f = e.target.closest('[data-filter]'); if (f) { saveSettings({ shelfFilter: f.dataset.filter }); return renderLibrary(); }
    const a = e.target.closest('[data-l]')?.dataset.l;
    if (a === 'add') pickFiles();
    if (a === 'settings') settingsSheet();
    if (a === 'sort') { const order = ['recent', 'title', 'added']; saveSettings({ sort: order[(order.indexOf(settings.sort) + 1) % 3] }); renderLibrary(); }
    void pressed;
  });
})();

async function bookMenu(id) {
  const b = await db.get('books', id); if (!b) return;
  const hls = (await db.byIndex('highlights', 'bookId', id)).filter((x) => x.type !== 'bookmark');
  const typeLabel = { epub: 'EPUB', zip: 'CBZ comic', rar: 'CBR comic', '7z': 'CB7 comic', tar: 'CBT comic', pdf: 'PDF' }[b.format] || b.format;
  const s = openSheet(`
    <div style="display:grid;grid-template-columns:64px 1fr;gap:16px;align-items:center;margin-bottom:18px">${bookHtml(b)}
      <div><h3 style="margin:0 0 4px;font-size:19px;line-height:1.2">${esc(b.title)}</h3><div style="color:var(--muted);font-size:14px">${[b.author, typeLabel + (b.converted ? ` (from ${b.converted})` : ''), fmtBytes(b.size || 0), b.pages ? plural(b.pages, 'page') : null].filter(Boolean).map(esc).join(', ')}</div>
      <div style="color:var(--muted);font-size:13px;margin-top:4px">Added ${relTime(b.addedAt)}${b.openedAt ? `, last read ${relTime(b.openedAt)}` : ''}</div></div></div>
    <div class="group">
      <button class="row" data-m="open">${icon('library')}<span class="grow">${b.openedAt ? 'Continue' : 'Start reading'}</span></button>
      <button class="row" data-m="edit">${icon('pen')}<span class="grow">Edit title and author</span></button>
      <button class="row" data-m="finish">${icon('check')}<span class="grow">${b.finished ? 'Mark as unread' : 'Mark as finished'}</span></button>
      ${b.format === 'epub' ? `<button class="row" data-m="send">${icon('send')}<span class="grow">Send highlights to Marginalia</span><span class="v">${hls.length}</span></button>` : ''}
      <button class="row" data-m="save">${icon('download')}<span class="grow">Save a copy of the file</span></button>
    </div>
    <div class="group"><button class="row danger" data-m="delete">${icon('trash')}<span class="grow">Remove from library</span></button></div>`);
  s.el.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return;
    if (m === 'open') { s.close(); openBook(id); }
    if (m === 'edit') { s.close(); editDetails(b); }
    if (m === 'finish') { await db.patch('books', id, b.finished ? { finished: false, progress: 0, loc: b.format === 'epub' ? null : 0, openedAt: 0 } : { finished: true, progress: 1 }); s.close(); renderLibrary(); }
    if (m === 'send') { s.close(); openSendSheet(b); }
    if (m === 'save') { const f = await db.get('files', id); s.close(); if (f) saveFile(f.blob, b.fileName || `${b.title}.${b.format === 'zip' ? 'cbz' : b.format}`); }
    if (m === 'delete') {
      s.close();
      const unsent = hls.filter((x) => !x.sentAt).length;
      const ok = await confirmSheet({ title: `Remove “${b.title}”?`, body: unsent ? `This also deletes ${plural(unsent, 'highlight')} you haven’t sent to Marginalia.` : 'The file is deleted from this device. Anything already in Marginalia stays there.', ok: 'Remove', danger: true });
      if (!ok) return;
      await db.del('books', id); await db.del('files', id); await db.kvSet('loc:' + id, null);
      for (const x of await db.byIndex('highlights', 'bookId', id)) await db.del('highlights', x.id);
      if (settings.lastBook === id) saveSettings({ lastBook: null });
      toast('Removed'); renderLibrary();
    }
  });
}

function editDetails(b) {
  const s = openSheet(`<h3>Edit details</h3><form>
    <label class="field"><span>Title</span><input class="input" name="t" value="${esc(b.title)}" required></label>
    <label class="field"><span>Author</span><input class="input" name="a" value="${esc(b.author || '')}"></label>
    <div class="actions"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn" type="submit">Save</button></div></form>`);
  $('[data-x]', s.el).onclick = () => s.close();
  $('form', s.el).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    const patch = { title: f.t.value.trim() || b.title, author: f.a.value.trim() };
    await db.patch('books', b.id, patch); s.close(); toast('Saved'); renderLibrary();
  });
}

/* ───────────────────────────── settings ───────────────────────────── */
async function settingsSheet() {
  const st = await storageInfo();
  const signed = await marginalia.signedIn();
  const pref = (() => { try { return JSON.parse(localStorage.getItem('quire.theme') || '"system"'); } catch (e) { return 'system'; } })();
  const s = openSheet(`<h3>Settings</h3>
    <p class="glabel">Appearance</p>
    <div class="seg" style="margin-bottom:6px">${[['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-theme="${k}" aria-pressed="${pref === k}">${l}</button>`).join('')}</div>
    <p class="glabel">Marginalia</p>
    <div class="group">
      ${signed ? `<div class="row"><span class="grow">Signed in</span><span class="v">${esc(signed.email)}</span></div><button class="row" data-s="signout"><span class="grow">Sign out</span></button>`
        : `<button class="row" data-s="signin"><span class="grow">Sign in to send highlights</span>${icon('back', 'i" style="transform:rotate(180deg)')}</button>`}
      <button class="row" data-s="refresh"><span class="grow">Refresh highlights</span>${icon('refresh')}</button>
    </div>
    <p class="glabel">Your data</p>
    <div class="group">
      <button class="row" data-s="export"><span class="grow">Export Quire highlights (JSON)</span>${icon('download')}</button>
      <div class="row"><span class="grow">Storage used</span><span class="v">${fmtBytes(st.usage || 0)}</span></div>
      <div class="row"><span class="grow">Protected from clean-up</span><span class="v">${st.persisted ? 'Yes' : 'Ask again on next launch'}</span></div>
    </div>
    <p class="glabel">About</p>
    <div class="group">
      <div class="row"><span class="grow">Quire version</span><span class="v">${APP_VERSION}</span></div>
      <button class="row" data-s="update"><span class="grow">Update now</span>${icon('refresh')}</button>
    </div>
    <p style="color:var(--muted);font-size:13px;line-height:1.5;margin:14px 4px 0">Books and comics live only on this device. Add Quire to your Home Screen from Safari’s share menu so iOS keeps them safe and it opens full screen.</p>`);
  s.el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-theme]');
    if (t) {
      localStorage.setItem('quire.theme', JSON.stringify(t.dataset.theme));
      if (t.dataset.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t.dataset.theme;
      $$('[data-theme]', s.el).forEach((b) => b.setAttribute('aria-pressed', b === t));
    }
    const a = e.target.closest('[data-s]')?.dataset.s;
    if (a === 'signin') { s.close(); openSignIn({ then: settingsSheet }); }
    if (a === 'signout') { await marginalia.signOut(); s.close(); toast('Signed out'); }
    if (a === 'update') {
      // fetch fresh app files; books, comics and highlights live in IndexedDB and are untouched
      toast('Updating Quire', 6000);
      try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) await reg.update(); } catch (err) {}
      try { const ks = await caches.keys(); await Promise.all(ks.filter((k) => k.startsWith('quire-v')).map((k) => caches.delete(k))); } catch (err) {}
      setTimeout(() => location.reload(), 600);
    }
    if (a === 'refresh') { toast('Refreshing'); const ok = await marginalia.refreshInBackground(); toast(ok ? 'Highlights up to date' : 'Marginalia is unreachable'); }
    if (a === 'export') {
      const books = await db.all('books'); const hls = await db.all('highlights');
      const out = books.map((b) => ({ title: b.title, author: b.author, highlights: hls.filter((x) => x.bookId === b.id && x.type !== 'bookmark').map(({ text, note, color, chapter, createdAt, percent }) => ({ text, note, color, chapter, createdAt: new Date(createdAt).toISOString(), percent })) })).filter((b) => b.highlights.length);
      saveFile(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `quire-highlights-${new Date().toISOString().slice(0, 10)}.json`);
    }
  });
}

/* ───────────────────────────── convert ───────────────────────────── */
const jobs = [];
function renderConvert() {
  const page = pages.convert;
  page.innerHTML = `
    <div class="head"><div><h1>Convert</h1><div class="sub">Turn any document into a clean EPUB</div></div></div>
    <div class="drop">
      <div class="glyph">${icon('convert')}</div>
      <h2>Choose documents</h2>
      <p>Each one becomes an EPUB with chapters, a contents page and a cover. Save it, or read it here.</p>
      <button class="btn" data-c="pick">${icon('plus')} Choose files</button>
    </div>
    <div class="conv-jobs"></div>
    <div class="section-title">What converts</div>
    <div class="formats" style="margin-top:12px">
      <div><b>Word</b>.docx, with images</div>
      <div><b>PDF</b>text PDFs, headers stripped</div>
      <div><b>Text</b>.txt, chapters detected</div>
      <div><b>Markdown</b>.md</div>
      <div><b>Web pages</b>.html, .htm</div>
      <div><b>Ebooks</b>.fb2, .rtf</div>
    </div>
    <div class="notice" style="margin-top:22px">${icon('info')}<div>Scanned PDFs have no text to extract. Add those to your library instead and they open in the page reader, like a comic.</div></div>`;
  drawJobs();
  page.onclick = async (e) => {
    const a = e.target.closest('[data-c]')?.dataset.c;
    if (a === 'pick') pickFiles((fs) => convertMany(fs));
    const j = jobs.find((x) => x.id === e.target.closest('[data-job]')?.dataset.job); if (!j) return;
    if (a === 'save') saveFile(j.result.blob, j.result.name);
    if (a === 'add') {
      const rec = await addEpub(new File([j.result.blob], j.result.name, { type: 'application/epub+zip' }), { converted: j.ext });
      j.added = rec.id; drawJobs(); toast('Added to your library');
    }
    if (a === 'read') { show('library'); openBook(j.added); }
  };
}
function drawJobs() {
  const host = $('.conv-jobs', pages.convert); if (!host) return;
  host.innerHTML = jobs.map((j) => `<div class="conv-job" data-job="${j.id}">
    <div>${j.result ? `<div class="book"><div class="cover"><img src="${blobUrl('job' + j.id, j.result.cover)}" alt=""></div></div>` : `<div class="book"><div class="cover" style="display:grid;place-items:center">${j.error ? icon('close') : '<span class="progress-ring"></span>'}</div></div>`}</div>
    <div><div class="t">${esc(j.result ? j.result.title : j.name)}</div>
      <div class="s">${j.error ? `<span style="color:var(--danger)">${esc(j.error)}</span>` : j.result ? `${plural(j.result.chapters, 'chapter')}, ${fmtBytes(j.result.blob.size)}` : `${esc(j.stage || 'Waiting')} ${j.p ? Math.round(j.p * 100) + '%' : ''}`}</div>
      ${j.result ? `<div class="row"><button class="btn ghost" data-c="save">${icon('download')} Save</button>${j.added ? `<button class="btn" data-c="read">Read now</button>` : `<button class="btn" data-c="add">Add to library</button>`}</div>` : ''}
    </div></div>`).join('');
}
async function convertMany(files) {
  if (tab !== 'convert') show('convert');
  const { convertToEpub } = await import('./convert.js');
  const fresh = files.map((f) => ({ id: uid(), name: f.name, file: f, ext: f.name.split('.').pop().toUpperCase() }));
  jobs.unshift(...fresh); drawJobs();
  for (const j of fresh) {
    try { j.result = await convertToEpub(j.file, { onProgress: (p, stage) => { j.p = p; j.stage = stage; drawJobs(); } }); }
    catch (e) { console.error(e); j.error = e.message || 'Conversion failed'; }
    drawJobs();
  }
}

/* ───────────────────────────── boot ───────────────────────────── */
window.addEventListener('popstate', () => { const s = topSheet(); if (s) s.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && topSheet()) closeAllSheets(); });

const start = (location.hash || '#library').slice(1);
show(pages[start] ? start : 'library');
marginalia.refreshInBackground();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update().catch(() => {})).catch(() => {});
  // when a new version takes over, reload straight away unless a book is open
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    if (document.body.classList.contains('reading')) { toast('Quire was updated. It will use the new version next time you open it.', 5000); return; }
    reloaded = true; location.reload();
  });
}

// share-target style: open files passed via ?open (future) — and expose for debugging
window.quire = { importFiles, openBook, db };
void h;
