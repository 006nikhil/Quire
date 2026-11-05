// Comic & PDF page reader: swipe, tap zones, pinch and double-tap zoom, two-page spreads, manga direction, vertical scroll.
import { $, $$, h, icon, esc, toast, openSheet, clamp, haptic, setRange } from './util.js';
import { db, settings, saveSettings } from './db.js';
import { openSource } from './source.js';

let C = null;

export async function openComic(rec, { onClose } = {}) {
  if (C) closeComic();
  const file = await db.get('files', rec.id);
  if (!file) { toast('This file is missing. Try adding it again.'); return; }
  const el = h(`<div class="comic ${rec.format === 'pdf' ? 'paper' : ''}" role="application" aria-label="${esc(rec.title)}">
    <div class="viewport"><div class="track"><div class="spread"></div><div class="spread"></div><div class="spread"></div></div></div>
    <div class="pageno"></div>
    <div class="loading-veil" style="background:#050505;color:#ddd"><div><div class="t">${esc(rec.title)}</div><div class="s">Opening</div></div></div>
    <div class="rbar top">
      <button class="icon-btn" data-act="close" aria-label="Back to library">${icon('back')}</button>
      <div class="title">${esc(rec.title)}</div>
      <button class="icon-btn" data-act="settings" aria-label="Reading options">${icon('more')}</button>
    </div>
    <div class="rbar bot">
      <div class="thumbs" role="listbox" aria-label="Pages"></div>
      <div class="scrub"><span class="s-a">1</span><input type="range" min="0" max="0" value="0" aria-label="Page"><span class="s-b">1</span></div>
    </div>
  </div>`);
  $('#reader-root').appendChild(el);
  document.body.classList.add('reading');
  document.documentElement.style.backgroundColor = document.body.style.backgroundColor = rec.format === 'pdf' ? '#1d1d1f' : '#050505';

  let src;
  try { src = await openSource(file.blob, rec.format, rec.fileName); }
  catch (e) { console.error(e); el.remove(); document.body.classList.remove('reading'); document.documentElement.style.backgroundColor = document.body.style.backgroundColor = ''; toast(e.message || 'This comic could not be opened.', 4000); return; }

  C = { rec, el, src, onClose, count: src.count, page: clamp(+rec.loc || 0, 0, src.count - 1), urls: new Map(), units: [], u: 0, zoom: { s: 1, x: 0, y: 0 }, thumbs: new Map(), mode: settings.comicMode };
  if (rec.pages !== src.count) db.patch('books', rec.id, { pages: src.count });
  layout();
  wire();
  $('.loading-veil', el).classList.add('gone');
  db.patch('books', rec.id, { openedAt: Date.now() });
  saveSettings({ lastBook: rec.id });
  window.addEventListener('resize', onResize);
}

function onResize() { if (!C) return; const p = C.page; layout(); C.page = p; }

/* ── units: pages grouped into what's on screen at once ── */
function computeUnits() {
  const landscape = window.innerWidth > window.innerHeight && window.innerWidth >= 700;
  const n = C.count, units = [];
  if (settings.comicSpread && landscape && C.rec.format !== 'pdf') {
    units.push([0]);
    for (let i = 1; i < n; i += 2) units.push(i + 1 < n ? [i, i + 1] : [i]);
  } else for (let i = 0; i < n; i++) units.push([i]);
  return units;
}
function unitOf(p) { return Math.max(0, C.units.findIndex((u) => u.includes(p))); }

function layout() {
  const el = C.el;
  el.classList.toggle('fit-width', settings.comicFit === 'width' && C.mode === 'page');
  const vp = $('.viewport', el);
  vp.style.touchAction = settings.comicFit === 'width' && C.mode === 'page' ? 'pan-y' : 'none';
  const old = $('.scroller', el); if (old) old.remove();
  if (C.mode === 'scroll') { $('.track', el).hidden = true; return buildScroller(); }
  $('.track', el).hidden = false;
  C.units = computeUnits();
  C.u = unitOf(C.page);
  renderSlots();
  updateUi();
}

