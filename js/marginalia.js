// Marginalia: reads your existing Supabase library and sends new highlights back to it.
import { $, $$, h, icon, esc, toast, openSheet, genreColor, normTitle, similarity, plural, copyText, shareText, hashStr, relTime } from './util.js';
import { db } from './db.js';

const SUPABASE_URL = 'https://qlacsyzrfsfbbtediozu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-Iy4tCpTDqJqsANBjYMPpg_e1nTMDrh';

/* ───────────────────────────── data ───────────────────────────── */
let cache = null; // { books, highlights, fetchedAt }

async function auth() { return db.kvGet('auth', null); }
async function token() {
  let a = await auth();
  if (!a) return null;
  if (Date.now() > a.expiresAt - 60000) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: a.refresh }) });
    if (!r.ok) { await db.kvSet('auth', null); return null; }
    const j = await r.json();
    a = { email: a.email, access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
    await db.kvSet('auth', a);
  }
  return a.access;
}

async function rest(path, { method = 'GET', body, authed = false, prefer } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  const t = authed ? await token() : null;
  if (authed && !t) throw new Error('signin');
  headers.Authorization = `Bearer ${t || SUPABASE_ANON_KEY}`;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const txt = await r.text(); throw new Error(`Marginalia said ${r.status}: ${txt.slice(0, 160)}`); }
  return r.status === 204 ? null : r.json();
}

async function fetchAll() {
  const books = await rest('books?select=id,title,category,created_at&order=title.asc');
  const highlights = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(`highlights?select=id,book_id,section,subheading,page,highlighted_on,highlight_number,text,created_at&order=book_id.asc,highlight_number.asc.nullslast&offset=${from}&limit=1000`);
    highlights.push(...page);
    if (page.length < 1000) break;
  }
  cache = { books, highlights, fetchedAt: Date.now() };
  await db.kvSet('mg', cache);
  return cache;
}

export const marginalia = {
  async data({ refresh = false } = {}) {
    if (!cache) cache = await db.kvGet('mg', null);
    if (!cache || refresh) { try { await fetchAll(); } catch (e) { if (!cache) throw e; } }
    return cache;
  },
  async refreshInBackground() { try { await fetchAll(); return true; } catch (e) { return false; } },
  async highlightsForTitle(title) {
    try { const d = await this.data(); const b = matchBook(d.books, title); return b && similarity(b.title, title) >= 0.75 ? d.highlights.filter((x) => x.book_id === b.id) : []; } catch (e) { return []; }
  },
  async signedIn() { return auth(); },
  async signIn(email, password) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || 'Email or password is incorrect.');
    await db.kvSet('auth', { email, access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 });
  },
  async signOut() { await db.kvSet('auth', null); },
};

function matchBook(books, title) {
  let best = null, score = 0;
  for (const b of books) { const s = similarity(b.title, title); if (s > score) { score = s; best = b; } }
  return score >= 0.5 ? best : null;
}

