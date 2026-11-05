// EPUB reader built on epub.js: paginated, themed, with highlights, notes, bookmarks, search.
import { $, $$, h, icon, esc, uid, toast, openSheet, needEpub, copyText, haptic, setRange, confirmSheet, similarity, plural } from './util.js';
import { db, settings, saveSettings } from './db.js';
import { marginalia } from './marginalia.js';

export const THEMES = {
  paper: { name: 'Paper', bg: '#F8F6F0', fg: '#26241F', muted: '#8C877C', line: 'rgba(40,36,28,.12)', glass: 'rgba(248,246,240,.84)', strong: 'rgba(251,250,246,.95)', sheet: '#EFECE4', dark: false },
  sepia: { name: 'Sepia', bg: '#F1E5CB', fg: '#3A2E1F', muted: '#8C775A', line: 'rgba(80,58,24,.16)', glass: 'rgba(241,229,203,.86)', strong: 'rgba(245,236,214,.95)', sheet: '#E8DABB', dark: false },
  sage: { name: 'Sage', bg: '#DEE6DB', fg: '#1E2A23', muted: '#69786F', line: 'rgba(30,50,40,.14)', glass: 'rgba(222,230,219,.86)', strong: 'rgba(230,236,228,.95)', sheet: '#D2DCCF', dark: false },
  dusk: { name: 'Dusk', bg: '#1F2528', fg: '#D7D3C8', muted: '#848A88', line: 'rgba(255,255,255,.10)', glass: 'rgba(31,37,40,.84)', strong: 'rgba(38,45,49,.95)', sheet: '#272E32', dark: true },
  night: { name: 'Night', bg: '#000000', fg: '#B8B3A7', muted: '#6C6962', line: 'rgba(255,255,255,.11)', glass: 'rgba(14,14,14,.86)', strong: 'rgba(24,24,24,.95)', sheet: '#121212', dark: true },
};
export const FONTS = {
  newyork: { label: 'New York', css: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif' },
  charter: { label: 'Charter', css: 'Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif' },
  iowan: { label: 'Iowan', css: '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif' },
  newsreader: { label: 'Newsreader', css: 'Newsreader, Georgia, serif' },
  literata: { label: 'Literata', css: 'Literata, Georgia, serif' },
  atkinson: { label: 'Atkinson', css: '"Atkinson Hyperlegible", -apple-system, system-ui, sans-serif' },
  sf: { label: 'San Francisco', css: '-apple-system, system-ui, "Helvetica Neue", sans-serif' },
  original: { label: 'Original', css: null },
};
export const HL = {
  amber: '#F2C14E', sage: '#86C595', sky: '#7DB2E6', rose: '#EC8C9E',
};
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap';

let R = null; // current reader state

function readerCss() {
  const t = THEMES[settings.readerTheme] || THEMES.paper;
  const f = FONTS[settings.font] || FONTS.newyork;
  return `
    :root { color-scheme: ${t.dark ? 'dark' : 'light'}; }
    html, body { background: transparent !important; overscroll-behavior: none; }
    body { color: ${t.fg} !important; font-size: ${settings.fontSize}% !important; ${f.css ? `font-family: ${f.css} !important;` : ''}
      -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; font-kerning: normal; font-variant-ligatures: common-ligatures; }
    body *:not(a):not(mark) { color: inherit !important; background-color: transparent !important; ${f.css ? `font-family: inherit !important;` : ''} }
    p, li, blockquote, dd, div { line-height: ${settings.lineHeight} !important; }
    p { ${settings.justify ? 'text-align: justify !important;' : 'text-align: left !important;'} ${settings.hyphenate ? '-webkit-hyphens: auto !important; hyphens: auto !important;' : '-webkit-hyphens: manual !important; hyphens: manual !important;'} widows: 2; orphans: 2; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25 !important; text-align: left; -webkit-hyphens: manual !important; hyphens: manual !important; }
    a { color: inherit !important; text-decoration-color: ${t.muted} !important; }
    img, svg, video { max-width: 100% !important; height: auto; ${t.dark ? 'filter: brightness(.86);' : ''} }
    ::selection { background: rgba(214, 182, 107, ${t.dark ? '.40' : '.45'}); }
    pre, code { white-space: pre-wrap !important; font-size: .9em; }
    @media (hover: none) { html, body { cursor: pointer; } }
    img, svg { -webkit-touch-callout: none; -webkit-user-drag: none; }
  `;
}

function injectStyle(contents) {
  const doc = contents.document;
  let s = doc.getElementById('quire-style');
  if (!s) { s = doc.createElement('style'); s.id = 'quire-style'; doc.head.appendChild(s); }
  s.textContent = readerCss();
}

function hlStyle(color) {
  const t = THEMES[settings.readerTheme] || THEMES.paper;
  return { fill: HL[color] || HL.amber, 'fill-opacity': t.dark ? '0.32' : '0.42', 'mix-blend-mode': t.dark ? 'screen' : 'multiply' };
}

function applyChromeVars(el) {
  const t = THEMES[settings.readerTheme] || THEMES.paper;
  el.style.colorScheme = t.dark ? 'dark' : 'light';
  document.documentElement.style.backgroundColor = t.bg; document.body.style.backgroundColor = t.bg;
  Object.entries({ '--r-bg': t.bg, '--r-fg': t.fg, '--r-muted': t.muted, '--r-line': t.line, '--r-glass': t.glass, '--r-glass-strong': t.strong, '--r-sheet': t.sheet, '--r-margin': settings.margin + 'px' })
    .forEach(([k, v]) => el.style.setProperty(k, v));
  const meta = document.querySelector('meta[name="theme-color"]:not([media])') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  meta.content = t.bg;
}

/* ───────────────────────────── open ───────────────────────────── */
export async function openEpub(rec, { onClose } = {}) {
  if (R) await closeReader();
  const ePub = await needEpub();
  const file = await db.get('files', rec.id);
  if (!file) { toast('This book’s file is missing. Try adding it again.'); return; }

  const el = h(`<div class="reader" role="application" aria-label="${esc(rec.title)}">
    <div class="rmeta top"><button class="mini" data-act="close" aria-label="Back to library">${icon('back')}</button><span class="m-chap"></span><button class="mini aa" data-act="type" aria-label="Text and theme">Aa</button></div>
    <div class="stage"><div class="epub-area"></div></div>
    <div class="rmeta bot"><span class="m-left"></span><span class="m-pct"></span></div>
    <div class="loading-veil"><div><div class="t">${esc(rec.title)}</div><div class="s">Opening</div></div></div>
    <div class="rbar top">
      <button class="icon-btn" data-act="close" aria-label="Back to library">${icon('back')}</button>
      <div class="title">${esc(rec.title)}</div>
      <button class="icon-btn" data-act="search" aria-label="Search in book">${icon('search')}</button>
      <button class="icon-btn" data-act="bookmark" aria-label="Bookmark this page">${icon('bookmark')}</button>
    </div>
    <div class="rbar bot">
      <div class="scrub"><span class="s-chap">—</span><input type="range" min="0" max="1000" value="0" aria-label="Position in book" disabled><span class="s-pct">0%</span></div>
      <div class="rtools">
        <button class="icon-btn" data-act="toc" aria-label="Contents">${icon('list')}</button>
        <button class="icon-btn" data-act="notes" aria-label="Highlights and notes">${icon('note')}</button>
        <button class="icon-btn" data-act="type" aria-label="Text and theme">${icon('type')}</button>
        <button class="icon-btn" data-act="send" aria-label="Send highlights to Marginalia">${icon('send')}</button>
      </div>
    </div>
    <div class="extend-banner" role="status"><span>Turn to where the passage ends and tap its last word.</span><button data-x="cancel">Cancel</button></div>
    <div class="hlbar" role="toolbar" aria-label="Highlight">
      ${Object.keys(HL).map((c) => `<button class="dot" data-color="${c}" aria-label="Highlight ${c}"><i style="background:${HL[c]}"></i></button>`).join('')}
      <span class="sep"></span>
      <button class="icon-btn" data-hl="note" aria-label="Add note">${icon('pen')}</button>
      <button class="icon-btn" data-hl="extend" aria-label="Continue highlight onto later pages">${icon('extend')}</button>
      <button class="icon-btn" data-hl="copy" aria-label="Copy">${icon('copy')}</button>
      <button class="icon-btn" data-hl="delete" aria-label="Remove highlight" hidden>${icon('trash')}</button>
    </div>
  </div>`);
  applyChromeVars(el);
  $('#reader-root').appendChild(el);
  document.body.classList.add('reading');

  const book = ePub(await file.blob.arrayBuffer());
  // Safari drops every touch and selection event in a sandboxed iframe that can't run scripts,
  // so the frame must allow scripts. The book's own scripts are removed before it is shown.
  book.spine.hooks.serialize.register((output, section) => {
    section.output = String(section.output || output)
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  });
  const area = $('.epub-area', el);
  const rendition = book.renderTo(area, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', minSpreadWidth: 900, allowScriptedContent: true });

  R = { rec, el, book, rendition, onClose, sel: null, editing: null, hits: 0, toc: [], loc: null, highlights: [], bookmarks: [], locReady: false };

  rendition.hooks.content.register((contents) => {
    try { contents.addStylesheet(FONT_CSS); } catch (e) {}
    injectStyle(contents);
    wireContentGestures(contents);
  });
  rendition.on('selected', (cfiRange, contents) => onSelected(cfiRange, contents));
  rendition.on('relocated', (loc) => onRelocated(loc));
  rendition.on('keyup', onKey);

  wireChrome();
  wireOuterTaps(el);
  document.addEventListener('keyup', onKey);

  try {
    await book.ready;
    const nav = await book.loaded.navigation;
    R.toc = flattenToc(nav.toc || []);
    await rendition.display(rec.loc || undefined).catch(() => rendition.display());
  } catch (e) {
    console.error(e);
    toast('This EPUB could not be opened.');
    await closeReader(); return;
  }
  $('.loading-veil', el).classList.add('gone');
  await loadAnnotations();
  db.patch('books', rec.id, { openedAt: Date.now() });
  saveSettings({ lastBook: rec.id });
  prepareLocations();
}

function flattenToc(items, depth = 0, out = []) {
  items.forEach((it) => { out.push({ label: (it.label || '').trim(), href: it.href, depth }); if (it.subitems && it.subitems.length) flattenToc(it.subitems, depth + 1, out); });
  return out;
}
function chapterFor(href) {
  if (!R || !href) return '';
  const base = href.split('#')[0];
  let best = '';
  for (const t of R.toc) { const th = (t.href || '').split('#')[0]; if (th && (base.endsWith(th) || th.endsWith(base))) { best = t.label; break; } }
  if (!best) {
    // nearest previous toc entry in spine order
    const idx = R.book.spine.get(href)?.index ?? -1;
    for (const t of R.toc) { const s = R.book.spine.get(t.href); if (s && s.index <= idx) best = t.label; }
  }
  return best;
}

async function prepareLocations() {
  const key = 'loc:' + R.rec.id; const rec = R.rec; const book = R.book;
  const cached = await db.kvGet(key);
  try {
    if (cached) book.locations.load(cached);
    else { await book.locations.generate(1200); if (R && R.book === book) await db.kvSet(key, book.locations.save()); }
  } catch (e) { return; }
  if (!R || R.book !== book) return;
  R.locReady = true;
  const input = $('.scrub input', R.el); input.disabled = false;
  if (R.loc) onRelocated(R.loc);
  else { const l = R.rendition.currentLocation(); if (l && l.start) onRelocated(l); }
  void rec;
}

/* ───────────────────────────── chrome ───────────────────────────── */
function toggleChrome(force) {
  const on = force ?? !R.el.classList.contains('chrome');
  R.el.classList.toggle('chrome', on);
  if (on) hideHlBar();
}

function wireChrome() {
  const el = R.el;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'close') closeReader();
    if (a === 'toc') showToc();
    if (a === 'notes') showNotebook();
    if (a === 'type') showTypeSheet();
    if (a === 'search') showSearch();
    if (a === 'bookmark') toggleBookmark();
    if (a === 'send') sendToMarginalia();
  });
  const input = $('.scrub input', el);
  input.addEventListener('input', () => {
    setRange(input);
    $('.s-pct', el).textContent = Math.round(input.value / 10) + '%';
    if (R.locReady) { const cfi = R.book.locations.cfiFromPercentage(input.value / 1000); const sec = R.book.spine.get(cfi); $('.s-chap', el).textContent = sec ? chapterFor(sec.href) || '—' : '—'; }
  });
  input.addEventListener('change', () => { if (R.locReady) R.rendition.display(R.book.locations.cfiFromPercentage(input.value / 1000)); });

  const bar = $('.hlbar', el);
  bar.addEventListener('click', async (e) => {
    const dot = e.target.closest('[data-color]');
    const act = e.target.closest('[data-hl]')?.dataset.hl;
    if (dot) { haptic(); if (R.editing) await recolor(R.editing, dot.dataset.color); else await createHighlight(dot.dataset.color); }
    else if (act === 'copy') { const t = R.editing ? R.editing.text : R.sel?.text; if (t) copyText(t); clearSelection(); hideHlBar(); }
    else if (act === 'extend') { startExtend(); }
    else if (act === 'note') { const hl = R.editing || (await createHighlight(settings.lastColor || 'amber', true)); if (hl) editNote(hl); }
    else if (act === 'delete' && R.editing) { await deleteHighlight(R.editing); }
  });
}