/* ── image URLs, kept for a window around the current page ── */
function url(i) {
  if (i < 0 || i >= C.count) return Promise.resolve(null);
  if (!C.urls.has(i)) C.urls.set(i, C.src.page(i).then((b) => URL.createObjectURL(b)).catch(() => null));
  return C.urls.get(i);
}
function prune() {
  const keep = new Set(); for (let d = -5; d <= 6; d++) keep.add(C.page + d);
  for (const [i, p] of C.urls) if (!keep.has(i)) { p.then((u) => u && URL.revokeObjectURL(u)); C.urls.delete(i); }
}

async function fillSpread(div, unitIdx) {
  div.innerHTML = ''; div.classList.remove('two');
  div.style.transform = '';
  const unit = C.units[unitIdx]; if (!unit) return;
  const order = settings.comicDir === 'rtl' ? [...unit].reverse() : unit;
  div.classList.toggle('two', unit.length === 2);
  const token = (div._t = (div._t || 0) + 1);
  const imgs = await Promise.all(order.map(url));
  if (div._t !== token) return;
  imgs.forEach((u) => { if (!u) return; const im = new Image(); im.decoding = 'async'; im.src = u; im.alt = ''; div.appendChild(im); });
  if (settings.comicFit === 'width') { div.style.overflowY = 'auto'; div.style.height = '100%'; div.scrollTop = 0; }
}

function slots() { return $$('.track > .spread', C.el); }
function renderSlots() {
  const [a, b, c] = slots(); const rtl = settings.comicDir === 'rtl';
  // slot order on screen: [left, centre, right]; "next" is to the right unless manga
  fillSpread(b, C.u);
  fillSpread(a, rtl ? C.u + 1 : C.u - 1);
  fillSpread(c, rtl ? C.u - 1 : C.u + 1);
  setTrack(0, false);
  resetZoom();
  for (let d = 2; d <= 3; d++) { const u = C.units[C.u + d]; if (u) u.forEach(url); }
  prune();
}
function setTrack(dx, animate) {
  const t = $('.track', C.el);
  t.style.transition = animate ? 'transform .34s cubic-bezier(.2,.8,.2,1)' : 'none';
  t.style.transform = `translate3d(calc(-100% + ${dx}px),0,0)`;
}

function go(delta) {
  const nu = C.u + delta;
  if (nu < 0 || nu >= C.units.length) { setTrack(0, true); if (nu >= C.units.length) toast('That’s the last page'); return; }
  const rtl = settings.comicDir === 'rtl';
  const dir = (delta > 0) !== rtl ? -1 : 1; // -1 slides left
  setTrack(dir * window.innerWidth, true);
  C.u = nu; C.page = C.units[nu][0];
  setTimeout(() => { if (C) { renderSlots(); updateUi(); } }, 330);
  save();
}
function next() { go(1); }
function prev() { go(-1); }
function jump(page) {
  C.page = clamp(page, 0, C.count - 1);
  if (C.mode === 'scroll') { const im = $$('.scroller img', C.el)[C.page]; im && im.scrollIntoView(); }
  else { C.u = unitOf(C.page); renderSlots(); }
  updateUi(); save();
}

let saveT;
function save() {
  clearTimeout(saveT);
  const id = C.rec.id, p = C.page, n = C.count;
  saveT = setTimeout(() => db.patch('books', id, { loc: p, progress: n > 1 ? p / (n - 1) : 1, finished: p >= n - 1 || undefined, openedAt: Date.now() }), 300);
}

function updateUi() {
  const el = C.el;
  const unit = C.mode === 'page' ? C.units[C.u] : [C.page];
  const label = unit.length === 2 ? `${unit[0] + 1}–${unit[1] + 1}` : `${unit[0] + 1}`;
  $('.pageno', el).textContent = `${label} of ${C.count}`;
  const r = $('.scrub input', el); r.max = C.count - 1; r.value = C.page; setRange(r);
  r.style.direction = settings.comicDir === 'rtl' ? 'rtl' : 'ltr';
  $('.s-a', el).textContent = C.page + 1; $('.s-b', el).textContent = C.count;
  if (el.classList.contains('chrome')) markThumb();
}