/* Send a Quire book's highlights to Marginalia, skipping any already there. */
async function sendHighlights(rec, { title, category }) {
  const local = (await db.byIndex('highlights', 'bookId', rec.id)).filter((x) => x.type !== 'bookmark').sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0) || a.createdAt - b.createdAt);
  if (!local.length) return { added: 0, skipped: 0 };
  let [book] = await rest(`books?select=id,title,category&title=eq.${encodeURIComponent(title)}`);
  if (!book) [book] = await rest('books', { method: 'POST', body: { title, category }, authed: true, prefer: 'return=representation' });
  const existing = await rest(`highlights?select=text,highlight_number&book_id=eq.${book.id}`);
  const norm = (t) => t.replace(/\s+/g, ' ').replace(/[“”"‘’']/g, '').trim().toLowerCase();
  const have = new Set(existing.map((x) => norm(x.text)));
  let n = existing.reduce((m, x) => Math.max(m, x.highlight_number || 0), 0);
  const rows = []; const sentIds = [];
  for (const x of local) {
    sentIds.push(x.id);
    if (have.has(norm(x.text))) continue;
    have.add(norm(x.text));
    rows.push({
      book_id: book.id, section: x.chapter || null, subheading: x.note ? `Note: ${x.note}` : null,
      page: x.percent != null ? `${Math.round(x.percent * 100)}%` : null,
      highlighted_on: new Date(x.createdAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      highlight_number: ++n, text: x.text,
    });
  }
  for (let i = 0; i < rows.length; i += 200) await rest('highlights', { method: 'POST', body: rows.slice(i, i + 200), authed: true, prefer: 'return=minimal' });
  const now = Date.now();
  for (const id of sentIds) await db.patch('highlights', id, { sentAt: now });
  await db.patch('books', rec.id, { marginaliaTitle: title });
  fetchAll().catch(() => {});
  return { added: rows.length, skipped: local.length - rows.length };
}

/* ───────────────────────────── sign-in & send sheets ───────────────────────────── */
export function openSignIn({ root, then } = {}) {
  const s = openSheet(`<h3>Sign in to Marginalia</h3><p class="lead">Use the same email and password as Marginalia’s Manage tab. Reading never needs this; sending highlights does.</p>
    <form>
      <label class="field"><span>Email</span><input class="input" type="email" name="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="pw" autocomplete="current-password" required></label>
      <p class="err" style="color:var(--danger);font-size:14px;min-height:1em;margin:0 0 10px"></p>
      <button class="btn wide" type="submit">Sign in</button>
    </form>`, { root });
  $('form', s.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true; btn.innerHTML = '<span class="progress-ring"></span>';
    try { await marginalia.signIn(f.email.value.trim(), f.pw.value); s.close(); toast('Signed in to Marginalia'); then && then(); }
    catch (err) { $('.err', f).textContent = err.message; btn.disabled = false; btn.textContent = 'Sign in'; }
  });
}

export async function openSendSheet(rec, { root } = {}) {
  const local = (await db.byIndex('highlights', 'bookId', rec.id)).filter((x) => x.type !== 'bookmark');
  if (!local.length) { toast('Highlight something in this book first'); return; }
  if (!(await marginalia.signedIn())) return openSignIn({ root, then: () => openSendSheet(rec, { root }) });
  let d; try { d = await marginalia.data(); } catch (e) { toast('Marginalia is unreachable. Check your connection.'); return; }
  const match = rec.marginaliaTitle ? d.books.find((b) => b.title === rec.marginaliaTitle) : matchBook(d.books, rec.title);
  const cats = [...new Set(d.books.map((b) => b.category))].sort();
  const unsent = local.filter((x) => !x.sentAt).length;
  const s = openSheet(`<h3>Send to Marginalia</h3>
    <p class="lead">${plural(local.length, 'highlight')} in this book${unsent < local.length ? `, ${unsent} not sent yet` : ''}. Anything already in Marginalia is skipped, so sending twice is safe.</p>
    <form>
      <label class="field"><span>Book in Marginalia</span><input class="input" name="title" list="mg-titles" value="${esc(match ? match.title : rec.title)}" required></label>
      <datalist id="mg-titles">${d.books.map((b) => `<option value="${esc(b.title)}">`).join('')}</datalist>
      <label class="field"><span>Category</span><input class="input" name="cat" list="mg-cats" value="${esc(match ? match.category : '')}" placeholder="e.g. History" required></label>
      <datalist id="mg-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <p class="hint" style="color:var(--muted);font-size:13.5px;margin:-4px 2px 16px">${match ? `Adds to “${esc(match.title)}”, which has ${plural(d.highlights.filter((x) => x.book_id === match.id).length, 'highlight')}.` : 'This title is new to Marginalia, so it will be added as a new book.'}</p>
      <button class="btn wide" type="submit">${icon('send')} Send highlights</button>
    </form>`, { root });
  const f = $('form', s.el);
  f.title.addEventListener('input', () => {
    const b = d.books.find((x) => x.title === f.title.value);
    if (b) f.cat.value = b.category;
    $('.hint', s.el).textContent = b ? `Adds to “${b.title}”, which has ${plural(d.highlights.filter((x) => x.book_id === b.id).length, 'highlight')}.` : 'This title is new to Marginalia, so it will be added as a new book.';
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', f); btn.disabled = true; btn.innerHTML = '<span class="progress-ring"></span> Sending';
    try {
      const r = await sendHighlights(rec, { title: f.title.value.trim(), category: f.cat.value.trim() });
      s.close();
      toast(r.added ? `Sent ${plural(r.added, 'highlight')}${r.skipped ? `. ${r.skipped} were already there.` : ''}` : 'Everything was already in Marginalia');
    } catch (err) {
      if (err.message === 'signin') { s.close(); return openSignIn({ root, then: () => openSendSheet(rec, { root }) }); }
      btn.disabled = false; btn.innerHTML = `${icon('send')} Try again`; toast(err.message, 5000);
    }
  });
}

/* ───────────────────────────── the Marginalia page ───────────────────────────── */
let state = { cat: 'all', q: '', bookKey: null, todaySeed: null };
let model = null; // merged view of remote + local highlights

async function buildModel() {
  let d = null;
  try { d = await marginalia.data(); } catch (e) { d = null; }
  const books = new Map(); // key -> { key, title, category, color, items: [] }
  if (d) {
    const byId = new Map(d.books.map((b) => [b.id, b]));
    d.books.forEach((b) => books.set(b.id, { key: b.id, title: b.title, category: b.category, color: genreColor(b.category), items: [] }));
    d.highlights.forEach((x) => { const b = books.get(x.book_id); if (b) b.items.push({ text: x.text, chapter: x.section, page: x.page, note: x.subheading && x.subheading.startsWith('Note: ') ? x.subheading.slice(6) : null, sub: x.subheading && !x.subheading.startsWith('Note: ') ? x.subheading : null, at: Date.parse(x.created_at) || 0, n: x.highlight_number }); });
    void byId;
  }
  // local, not-yet-sent highlights
  const localBooks = await db.all('books');
  const localHls = (await db.all('highlights')).filter((x) => x.type !== 'bookmark' && !x.sentAt);
  for (const x of localHls) {
    const lb = localBooks.find((b) => b.id === x.bookId); if (!lb) continue;
    let target = [...books.values()].find((b) => b.title === lb.marginaliaTitle) || [...books.values()].find((b) => similarity(b.title, lb.title) >= 0.85);
    if (!target) {
      const key = 'local:' + lb.id;
      target = books.get(key) || { key, title: lb.title, category: 'In Quire', color: genreColor(lb.title), items: [], localBook: lb.id };
      books.set(key, target);
    }
    target.localBook = lb.id;
    target.items.push({ text: x.text, chapter: x.chapter, note: x.note, at: x.createdAt, local: true, color: x.color });
  }
  const list = [...books.values()].filter((b) => b.items.length);
  const all = list.flatMap((b) => b.items.map((it) => ({ ...it, book: b })));
  model = { list, all, online: !!d, fetchedAt: d?.fetchedAt };
  return model;
}

function todayPick(pool) {
  if (!pool.length) return null;
  if (state.todaySeed == null) { const dt = new Date(); state.todaySeed = hashStr(dt.toDateString()); }
  return pool[state.todaySeed % pool.length];
}

export async function renderMarginalia(page) {
  if (state.bookKey) return renderBook(page);
  page.innerHTML = `<div class="head"><div><h1>Marginalia</h1><div class="sub">Loading your highlights</div></div></div><div style="padding:40px 0;text-align:center"><span class="progress-ring"></span></div>`;
  try { await buildModel(); } catch (e) { console.error(e); }
  if (!model || !model.all.length) {
    page.innerHTML = `<div class="head"><div><h1>Marginalia</h1></div></div>
      <div class="empty"><h2>No highlights yet</h2><p>${model && !model.online ? 'Marginalia couldn’t be reached. Connect to the internet once and your Kindle highlights will be kept here for offline reading.' : 'Highlight passages while you read and they will gather here.'}</p>
      <button class="btn" data-mg="refresh">${icon('refresh')} Try again</button></div>`;
    page.querySelector('[data-mg=refresh]').onclick = async () => { await marginalia.refreshInBackground(); renderMarginalia(page); };
    return;
  }
  const cats = {}; model.list.forEach((b) => { cats[b.category] = (cats[b.category] || 0) + b.items.length; });
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const localCount = model.all.filter((x) => x.local).length;
  page.innerHTML = `
    <div class="head"><div><h1>Marginalia</h1><div class="sub">${plural(model.all.length, 'highlight')} from ${plural(model.list.length, 'book')}${localCount ? `, ${localCount} not yet sent` : ''}</div></div>
      <div class="head-actions"><button class="icon-btn" data-mg="refresh" aria-label="Refresh from Marginalia">${icon('refresh')}</button></div></div>
    <label class="search">${icon('search')}<input type="search" placeholder="Search every highlight" value="${esc(state.q)}" enterkeyhint="search"></label>
    <div class="chips" role="group" aria-label="Categories"><button class="chip" data-cat="all" aria-pressed="${state.cat === 'all'}">All</button>${catList.map(([c, n]) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${state.cat === c}"><i style="background:${genreColor(c)}"></i>${esc(c)} <span style="opacity:.6">${n}</span></button>`).join('')}</div>
    <div class="mg-body"></div>`;
  const body = $('.mg-body', page);
  const input = $('.search input', page);
  const draw = () => {
    const pool = model.all.filter((x) => state.cat === 'all' || x.book.category === state.cat);
    const books = model.list.filter((b) => state.cat === 'all' || b.category === state.cat).sort((a, b) => a.title.localeCompare(b.title));
    if (state.q.trim().length >= 2) return drawSearch(body, pool);
    const pick = todayPick(pool);
    const recent = [...pool].sort((a, b) => b.at - a.at).slice(0, 12);
    rowSource = recent;
    body.innerHTML = `
      ${pick ? `<div class="today"><div class="label"><span>A passage for today</span><button class="btn quiet" data-mg="shuffle" style="height:30px" aria-label="Another passage">${icon('shuffle')}</button></div>
        <blockquote>${esc(pick.text)}</blockquote>
        <div class="src"><b>${esc(pick.book.title)}</b>${pick.chapter ? `, ${esc(pick.chapter)}` : ''}</div></div>` : ''}
      <div class="section-title">Shelf</div><p class="section-sub">Spines grow with the number of passages you kept.</p>
      <div class="shelf-wrap"><div class="shelf">${books.map((b) => {
        const w = Math.round(Math.min(68, 30 + Math.sqrt(b.items.length) * 3.4));
        const hgt = 196 + (hashStr(b.title) % 46);
        return `<button class="spine" data-book="${esc(b.key)}" style="width:${w}px;height:${hgt}px;background:${b.color}" aria-label="${esc(b.title)}, ${b.items.length} highlights"><span class="n">${b.items.length}</span><span>${esc(b.title)}</span></button>`;
      }).join('')}</div></div>
      <div class="section-title">Recently kept</div>
      <ul class="hl-list">${recent.map(hlRow).join('')}</ul>`;
  };
  draw();
  page.onclick = async (e) => {
    const c = e.target.closest('[data-cat]'); if (c) { state.cat = c.dataset.cat; $$('[data-cat]', page).forEach((b) => b.setAttribute('aria-pressed', b === c)); state.todaySeed = null; return draw(); }
    const sp = e.target.closest('[data-book]'); if (sp) { state.bookKey = sp.dataset.book; page.scrollTop = 0; return renderBook(page); }
    const a = e.target.closest('[data-mg]')?.dataset.mg;
    if (a === 'shuffle') return nextToday(page);
    if (a === 'refresh') { toast('Refreshing'); const ok = await marginalia.refreshInBackground(); toast(ok ? 'Up to date' : 'Marginalia is unreachable'); return renderMarginalia(page); }
    rowActions(e);
  };
  let t; input.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = input.value; draw(); }, 180); };
  swipeToday(page);
}

function nextToday(page) {
  const bq = $('.today blockquote', page); if (!bq) return;
  bq.classList.add('out');
  setTimeout(() => {
    state.todaySeed = (state.todaySeed * 1103515245 + 12345) >>> 0;
    const pool = model.all.filter((x) => state.cat === 'all' || x.book.category === state.cat);
    const p = todayPick(pool);
    bq.textContent = p.text; $('.today .src', page).innerHTML = `<b>${esc(p.book.title)}</b>${p.chapter ? `, ${esc(p.chapter)}` : ''}`;
    bq.classList.remove('out');
  }, 220);
}
function swipeToday(page) {
  const el = $('.today', page); if (!el) return;
  let x0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 60) nextToday(page); x0 = null; });
}

function hlRow(x, i) {
  return `<li class="hl" data-i="${i}"><p>${esc(x.text)}</p>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}
    <div class="meta">${x.book && !state.bookKey ? `<span class="swatch" style="background:${x.book.color}"></span>` : ''}<span class="grow">${esc([!state.bookKey && x.book ? x.book.title : null, x.chapter, x.page && (/%$/.test(x.page) ? x.page : 'p. ' + x.page)].filter(Boolean).join(', '))}</span>${x.local ? '<span class="local">Not sent</span>' : ''}
    <button data-copy="${i}" aria-label="Copy">${icon('copy')}</button><button data-share="${i}" aria-label="Share">${icon('share')}</button></div></li>`;
}
let rowSource = [];
function rowActions(e) {
  const c = e.target.closest('[data-copy]'), s = e.target.closest('[data-share]');
  const x = c ? rowSource[+c.dataset.copy] : s ? rowSource[+s.dataset.share] : null;
  if (!x) return;
  const t = `“${x.text}”\n— ${x.book.title}`;
  c ? copyText(t) : shareText(t, x.book.title);
}

function drawSearch(body, pool) {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const res = pool.filter((x) => terms.every((t) => x.text.toLowerCase().includes(t) || (x.note || '').toLowerCase().includes(t) || x.book.title.toLowerCase().includes(t)));
  rowSource = res.slice(0, 150);
  const mark = (s) => { let o = esc(s); terms.forEach((t) => { o = o.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => `<mark class="q">${m}</mark>`); }); return o; };
  body.innerHTML = `<p class="section-sub" style="margin-top:16px">${res.length ? plural(res.length, 'match', 'matches') : 'Nothing matches that. Try fewer words.'}${res.length > 150 ? ', showing the first 150' : ''}</p>
    <ul class="hl-list">${rowSource.map((x, i) => hlRow(x, i).replace(`<p>${esc(x.text)}</p>`, `<p>${mark(x.text)}</p>`)).join('')}</ul>`;
}

function renderBook(page) {
  const b = model?.list.find((x) => x.key === state.bookKey);
  if (!b) { state.bookKey = null; return renderMarginalia(page); }
  rowSource = [...b.items].sort((a, c) => (a.n ?? 1e9) - (c.n ?? 1e9) || a.at - c.at).map((x) => ({ ...x, book: b }));
  const local = rowSource.filter((x) => x.local).length;
  page.innerHTML = `<button class="back" data-mg="back">${icon('back')} Marginalia</button>
    <div class="book-head"><div class="band" style="background:${b.color}"></div><h1>${esc(b.title)}</h1>
      <div class="sub">${esc(b.category)}, ${plural(b.items.length, 'highlight')}${local ? `, ${local} waiting in Quire` : ''}</div>
      ${b.localBook && local ? `<button class="btn ghost" data-mg="send" style="margin-top:16px;height:40px;font-size:15px">${icon('send')} Send to Marginalia</button>` : ''}
    </div>
    <ul class="hl-list">${rowSource.map(hlRow).join('')}</ul>`;
  page.classList.remove('enter'); void page.offsetWidth; page.classList.add('enter');
  page.onclick = async (e) => {
    const a = e.target.closest('[data-mg]')?.dataset.mg;
    if (a === 'back') { state.bookKey = null; return renderMarginalia(page); }
    if (a === 'send') { const rec = await db.get('books', b.localBook); return openSendSheet(rec); }
    rowActions(e);
  };
}
export function resetMarginalia() { state.bookKey = null; }
void h; void normTitle; void relTime;