function onKey(e) {
  if (!R || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === ' ') turn(1);
  if (e.key === 'ArrowLeft') turn(-1);
  if (e.key === 'Escape') { if (R.el.classList.contains('chrome')) toggleChrome(false); else closeReader(); }
}

/* ───────────────────────── page turning ───────────────────────── */
let turning = false;
async function turn(dir, fromDx = 0) {
  if (!R || turning) return;
  turning = true;
  const stage = $('.stage', R.el), W = window.innerWidth;
  hideHlBar(); toggleChrome(false);
  const out = dir > 0 ? -W * 0.3 : W * 0.3;
  try {
    // the old page slides away with your finger...
    await stage.animate([{ transform: `translateX(${fromDx}px)`, opacity: 1 - Math.min(0.5, Math.abs(fromDx) / W) }, { transform: `translateX(${out}px)`, opacity: 0 }], { duration: fromDx ? 130 : 160, easing: 'cubic-bezier(.4,0,1,1)' }).finished;
  } catch (e) {}
  // ...then the page must be perfectly still while epub.js turns it, or it miscounts pages
  stage.style.transform = ''; stage.style.opacity = '0';
  try { await (dir > 0 ? R.rendition.next() : R.rendition.prev()); } catch (e) {}
  await new Promise((r) => requestAnimationFrame(r));
  stage.style.opacity = '';
  try { await stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }).finished; } catch (e) {}
  turning = false;
}
function dragStage(dx) {
  const stage = $('.stage', R.el);
  stage.style.transform = `translateX(${dx}px)`;
  stage.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / window.innerWidth));
}
function snapBack() {
  const stage = $('.stage', R.el);
  stage.animate([{ transform: stage.style.transform || 'none', opacity: stage.style.opacity || 1 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  stage.style.transform = ''; stage.style.opacity = '';
}

/* ───────────────────────── gestures inside the page ─────────────────────────
   Swipes drag the page with your finger. Taps: left quarter = back, right quarter = forward,
   middle = show or hide the controls. Highlight taps (from epub.js) win over page taps. */
let lastTouchTap = 0;
function tapAt(x, contents, cx, cy) {
  if (!R) return;
  if (Date.now() - R.hits < 450) return;
  if (R.el.querySelector('.hlbar.on')) { hideHlBar(); return; }
  if (R.extend && contents && x >= 0.25 && x <= 0.75) {
    const c = caretAt(contents.document, cx, cy);
    if (c) return finishExtend(contents, c.node, c.offset);
  }
  if (x < 0.25) turn(-1);
  else if (x > 0.75) turn(1);
  else toggleChrome();
}
function frameLeft(contents) {
  try { const f = contents.window.frameElement; return f ? f.getBoundingClientRect().left : 0; } catch (e) { return 0; }
}
function wireContentGestures(contents) {
  const doc = contents.document, win = contents.window;
  let g = null;
  const selActive = () => { const s = win.getSelection(); return s && !s.isCollapsed; };
  doc.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { g = null; return; }
    const t = e.touches[0];
    g = { sx: t.screenX, sy: t.screenY, cx: t.clientX, cy: t.clientY, t: Date.now(), moved: false, horiz: null, fl: frameLeft(contents) };
  }, { passive: true });
  doc.addEventListener('touchmove', (e) => {
    if (!g || turning) return;
    if (e.touches.length > 1 || selActive()) { if (g.horiz) snapBack(); g = null; return; }
    const t = e.touches[0]; const dx = t.screenX - g.sx, dy = t.screenY - g.sy;
    if (!g.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { g.moved = true; g.horiz = Math.abs(dx) > Math.abs(dy); }
    if (g.horiz) { if (Date.now() - g.t > 380 && Math.abs(dx) < 20) { g = null; return; } if (e.cancelable) e.preventDefault(); dragStage(dx); }
  }, { passive: false });
  doc.addEventListener('touchend', (e) => {
    if (!R || !g || e.touches.length) return;
    const gg = g; g = null;
    const t = e.changedTouches[0]; const dx = t.screenX - gg.sx, dt = Date.now() - gg.t;
    if (selActive()) { if (gg.horiz) snapBack(); return; }
    if (gg.horiz) {
      const fast = Math.abs(dx) / dt > 0.35;
      if (Math.abs(dx) > window.innerWidth * 0.18 || (fast && Math.abs(dx) > 30)) turn(dx < 0 ? 1 : -1, dx);
      else snapBack();
      return;
    }
    if (gg.moved || dt > 450) return;
    if (e.target.closest && e.target.closest('a[href]')) return;
    lastTouchTap = Date.now();
    const x = (gg.cx + gg.fl) / window.innerWidth;
    setTimeout(() => tapAt(x, contents, gg.cx, gg.cy), 120);
  }, { passive: true });
  doc.addEventListener('touchcancel', () => { if (g && g.horiz) snapBack(); g = null; }, { passive: true });
  doc.addEventListener('click', (e) => {
    if (!R || Date.now() - lastTouchTap < 800) return;
    if (e.target.closest && e.target.closest('a[href]')) return;
    if (selActive()) return;
    const x = (e.clientX + frameLeft(contents)) / window.innerWidth;
    setTimeout(() => tapAt(x, contents, e.clientX, e.clientY), 60);
  });
  doc.addEventListener('selectionchange', () => {
    const s = win.getSelection();
    if (R && (!s || s.isCollapsed) && !R.editing) setTimeout(() => { const s2 = win.getSelection(); if (!s2 || s2.isCollapsed) hideHlBar(); }, 200);
  });
  doc.addEventListener('keyup', onKey);
}

/* Margins, header and footer sit outside the book's frame */
function wireOuterTaps(el) {
  let sx = 0, sy = 0, st = 0, ok = false;
  const outside = (target) => !target.closest('.rbar, .hlbar, .sheet, .scrim, .mini, .extend-banner, .loading-veil:not(.gone)');
  el.addEventListener('touchstart', (e) => { ok = outside(e.target) && e.target.tagName !== 'IFRAME'; const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!ok || !R) return;
    const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.3) { turn(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - st < 450) { lastTouchTap = Date.now(); const x = t.clientX / window.innerWidth; setTimeout(() => tapAt(x), 120); }
  }, { passive: true });
  el.addEventListener('click', (e) => {
    if (Date.now() - lastTouchTap < 800 || !outside(e.target) || e.target.closest('button, input')) return;
    tapAt(e.clientX / window.innerWidth);
  });
  $('.extend-banner [data-x]', el).addEventListener('click', cancelExtend);
}

/* ───────────────────────────── location ───────────────────────────── */
let saveTimer;
function onRelocated(loc) {
  if (!R || !loc || !loc.start) return;
  R.loc = loc;
  const el = R.el;
  const chap = chapterFor(loc.start.href);
  $('.m-chap', el).textContent = chap;
  const d = loc.start.displayed || {};
  const left = d.total ? d.total - d.page : 0;
  $('.m-left', el).textContent = d.total ? (left === 0 ? 'Last page in chapter' : `${plural(left, 'page')} left in chapter`) : '';
  let pct = null;
  if (R.locReady) {
    pct = R.book.locations.percentageFromCfi(loc.start.cfi);
    $('.m-pct', el).textContent = Math.round(pct * 100) + '%';
    const input = $('.scrub input', el); input.value = Math.round(pct * 1000); setRange(input);
    $('.s-pct', el).textContent = Math.round(pct * 100) + '%';
  }
  $('.s-chap', el).textContent = chap || '—';
  updateBookmarkIcon();
  clearTimeout(saveTimer);
  const id = R.rec.id, cfi = loc.start.cfi, atEnd = !!loc.atEnd;
  saveTimer = setTimeout(() => {
    const patch = { loc: cfi, openedAt: Date.now() };
    if (pct != null) patch.progress = atEnd ? 1 : pct;
    if (atEnd) patch.finished = true;
    db.patch('books', id, patch);
  }, 400);
}

/* ───────────────────────────── highlights ───────────────────────────── */
async function loadAnnotations() {
  const all = await db.byIndex('highlights', 'bookId', R.rec.id);
  R.highlights = all.filter((x) => x.type !== 'bookmark').sort((a, b) => cmpCfi(a.cfi, b.cfi));
  R.bookmarks = all.filter((x) => x.type === 'bookmark');
  R.highlights.forEach(drawHighlight);
  updateBookmarkIcon();
}
function drawHighlight(hl) {
  try {
    R.rendition.annotations.remove(hl.cfi, 'highlight');
    R.rendition.annotations.highlight(hl.cfi, { id: hl.id }, () => { R.hits = Date.now(); editHighlight(hl.id); }, 'q-hl', hlStyle(hl.color));
  } catch (e) { console.warn('highlight draw failed', e); }
}
function redrawAll() { R.highlights.forEach(drawHighlight); }
function cmpCfi(a, b) { try { return new window.ePub.CFI().compare(a, b); } catch (e) { return 0; } }

function onSelected(cfiRange, contents) {
  const text = contents.window.getSelection().toString().trim();
  if (!text) return;
  if (R.extend) { // a selection on a later page finishes a multi-page highlight
    try { const r = contents.window.getSelection().getRangeAt(0); finishExtend(contents, r.endContainer, r.endOffset); } catch (e) {}
    return;
  }
  R.sel = { cfi: cfiRange, contents, text };
  R.editing = null;
  toggleChrome(false);
  showHlBar(null);
}
function showHlBar(hl) {
  const bar = $('.hlbar', R.el);
  $('[data-hl="extend"]', bar).hidden = !!hl;
  $$('.dot', bar).forEach((d) => d.setAttribute('aria-pressed', hl && d.dataset.color === hl.color ? 'true' : 'false'));
  $('[data-hl="delete"]', bar).hidden = !hl;
  bar.classList.add('on');
}
function hideHlBar() { if (!R) return; $('.hlbar', R.el).classList.remove('on'); R.editing = null; }
function clearSelection() { try { R.sel?.contents.window.getSelection().removeAllRanges(); } catch (e) {} R.sel = null; }

async function createHighlight(color, quiet, given) {
  const src = given || R.sel;
  if (!src) return null;
  const { cfi, text } = src;
  let exact = text;
  if (!given) { try { const range = await R.book.getRange(cfi); if (range) exact = range.toString().trim() || text; } catch (e) {} }
  const sec = R.book.spine.get(cfi);
  const hl = {
    id: uid(), bookId: R.rec.id, type: 'highlight', cfi, text: exact, note: '', color,
    chapter: sec ? chapterFor(sec.href) : '', createdAt: Date.now(), sentAt: null,
    percent: R.locReady ? R.book.locations.percentageFromCfi(cfi) : null,
  };
  await db.put('highlights', hl);
  R.highlights.push(hl); R.highlights.sort((a, b) => cmpCfi(a.cfi, b.cfi));
  drawHighlight(hl);
  saveSettings({ lastColor: color });
  clearSelection();
  if (!quiet) hideHlBar();
  return hl;
}
/* ── highlights that run across pages ──
   Start from a selection, turn pages freely, then tap the last word (or select text) on a later page. */
function startExtend() {
  if (!R.sel) return;
  const { cfi, contents } = R.sel;
  let start;
  try { const r = contents.window.getSelection().getRangeAt(0); start = { node: r.startContainer, offset: r.startOffset }; } catch (e) { return; }
  R.extend = { cfi, contents, start };
  try { R.rendition.annotations.underline(cfi, {}, null, 'q-start', { stroke: '#D6B66B', 'stroke-width': '3', 'stroke-opacity': '0.9' }); } catch (e) {}
  clearSelection(); hideHlBar();
  R.el.classList.add('extending');
}
function cancelExtend() {
  if (!R || !R.extend) return;
  try { R.rendition.annotations.remove(R.extend.cfi, 'underline'); } catch (e) {}
  R.extend = null; R.el.classList.remove('extending');
}
function caretAt(doc, x, y) {
  if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); return r && { node: r.startContainer, offset: r.startOffset }; }
  if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); return p && { node: p.offsetNode, offset: p.offset }; }
  return null;
}
async function finishExtend(contents, node, offset) {
  const ex = R.extend; if (!ex) return;
  if (contents.document !== ex.contents.document) { toast('A highlight can run across pages within one chapter'); return; }
  // stretch the end to the end of the tapped word
  if (node && node.nodeType === 3) { const t = node.textContent; while (offset < t.length && !/\s/.test(t[offset])) offset++; }
  const doc = contents.document; const r = doc.createRange();
  try {
    r.setStart(ex.start.node, ex.start.offset); r.setEnd(node, offset);
    if (r.collapsed) { r.setStart(node, offset); r.setEnd(ex.start.node, ex.start.offset); }
  } catch (e) { toast('Tap a word after where the highlight starts'); return; }
  const text = r.toString().replace(/\s+/g, ' ').trim();
  if (!text) { toast('Tap a word after where the highlight starts'); return; }
  let cfi; try { cfi = contents.cfiFromRange(r); } catch (e) { toast('That passage could not be highlighted'); return; }
  cancelExtend();
  try { contents.window.getSelection().removeAllRanges(); } catch (e) {}
  const hl = await createHighlight(settings.lastColor || 'amber', true, { cfi, text });
  haptic(); toast('Highlighted across pages');
  if (hl) { R.editing = hl; showHlBar(hl); }
}