/* ── vertical scroll (webtoon) mode ── */
function buildScroller() {
  const sc = h('<div class="scroller"></div>');
  for (let i = 0; i < C.count; i++) sc.appendChild(Object.assign(document.createElement('img'), { alt: '', loading: 'lazy' }));
  $('.viewport', C.el).after(sc);
  const imgs = [...sc.children];
  const io = new IntersectionObserver((ents) => ents.forEach((en) => {
    const i = imgs.indexOf(en.target);
    if (en.isIntersecting && !en.target.src) url(i).then((u) => { if (u) en.target.src = u; });
  }), { root: sc, rootMargin: '200% 0px' });
  imgs.forEach((im) => io.observe(im));
  C.io = io;
  let t; sc.addEventListener('scroll', () => {
    clearTimeout(t); t = setTimeout(() => {
      const mid = sc.scrollTop + sc.clientHeight / 3;
      let i = imgs.findIndex((im) => im.offsetTop + im.offsetHeight > mid); if (i < 0) i = C.count - 1;
      if (i !== C.page) { C.page = i; updateUi(); save(); }
      // release far images
      imgs.forEach((im, j) => { if (Math.abs(j - i) > 8 && im.src) { im.removeAttribute('src'); } });
      prune();
    }, 120);
  }, { passive: true });
  sc.addEventListener('click', (e) => { const x = e.clientX / window.innerWidth; if (x > 0.3 && x < 0.7) toggleChrome(); });
  requestAnimationFrame(() => { const im = imgs[C.page]; if (im) sc.scrollTop = im.offsetTop; });
  updateUi();
}

/* ── zoom ── */
function cur() { return slots()[1]; }
function applyZoom(animate) {
  const z = C.zoom, s = cur();
  s.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
  s.style.transform = z.s === 1 ? '' : `translate3d(${z.x}px,${z.y}px,0) scale(${z.s})`;
}
function resetZoom() { C.zoom = { s: 1, x: 0, y: 0 }; const s = cur(); if (s) s.style.transform = ''; }
function clampZoom() {
  const z = C.zoom, W = window.innerWidth, H = window.innerHeight;
  z.s = clamp(z.s, 1, 5);
  z.x = clamp(z.x, W - W * z.s, 0); z.y = clamp(z.y, H - H * z.s, 0);
  if (z.s === 1) { z.x = 0; z.y = 0; }
}
function zoomAt(px, py, s) {
  const z = C.zoom; const k = s / z.s;
  z.x = px - (px - z.x) * k; z.y = py - (py - z.y) * k; z.s = s; clampZoom();
}

