// Shared helpers: DOM, sheets, toasts, script loading, covers, colours.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const icon = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function haptic() { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} }

/* ── scripts ── */
const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}
export async function needEpub() { await loadScript('vendor/epub.min.js'); return window.ePub; }
export async function needPdf() {
  await loadScript('vendor/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return window.pdfjsLib;
}
export async function needMammoth() { await loadScript('vendor/mammoth.browser.min.js'); return window.mammoth; }
let archiveMod;
export async function needArchive() {
  if (!archiveMod) {
    archiveMod = import('../vendor/libarchive/libarchive.js').then((m) => {
      m.Archive.init({ workerUrl: new URL('../vendor/libarchive/worker-bundle.js', import.meta.url).href });
      return m.Archive;
    });
  }
  return archiveMod;
}

/* ── toast ── */
let toastTimer;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ── bottom sheets ── */
const sheetStack = [];
export function openSheet(html, { root, onClose } = {}) {
  const host = root || $('#sheet-root');
  const scrim = h('<div class="scrim"></div>');
  const sheet = h(`<div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div></div>`);
  if (typeof html === 'string') sheet.insertAdjacentHTML('beforeend', html); else sheet.appendChild(html);
  host.append(scrim, sheet);
  const api = {
    el: sheet,
    close() {
      if (api.closed) return; api.closed = true;
      scrim.classList.remove('on'); sheet.classList.remove('on');
      setTimeout(() => { scrim.remove(); sheet.remove(); }, 380);
      const i = sheetStack.indexOf(api); if (i >= 0) sheetStack.splice(i, 1);
      onClose && onClose();
    },
  };
  scrim.addEventListener('click', api.close);
  // drag-to-dismiss on the grabber zone
  let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0 && e.touches[0].clientY - sheet.getBoundingClientRect().top < 60) { y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; } }, { passive: true });
  sheet.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sheet.addEventListener('touchend', () => { if (y0 == null) return; sheet.style.transition = ''; sheet.style.transform = ''; if (dy > 90) api.close(); y0 = null; });
  requestAnimationFrame(() => requestAnimationFrame(() => { scrim.classList.add('on'); sheet.classList.add('on'); }));
  sheetStack.push(api);
  return api;
}
export function closeAllSheets() { [...sheetStack].forEach((s) => s.close()); }
export function topSheet() { return sheetStack[sheetStack.length - 1]; }

export function confirmSheet({ title, body, ok = 'OK', danger = false, root }) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet(`<h3>${esc(title)}</h3>${body ? `<p class="lead">${esc(body)}</p>` : ''}
      <div class="actions"><button class="btn ghost" data-a="no">Cancel</button><button class="btn ${danger ? 'danger ghost' : ''}" data-a="yes">${esc(ok)}</button></div>`,
      { root, onClose: () => { if (!done) resolve(false); } });
    s.el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      done = true; resolve(a.dataset.a === 'yes'); s.close();
    });
  });
}