function editHighlight(id) {
  const hl = R.highlights.find((x) => x.id === id); if (!hl) return;
  toggleChrome(false);
  R.editing = hl; showHlBar(hl);
}
async function recolor(hl, color) {
  hl.color = color; hl.sentAt = hl.sentAt; await db.put('highlights', hl); drawHighlight(hl);
  $$('.hlbar .dot', R.el).forEach((d) => d.setAttribute('aria-pressed', d.dataset.color === color ? 'true' : 'false'));
  setTimeout(hideHlBar, 250);
}
async function deleteHighlight(hl) {
  try { R.rendition.annotations.remove(hl.cfi, 'highlight'); } catch (e) {}
  await db.del('highlights', hl.id);
  R.highlights = R.highlights.filter((x) => x.id !== hl.id);
  hideHlBar(); toast('Highlight removed');
}
function editNote(hl) {
  hideHlBar();
  const s = openSheet(`<h3>Note</h3><p class="lead" style="font-family:var(--f-read);font-style:italic">“${esc(hl.text.length > 220 ? hl.text.slice(0, 220) + '…' : hl.text)}”</p>
    <textarea class="input" rows="5" placeholder="What does this make you think?">${esc(hl.note || '')}</textarea>
    <div class="actions"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn" data-a="save">Save note</button></div>`, { root: R.el });
  const ta = $('textarea', s.el); setTimeout(() => ta.focus(), 350);
  s.el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'save') { hl.note = ta.value.trim(); await db.put('highlights', hl); toast(hl.note ? 'Note saved' : 'Note removed'); }
    s.close();
  });
}