/* ── gestures ── */
function wire() {
  const el = C.el, vp = $('.viewport', el);
  let start = null, pinch = null, lastTap = 0, tapTimer = null, panning = false;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  vp.addEventListener('touchstart', (e) => {
    if (C.mode !== 'page') return;
    if (e.touches.length === 2) {
      const t = e.touches; pinch = { d: dist(t), s: C.zoom.s, cx: (t[0].clientX + t[1].clientX) / 2, cy: (t[0].clientY + t[1].clientY) / 2, x: C.zoom.x, y: C.zoom.y };
      start = null; return;
    }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, t: Date.now(), zx: C.zoom.x, zy: C.zoom.y, moved: false };
    panning = C.zoom.s > 1;
  }, { passive: true });

  vp.addEventListener('touchmove', (e) => {
    if (C.mode !== 'page') return;
    if (pinch && e.touches.length === 2) {
      const t = e.touches; const s = clamp(pinch.s * dist(t) / pinch.d, 1, 5);
      const cx = (t[0].clientX + t[1].clientX) / 2, cy = (t[0].clientY + t[1].clientY) / 2;
      const k = s / pinch.s;
      C.zoom.s = s; C.zoom.x = cx - (pinch.cx - pinch.x) * k; C.zoom.y = cy - (pinch.cy - pinch.y) * k;
      applyZoom(false); return;
    }
    if (!start) return;
    const t = e.touches[0]; const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) start.moved = true;
    if (panning) { C.zoom.x = start.zx + dx; C.zoom.y = start.zy + dy; clampZoom(); applyZoom(false); }
    else if (settings.comicFit !== 'width' || Math.abs(dx) > Math.abs(dy)) {
      if (start.horiz == null && start.moved) start.horiz = Math.abs(dx) > Math.abs(dy);
      if (start.horiz) setTrack(dx * (atEdge(dx) ? 0.35 : 1), false);
    }
  }, { passive: true });

  vp.addEventListener('touchend', (e) => {
    if (C.mode !== 'page') return;
    if (pinch) { if (e.touches.length < 2) { clampZoom(); applyZoom(true); pinch = null; } return; }
    if (!start) return;
    const t = e.changedTouches[0]; const dx = t.clientX - start.x, dt = Date.now() - start.t;
    const s = start; start = null;
    if (panning) return;
    if (s.horiz) {
      const fast = Math.abs(dx) / dt > 0.4;
      if (Math.abs(dx) > window.innerWidth * 0.22 || (fast && Math.abs(dx) > 30)) {
        const rtl = settings.comicDir === 'rtl';
        (dx < 0) !== rtl ? next() : prev();
      } else setTrack(0, true);
      return;
    }
    if (s.moved) return;
    // tap or double tap
    const now = Date.now();
    if (now - lastTap < 280) { clearTimeout(tapTimer); lastTap = 0; haptic();
      if (C.zoom.s > 1) { resetZoom(); applyZoom(true); } else { zoomAt(t.clientX, t.clientY, 2.5); applyZoom(true); }
      return; }
    lastTap = now;
    const x = t.clientX / window.innerWidth;
    tapTimer = setTimeout(() => handleTap(x), 260);
  });

  // desktop
  vp.addEventListener('click', (e) => { if (e.pointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents) return; if (C.mode === 'page') handleTap(e.clientX / window.innerWidth); });
  vp.addEventListener('wheel', (e) => { if (C.mode !== 'page' || settings.comicFit === 'width') return; e.preventDefault(); if (Math.abs(e.deltaX) + Math.abs(e.deltaY) > 30) (e.deltaY || e.deltaX) > 0 ? next() : prev(); }, { passive: false });

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'close') closeComic();
    if (a === 'settings') showOptions();
    const th = e.target.closest('[data-p]'); if (th) jump(+th.dataset.p);
  });
  const r = $('.scrub input', el);
  r.addEventListener('input', () => { setRange(r); $('.s-a', el).textContent = +r.value + 1; });
  r.addEventListener('change', () => jump(+r.value));
  document.addEventListener('keydown', onKey);
}
function atEdge(dx) {
  const rtl = settings.comicDir === 'rtl'; const forward = (dx < 0) !== rtl;
  return forward ? C.u >= C.units.length - 1 : C.u <= 0;
}
function handleTap(x) {
  if (C.zoom.s > 1) return toggleChrome();
  const rtl = settings.comicDir === 'rtl';
  if (x < 0.28) { toggleChrome(false); rtl ? next() : prev(); }
  else if (x > 0.72) { toggleChrome(false); rtl ? prev() : next(); }
  else toggleChrome();
}
function onKey(e) {
  if (!C) return;
  const rtl = settings.comicDir === 'rtl';
  if (e.key === 'ArrowRight') rtl ? prev() : next();
  if (e.key === 'ArrowLeft') rtl ? next() : prev();
  if (e.key === ' ') next();
  if (e.key === 'Escape') closeComic();
}