/* ── strings ── */
export function normTitle(t) {
  return String(t || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').split(/[:;—–]| - /)[0].replace(/[^a-z0-9]+/g, ' ').trim();
}
export function similarity(a, b) {
  a = normTitle(a); b = normTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let inter = 0; A.forEach((w) => B.has(w) && inter++);
  return inter / Math.max(A.size, B.size);
}
export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function plural(n, w, p) { return `${n.toLocaleString()} ${n === 1 ? w : (p || w + 's')}`; }
export function fmtBytes(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }
export function natCompare(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
export function relTime(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago'; if (d < 172800) return 'yesterday';
  if (d < 604800) return Math.floor(d / 86400) + ' days ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* ── genre colours (Marginalia's system, re-tuned as cloth) ── */
export const GENRES = [
  { key: 'History', words: ['history', 'histor', 'empire', 'war', 'ancient', 'middle east', 'islam', 'arab', 'persia', 'ottoman', 'politic', 'civiliz'], color: '#7A2E2A' },
  { key: 'Philosophy', words: ['philosoph', 'spiritual', 'stoic', 'religion', 'ethic', 'meaning', 'zen', 'buddh', 'sufi', 'theolog'], color: '#2E4A6B' },
  { key: 'Psychology', words: ['psycholog', 'mind', 'behavio', 'self', 'habit', 'emotion', 'neuro'], color: '#5B3A62' },
  { key: 'Business', words: ['business', 'creativ', 'work', 'money', 'invest', 'trading', 'market', 'econom', 'leader', 'startup', 'finance', 'product'], color: '#2F5B45' },
  { key: 'Science', words: ['science', 'physic', 'biolog', 'evolution', 'chem', 'cosmo', 'tech', 'nature'], color: '#24585A' },
  { key: 'Mathematics', words: ['math', 'statist', 'probab', 'logic', 'number'], color: '#4A4F2A' },
  { key: 'Fiction', words: ['fiction', 'novel', 'stor', 'literat', 'poetry', 'fantasy', 'thriller', 'comic', 'manga', 'graphic'], color: '#8A5A1E' },
  { key: 'Memoir', words: ['memoir', 'biograph', 'autobiog', 'life', 'letters', 'diar'], color: '#6B4A33' },
];
const FALLBACK = ['#3E5A50', '#6A3B3B', '#3B4A6A', '#5E5130', '#4D3A5C', '#2F5560', '#6B5235', '#41503A'];
export function genreColor(category) {
  const c = String(category || '').toLowerCase();
  for (const g of GENRES) if (g.words.some((w) => c.includes(w))) return g.color;
  return FALLBACK[hashStr(c) % FALLBACK.length];
}
export function clothColor(seed) { return FALLBACK.concat(GENRES.map((g) => g.color))[hashStr(String(seed)) % 16]; }

/* ── generated cloth-bound covers ── */
export async function makeCover({ title, author = '', seed, kind = 'book' }) {
  try { await document.fonts.load('40px "Young Serif"'); } catch (e) {}
  const W = 600, H = 900;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const base = clothColor(seed || title);
  x.fillStyle = base; x.fillRect(0, 0, W, H);
  // woven cloth texture
  for (let i = 0; i < 9000; i++) {
    x.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
    x.fillRect(Math.random() * W, Math.random() * H, Math.random() * 3 + 1, 1);
  }
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // gilt frame
  const gold = x.createLinearGradient(0, 0, W, 0);
  gold.addColorStop(0, '#B8913A'); gold.addColorStop(0.5, '#F0D896'); gold.addColorStop(1, '#B8913A');
  x.strokeStyle = gold; x.lineWidth = 3; x.strokeRect(46, 46, W - 92, H - 92);
  x.lineWidth = 1.2; x.strokeRect(58, 58, W - 116, H - 116);
  // title
  x.fillStyle = gold; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  const words = String(title || 'Untitled').split(/\s+/);
  let size = 64, lines;
  for (; size >= 34; size -= 4) {
    x.font = `${size}px "Young Serif", Georgia, serif`;
    lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (x.measureText(t).width > W - 170 && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    if (lines.length <= 5) break;
  }
  lines = lines.slice(0, 6);
  const lh = size * 1.18, top = H * 0.40 - (lines.length * lh) / 2 + size * 0.8;
  lines.forEach((l, i) => x.fillText(l, W / 2, top + i * lh));
  // ornament
  const oy = top + lines.length * lh + 10;
  x.beginPath(); x.moveTo(W / 2 - 50, oy); x.lineTo(W / 2 + 50, oy); x.lineWidth = 1.5; x.stroke();
  x.beginPath(); x.arc(W / 2, oy, 4, 0, Math.PI * 2); x.fill();
  if (author) {
    x.font = `26px "Newsreader", Georgia, serif`;
    x.fillText(String(author).slice(0, 40), W / 2, oy + 54);
  }
  if (kind === 'comic') { x.font = '20px -apple-system, sans-serif'; x.fillText('Comic', W / 2, H - 86); }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
}

export async function shrinkImage(blob, maxW = 600) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, maxW / bmp.width);
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch (e) { return blob; }
}

/* ── object URL cache for covers ── */
const urlCache = new Map();
export function blobUrl(key, blob) {
  if (!blob) return '';
  const hit = urlCache.get(key);
  if (hit && hit.blob === blob) return hit.url;
  if (hit) URL.revokeObjectURL(hit.url);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, { blob, url });
  return url;
}

/* ── save / share a file (works in iOS standalone mode) ── */
export async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); }
  catch (e) { toast('Copy is blocked here'); }
}
export async function shareText(text, title) {
  if (navigator.share) { try { await navigator.share({ text, title }); } catch (e) {} }
  else copyText(text);
}

export function setRange(input) { const p = ((input.value - input.min) / (input.max - input.min || 1)) * 100; input.style.setProperty('--p', p + '%'); }