/* ───────────────────────────── bookmarks ───────────────────────────── */
function bookmarkHere() {
  const cur = R.rendition.currentLocation(); if (!cur || !cur.start) return null;
  return R.bookmarks.find((b) => cmpCfi(b.cfi, cur.start.cfi) >= 0 && cmpCfi(b.cfi, cur.end.cfi) <= 0);
}
function updateBookmarkIcon() { if (!R) return; $('[data-act="bookmark"]', R.el).classList.toggle('on', !!bookmarkHere()); }
async function toggleBookmark() {
  const b = bookmarkHere();
  if (b) { await db.del('highlights', b.id); R.bookmarks = R.bookmarks.filter((x) => x !== b); toast('Bookmark removed'); }
  else {
    const cur = R.rendition.currentLocation(); if (!cur || !cur.start) return;
    let snippet = '';
    try { const r = await R.book.getRange(cur.start.cfi); snippet = (r.startContainer.textContent || '').trim().slice(0, 140); } catch (e) {}
    const bm = { id: uid(), bookId: R.rec.id, type: 'bookmark', cfi: cur.start.cfi, text: snippet, chapter: chapterFor(cur.start.href), createdAt: Date.now(), percent: R.locReady ? R.book.locations.percentageFromCfi(cur.start.cfi) : null };
    await db.put('highlights', bm); R.bookmarks.push(bm); haptic(); toast('Page bookmarked');
  }
  updateBookmarkIcon();
}