/* ── chrome & thumbnails ── */
function toggleChrome(force) {
  const on = force ?? !C.el.classList.contains('chrome');
  C.el.classList.toggle('chrome', on);
  if (on) buildThumbs();
}
function buildThumbs() {
  const strip = $('.thumbs', C.el);
  if (!strip.children.length) {
    for (let i = 0; i < C.count; i++) strip.insertAdjacentHTML('beforeend', `<button data-p="${i}" aria-label="Page ${i + 1}"><span>${i + 1}</span></button>`);
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) thumb(+en.target.dataset.p, en.target); }), { root: strip, rootMargin: '0px 300px' });
    [...strip.children].forEach((b) => io.observe(b));
    C.tio = io;
  }
  markThumb();
}
async function thumb(i, btn) {
  if (btn.querySelector('img') || C.thumbs.has(i)) return;
  C.thumbs.set(i, true);
  try {
    const blob = C.rec.format === 'pdf' ? await C.src.page(i, 160) : await C.src.page(i);
    const bmp = await createImageBitmap(blob, { resizeWidth: 120, resizeQuality: 'medium' });
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
    const im = new Image(); im.src = c.toDataURL('image/jpeg', 0.7); im.alt = ''; btn.prepend(im);
  } catch (e) {}
}
function markThumb() {
  const strip = $('.thumbs', C.el);
  $$('.cur', strip).forEach((b) => b.classList.remove('cur'));
  const b = strip.children[C.page]; if (b) { b.classList.add('cur'); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
}

function showOptions() {
  const s = openSheet(`<h3>Reading options</h3>
    <p class="glabel">Layout</p>
    <div class="seg" style="margin-bottom:8px"><button data-o="mode" data-v="page" aria-pressed="${C.mode === 'page'}">Pages</button><button data-o="mode" data-v="scroll" aria-pressed="${C.mode === 'scroll'}">Vertical scroll</button></div>
    <p class="glabel">Fit</p>
    <div class="seg" style="margin-bottom:8px"><button data-o="fit" data-v="screen" aria-pressed="${settings.comicFit === 'screen'}">Whole page</button><button data-o="fit" data-v="width" aria-pressed="${settings.comicFit === 'width'}">Fill width</button></div>
    <p class="glabel">Reading direction</p>
    <div class="seg" style="margin-bottom:8px"><button data-o="dir" data-v="ltr" aria-pressed="${settings.comicDir === 'ltr'}">Left to right</button><button data-o="dir" data-v="rtl" aria-pressed="${settings.comicDir === 'rtl'}">Right to left (manga)</button></div>
    <div class="toggle-row" style="margin-top:10px"><span>Two-page spreads in landscape</span><button class="switch" role="switch" data-sw aria-checked="${settings.comicSpread}" aria-label="Two-page spreads"></button></div>`, { root: C.el });
  s.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-o]');
    if (b) {
      const o = b.dataset.o, v = b.dataset.v;
      if (o === 'mode') { C.mode = v; saveSettings({ comicMode: v }); }
      if (o === 'fit') saveSettings({ comicFit: v });
      if (o === 'dir') saveSettings({ comicDir: v });
      $$(`[data-o="${o}"]`, s.el).forEach((x) => x.setAttribute('aria-pressed', x === b));
      layout();
    }
    const sw = e.target.closest('[data-sw]');
    if (sw) { saveSettings({ comicSpread: !settings.comicSpread }); sw.setAttribute('aria-checked', settings.comicSpread); layout(); }
  });
}

export function closeComic() {
  if (!C) return;
  const c = C; C = null;
  clearTimeout(saveT);
  db.patch('books', c.rec.id, { loc: c.page, progress: c.count > 1 ? c.page / (c.count - 1) : 1, openedAt: Date.now(), finished: c.page >= c.count - 1 || undefined });
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
  c.io && c.io.disconnect(); c.tio && c.tio.disconnect();
  document.body.classList.remove('reading');
  document.documentElement.style.backgroundColor = ''; document.body.style.backgroundColor = '';
  c.el.style.transition = 'opacity .25s'; c.el.style.opacity = '0';
  setTimeout(() => { c.el.remove(); for (const p of c.urls.values()) p.then((u) => u && URL.revokeObjectURL(u)); c.src.close(); }, 260);
  c.onClose && c.onClose();
}