/* ───────────────────────────── sheets ───────────────────────────── */
function showToc() {
  const cur = R.loc ? chapterFor(R.loc.start.href) : '';
  const s = openSheet(`<h3>Contents</h3><ul class="toc">${R.toc.map((t, i) => `<li><button class="${t.depth ? 'sub' : ''} ${t.label === cur ? 'cur' : ''}" data-i="${i}" style="${t.depth > 1 ? `padding-left:${22 + (t.depth - 1) * 14}px` : ''}">${esc(t.label || 'Untitled')}</button></li>`).join('') || '<li class="lead">This book has no table of contents.</li>'}</ul>`, { root: R.el });
  const curBtn = $('.toc .cur', s.el); if (curBtn) setTimeout(() => curBtn.scrollIntoView({ block: 'center' }), 50);
  s.el.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (!b) return; R.rendition.display(R.toc[+b.dataset.i].href); s.close(); toggleChrome(false); });
}

function hlItem(x, extra = '') {
  return `<li class="hl" data-cfi="${esc(x.cfi || '')}" data-id="${x.id || ''}">
    <p>${esc(x.text)}</p>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}
    <div class="meta"><span class="swatch" style="background:${HL[x.color] || 'transparent'}"></span><span class="grow">${esc(x.chapter || '')}${x.percent != null ? ` (${Math.round(x.percent * 100)}%)` : ''}</span>${extra}</div></li>`;
}

async function showNotebook(tab = 'hl') {
  const remote = await marginalia.highlightsForTitle(R.rec.marginaliaTitle || R.rec.title);
  const s = openSheet(`<h3>Notebook</h3>
    <div class="seg" style="margin:6px 0 10px">
      <button data-tab="hl" aria-pressed="${tab === 'hl'}">Highlights ${R.highlights.length || ''}</button>
      <button data-tab="bm" aria-pressed="${tab === 'bm'}">Bookmarks ${R.bookmarks.length || ''}</button>
      ${remote.length ? `<button data-tab="kindle" aria-pressed="${tab === 'kindle'}">Kindle ${remote.length}</button>` : ''}
    </div><div class="nb-body"></div>`, { root: R.el });
  const body = $('.nb-body', s.el);
  const render = (t) => {
    $$('.seg button', s.el).forEach((b) => b.setAttribute('aria-pressed', b.dataset.tab === t));
    if (t === 'hl') {
      body.innerHTML = R.highlights.length
        ? `<ul class="hl-list">${R.highlights.map((x) => hlItem(x, `<button data-note="${x.id}" aria-label="Edit note">${icon('pen')}</button>`)).join('')}</ul>
           <div class="actions" style="margin-top:16px"><button class="btn ghost wide" data-send>${icon('send')} Send to Marginalia</button></div>`
        : `<p class="lead" style="padding:24px 0">Press and hold on any passage to highlight it. Your highlights collect here, ready to send to Marginalia.</p>`;
    } else if (t === 'bm') {
      body.innerHTML = R.bookmarks.length ? `<ul class="hl-list">${R.bookmarks.sort((a, b) => cmpCfi(a.cfi, b.cfi)).map((x) => hlItem(x)).join('')}</ul>` : `<p class="lead" style="padding:24px 0">Tap the ribbon at the top of any page to bookmark it.</p>`;
    } else {
      body.innerHTML = `<p class="lead">Highlights from your Kindle, stored in Marginalia. Tap one to find it in this edition.</p><ul class="hl-list">${remote.map((x, i) => `<li class="hl" data-kindle="${i}"><p>${esc(x.text)}</p><div class="meta"><span class="grow">${esc([x.section, x.page && 'p. ' + x.page].filter(Boolean).join(', '))}</span></div></li>`).join('')}</ul>`;
    }
  };
  render(tab);
  s.el.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]'); if (tb) return render(tb.dataset.tab);
    const nb = e.target.closest('[data-note]'); if (nb) { const hl = R.highlights.find((x) => x.id === nb.dataset.note); s.close(); return editNote(hl); }
    if (e.target.closest('[data-send]')) { s.close(); return sendToMarginalia(); }
    const k = e.target.closest('[data-kindle]');
    if (k) { s.close(); return findAndShow(remote[+k.dataset.kindle].text); }
    const li = e.target.closest('[data-cfi]'); if (li && li.dataset.cfi) { s.close(); toggleChrome(false); R.rendition.display(li.dataset.cfi); }
  });
}

function stepper(label, key, val, fmt) { return `<div class="stepper"><span class="lab">${label}</span><button data-step="${key}" data-d="-1" aria-label="Decrease ${label}">−</button><span class="val" data-val="${key}">${fmt(val)}</span><button data-step="${key}" data-d="1" aria-label="Increase ${label}">+</button></div>`; }
const STEPS = {
  fontSize: { min: 70, max: 220, by: 10, fmt: (v) => v + '%' },
  lineHeight: { min: 1.2, max: 2.2, by: 0.1, fmt: (v) => v.toFixed(1) },
  margin: { min: 6, max: 60, by: 6, fmt: (v) => v + ' pt' },
};
function showTypeSheet() {
  const s = openSheet(`<h3>Text &amp; page</h3>
    <div class="themes">${Object.entries(THEMES).map(([k, t]) => `<button data-theme="${k}" aria-pressed="${settings.readerTheme === k}" style="background:${t.bg};color:${t.fg}" aria-label="${t.name}">Aa</button>`).join('')}</div>
    <div class="fonts">${Object.entries(FONTS).map(([k, f]) => `<button data-font="${k}" aria-pressed="${settings.font === k}" style="font-family:${f.css || 'inherit'}">Ag<small>${f.label}</small></button>`).join('')}</div>
    ${stepper('Size', 'fontSize', settings.fontSize, STEPS.fontSize.fmt)}
    ${stepper('Line spacing', 'lineHeight', settings.lineHeight, STEPS.lineHeight.fmt)}
    ${stepper('Margins', 'margin', settings.margin, STEPS.margin.fmt)}
    <div class="toggle-row"><span>Justify text</span><button class="switch" role="switch" data-sw="justify" aria-checked="${settings.justify}" aria-label="Justify text"></button></div>
    <div class="toggle-row"><span>Hyphenate words</span><button class="switch" role="switch" data-sw="hyphenate" aria-checked="${settings.hyphenate}" aria-label="Hyphenate"></button></div>`, { root: R.el });
  s.el.addEventListener('click', (e) => {
    const th = e.target.closest('[data-theme]'), fo = e.target.closest('[data-font]'), st = e.target.closest('[data-step]'), sw = e.target.closest('[data-sw]');
    if (th) { saveSettings({ readerTheme: th.dataset.theme }); $$('[data-theme]', s.el).forEach((b) => b.setAttribute('aria-pressed', b === th)); applyChromeVars(R.el); restyle(false); redrawAll(); }
    if (fo) { saveSettings({ font: fo.dataset.font }); $$('[data-font]', s.el).forEach((b) => b.setAttribute('aria-pressed', b === fo)); restyle(true); }
    if (st) {
      const k = st.dataset.step, c = STEPS[k];
      const v = Math.round(Math.min(c.max, Math.max(c.min, settings[k] + c.by * +st.dataset.d)) * 10) / 10;
      saveSettings({ [k]: v }); $(`[data-val="${k}"]`, s.el).textContent = c.fmt(v);
      if (k === 'margin') { applyChromeVars(R.el); relayout(); } else restyle(true);
    }
    if (sw) { const k = sw.dataset.sw; saveSettings({ [k]: !settings[k] }); sw.setAttribute('aria-checked', settings[k]); restyle(true); }
  });
}

function restyle(reflow) {
  R.rendition.getContents().forEach(injectStyle);
  if (reflow) relayout();
}
let relayoutTimer;
function relayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(async () => {
    if (!R) return;
    const cfi = R.loc?.start?.cfi;
    try { R.rendition.resize(); } catch (e) {}
    try { R.rendition.manager.clear(); } catch (e) {}
    await R.rendition.display(cfi);
    redrawAll();
    // pages moved: cached locations still valid (they are CFIs), only the display changed
  }, 220);
}

function showSearch() {
  const s = openSheet(`<h3>Search</h3>
    <label class="search" style="margin:4px 0 6px">${icon('search')}<input type="search" placeholder="Words or a phrase" enterkeyhint="search" autocomplete="off"></label>
    <p class="lead s-status" style="margin:10px 2px 0;font-size:13px"></p><ul class="hl-list s-res"></ul>`, { root: R.el });
  const input = $('input', s.el), res = $('.s-res', s.el), status = $('.s-status', s.el);
  setTimeout(() => input.focus(), 300);
  let token = 0;
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    input.blur();
    const q = input.value.trim(); if (q.length < 2) return;
    const my = ++token; res.innerHTML = ''; let n = 0;
    status.innerHTML = '<span class="progress-ring"></span> Searching';
    const items = R.book.spine.spineItems;
    for (let i = 0; i < items.length && my === token; i++) {
      const it = items[i];
      try {
        await it.load(R.book.load.bind(R.book));
        const found = it.find(q); it.unload();
        const chap = chapterFor(it.href);
        found.slice(0, 60).forEach((f) => {
          if (n >= 300) return; n++;
          const ex = esc(f.excerpt).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => `<mark class="q">${m}</mark>`);
          res.insertAdjacentHTML('beforeend', `<li class="hl" data-cfi="${esc(f.cfi)}"><p style="font-size:16px">${ex}</p><div class="meta"><span class="grow">${esc(chap)}</span></div></li>`);
        });
      } catch (err) {}
    }
    if (my === token) status.textContent = n ? `${plural(n, 'result')}` : 'No matches in this book.';
  });
  res.addEventListener('click', (e) => { const li = e.target.closest('[data-cfi]'); if (!li) return; s.close(); toggleChrome(false); flash(li.dataset.cfi); });
}

async function flash(cfi) {
  await R.rendition.display(cfi);
  try {
    R.rendition.annotations.underline(cfi, {}, null, 'q-flash', { stroke: '#D6B66B', 'stroke-width': '3', 'stroke-opacity': '0.95' });
    setTimeout(() => { try { R.rendition.annotations.remove(cfi, 'underline'); } catch (e) {} }, 4000);
  } catch (e) {}
}

async function findAndShow(text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const needles = [words.slice(0, 6).join(' '), words.slice(2, 7).join(' '), words.slice(-5).join(' ')].filter((n) => n.length > 8);
  toast('Finding passage…', 6000);
  for (const it of R.book.spine.spineItems) {
    try {
      await it.load(R.book.load.bind(R.book));
      for (const n of needles) { const f = it.find(n); if (f.length) { it.unload(); toast('Found'); return flash(f[0].cfi); } }
      it.unload();
    } catch (e) {}
  }
  toast('That passage isn’t in this edition.');
}

/* ───────────────────────────── Marginalia ───────────────────────────── */
async function sendToMarginalia() {
  const { openSendSheet } = await import('./marginalia.js');
  openSendSheet(R.rec, { root: R.el });
}

/* ───────────────────────────── close ───────────────────────────── */
export async function closeReader() {
  if (!R) return;
  const r = R; R = null;
  clearTimeout(saveTimer);
  if (r.loc) {
    const patch = { loc: r.loc.start.cfi, openedAt: Date.now() };
    if (r.locReady) patch.progress = r.loc.atEnd ? 1 : r.book.locations.percentageFromCfi(r.loc.start.cfi);
    await db.patch('books', r.rec.id, patch);
  }
  document.removeEventListener('keyup', onKey);
  r.el.style.transition = 'opacity .25s'; r.el.style.opacity = '0';
  document.body.classList.remove('reading');
  document.documentElement.style.backgroundColor = ''; document.body.style.backgroundColor = '';
  const m = document.querySelector('meta[name="theme-color"]:not([media])'); if (m) m.remove();
  setTimeout(() => { try { r.book.destroy(); } catch (e) {} r.el.remove(); }, 260);
  r.onClose && r.onClose();
}
export function readerOpen() { return !!R; }
void similarity; void confirmSheet;
