// Document → EPUB 3. Handles TXT, Markdown, HTML, DOCX, RTF, FB2 and PDF (text).
import { needMammoth, needPdf, makeCover, uid, esc } from './util.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/* ───────────── parsing to an HTML body ───────────── */
function baseName(n) { return n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function textToHtml(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  // paragraphs are separated by blank lines; if a file has none, each line is a paragraph
  const blank = lines.filter((l) => !l.trim()).length;
  const paras = [];
  if (blank > lines.length * 0.05) {
    let cur = [];
    for (const l of lines) { if (!l.trim()) { if (cur.length) paras.push(cur.join(' ')); cur = []; } else cur.push(l.trim()); }
    if (cur.length) paras.push(cur.join(' '));
  } else lines.forEach((l) => l.trim() && paras.push(l.trim()));
  const isHead = (p) => p.length < 80 && !/[.,;]$/.test(p) && (/^(chapter|part|book|section|prologue|epilogue|introduction|preface|afterword|appendix)\b/i.test(p) || (/^[A-Z0-9 '’:\-–—.!?]+$/.test(p) && /[A-Z]{3}/.test(p)) || /^[IVXLC]+\.?$/.test(p));
  return paras.map((p) => isHead(p) ? `<h2>${esc(p)}</h2>` : `<p>${esc(p)}</p>`).join('\n');
}

function inlineMd(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => `<strong>${a || b}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
}
function mdToHtml(md) {
  const L = md.replace(/\r\n?/g, '\n').split('\n'); const out = []; let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inlineMd(m[2].replace(/#+\s*$/, ''))}</h${m[1].length}>`); i++; continue; }
    if (/^```/.test(l)) { const buf = []; i++; while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { out.push('<hr/>'); i++; continue; }
    if (/^>\s?/.test(l)) { const buf = []; while (i < L.length && /^>\s?/.test(L[i])) buf.push(L[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l); const items = [];
      while (i < L.length && /^\s*([-*+]|\d+[.)])\s+/.test(L[i])) items.push(L[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    const buf = []; while (i < L.length && L[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(L[i])) buf.push(L[i++].trim());
    out.push(`<p>${inlineMd(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

function rtfToText(rtf) {
  let s = rtf.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\s*\}/g, '')
    .replace(/\\par[d]?\b/g, '\n\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (m, hx) => String.fromCharCode(parseInt(hx, 16)))
    .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  return s.replace(/\n{3,}/g, '\n\n');
}

function fb2ToHtml(xml) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const get = (sel) => d.querySelector(sel);
  const title = get('title-info book-title')?.textContent?.trim();
  const a = get('title-info author');
  const author = a ? [a.querySelector('first-name')?.textContent, a.querySelector('last-name')?.textContent].filter(Boolean).join(' ') : '';
  const bins = {}; d.querySelectorAll('binary').forEach((b) => { bins[b.getAttribute('id')] = `data:${b.getAttribute('content-type') || 'image/jpeg'};base64,${b.textContent.replace(/\s+/g, '')}`; });
  const conv = (n, depth) => {
    let out = '';
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) { out += esc(c.textContent); return; }
      const t = c.localName;
      if (t === 'section') out += conv(c, depth + 1);
      else if (t === 'title') out += `<h${Math.min(depth + 1, 4)}>${esc(c.textContent.trim())}</h${Math.min(depth + 1, 4)}>`;
      else if (t === 'p') out += `<p>${conv(c, depth)}</p>`;
      else if (t === 'emphasis') out += `<em>${conv(c, depth)}</em>`;
      else if (t === 'strong') out += `<strong>${conv(c, depth)}</strong>`;
      else if (t === 'empty-line') out += '<p>&#160;</p>';
      else if (t === 'epigraph' || t === 'cite') out += `<blockquote>${conv(c, depth)}</blockquote>`;
      else if (t === 'poem' || t === 'stanza') out += `<div class="poem">${conv(c, depth)}</div>`;
      else if (t === 'v') out += `<p class="verse">${conv(c, depth)}</p>`;
      else if (t === 'image') { const id = (c.getAttribute('l:href') || c.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '').replace('#', ''); if (bins[id]) out += `<img src="${bins[id]}" alt=""/>`; }
      else out += conv(c, depth);
    });
    return out;
  };
  const bodies = [...d.querySelectorAll('body')].filter((b) => b.getAttribute('name') !== 'notes');
  const coverId = (get('title-info coverpage image')?.getAttribute('l:href') || '').replace('#', '');
  return { html: bodies.map((b) => conv(b, 0)).join('\n'), title, author, coverData: bins[coverId] };
}

async function pdfToHtml(blob, onProgress) {
  const pdfjs = await needPdf();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const meta = await doc.getMetadata().catch(() => ({}));
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const vh = page.getViewport({ scale: 1 }).height;
    const lines = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5]), x = it.transform[4], hgt = Math.abs(it.transform[3]) || it.height || 10;
      let ln = lines.find((l) => Math.abs(l.y - y) < hgt * 0.5);
      if (!ln) { ln = { y, x, h: hgt, parts: [] }; lines.push(ln); }
      ln.parts.push({ x, s: it.str }); ln.h = Math.max(ln.h, hgt); ln.x = Math.min(ln.x, x);
    }
    lines.sort((a, b) => b.y - a.y);
    lines.forEach((l) => { l.text = l.parts.sort((a, b) => a.x - b.x).map((q) => q.s).join('').replace(/\s+/g, ' ').trim(); l.rel = l.y / vh; });
    pages.push(lines.filter((l) => l.text));
    page.cleanup();
    onProgress && onProgress(p / doc.numPages);
  }
  // remove running heads / folios repeated on many pages
  const sig = (t) => t.replace(/\d+/g, '#').toLowerCase();
  const freq = {};
  pages.forEach((ls) => { const seen = new Set(); ls.forEach((l) => { if (l.rel > 0.9 || l.rel < 0.1) { const k = sig(l.text); if (!seen.has(k)) { seen.add(k); freq[k] = (freq[k] || 0) + 1; } } }); });
  const minRep = Math.max(3, pages.length * 0.25);
  const all = [];
  pages.forEach((ls) => ls.forEach((l) => { if ((l.rel > 0.9 || l.rel < 0.1) && (freq[sig(l.text)] >= minRep || /^\d{1,4}$/.test(l.text))) return; all.push(l); }));
  if (!all.length) throw new Error('This PDF has no selectable text (it may be scanned). Add it to your library to read it page by page instead.');
  const hs = all.map((l) => l.h).sort((a, b) => a - b); const body = hs[Math.floor(hs.length / 2)];
  const gaps = []; for (let i = 1; i < all.length; i++) { const g = all[i - 1].y - all[i].y; if (g > 0 && g < body * 4) gaps.push(g); }
  gaps.sort((a, b) => a - b); const lineGap = gaps[Math.floor(gaps.length / 2)] || body * 1.3;
  const out = []; let para = '';
  const flush = () => { if (para.trim()) out.push(`<p>${esc(para.trim())}</p>`); para = ''; };
  for (let i = 0; i < all.length; i++) {
    const l = all[i], prev = all[i - 1];
    if (l.h > body * 1.35 && l.text.length < 90) { flush(); out.push(`<h2>${esc(l.text)}</h2>`); continue; }
    const gap = prev ? prev.y - l.y : 0;
    const newPara = !prev || gap < 0 || gap > lineGap * 1.45 || (l.x > prev.x + body * 1.2 && /[.!?"”’]$/.test(prev.text));
    if (newPara) flush();
    if (para.endsWith('-') && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text; else para += (para ? ' ' : '') + l.text;
  }
  flush();
  const info = meta.info || {};
  return { html: out.join('\n'), title: info.Title, author: info.Author };
}

/* ───────────── HTML clean-up and chapter split ───────────── */
function sanitize(root, images) {
  root.querySelectorAll('script,style,iframe,object,embed,form,input,button,select,textarea,noscript,link,meta,svg').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((n) => {
    [...n.attributes].forEach((a) => {
      const k = a.name.toLowerCase();
      if (k.startsWith('on') || k === 'style' || k === 'class' && n.tagName === 'SPAN' || k.includes(':')) n.removeAttribute(a.name);
    });
  });
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const m = src.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
    if (m) {
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const name = `img${String(images.length + 1).padStart(3, '0')}.${ext}`;
      const bin = atob(m[2]); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      images.push({ name, type: m[1], data: u8 });
      img.setAttribute('src', `../images/${name}`);
      if (!img.getAttribute('alt')) img.setAttribute('alt', '');
    } else img.remove();
  });
  root.querySelectorAll('a[href]').forEach((a) => { if (!/^https?:/.test(a.getAttribute('href'))) a.removeAttribute('href'); });
  // unwrap empty spans/fonts
  root.querySelectorAll('font,span:not([id])').forEach((n) => n.replaceWith(...n.childNodes));
}

function splitChapters(body) {
  const kids = [...body.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()));
  const count = (t) => kids.filter((n) => n.tagName === t).length;
  let level = ['H1', 'H2', 'H3'].find((t) => count(t) >= 2) || (count('H1') === 1 && count('H2') >= 2 ? 'H2' : null);
  const chapters = []; let cur = null;
  const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
  for (const n of kids) {
    if (level && n.tagName === level) { cur = { title: text(n).slice(0, 120) || `Chapter ${chapters.length + 1}`, nodes: [n] }; chapters.push(cur); continue; }
    if (!cur) { cur = { title: '', nodes: [] }; chapters.push(cur); }
    cur.nodes.push(n);
  }
  // break very long chapters (no headings) into parts of ~6k words
  const final = [];
  for (const ch of chapters) {
    let words = 0, part = { title: ch.title, nodes: [] }, idx = 1;
    for (const n of ch.nodes) {
      part.nodes.push(n); words += text(n).split(' ').length;
      if (words > 6000) { final.push(part); idx++; part = { title: ch.title ? `${ch.title} (${idx})` : '', nodes: [] }; words = 0; }
    }
    if (part.nodes.length) final.push(part);
  }
  final.forEach((c, i) => { if (!c.title) c.title = final.length === 1 ? 'Text' : (i === 0 && !level ? 'Beginning' : `Part ${i + 1}`); });
  return final.filter((c) => c.nodes.some((n) => text(n) || (n.querySelector && n.querySelector('img'))));
}

const ser = new XMLSerializer();
function nodesToXhtml(nodes) {
  // Re-parent into an XHTML document so serialisation is well-formed XML without per-node xmlns noise.
  const d = document.implementation.createDocument(XHTML_NS, 'html', null);
  const b = d.createElementNS(XHTML_NS, 'body');
  nodes.forEach((n) => b.appendChild(d.importNode(n, true)));
  return ser.serializeToString(b).replace(/^<body[^>]*>|<\/body>$/g, '');
}

/* ───────────── EPUB packaging ───────────── */
const CSS = `body{font-family:serif;line-height:1.5;margin:0 4%;}h1,h2,h3{line-height:1.2;margin:1.6em 0 .8em;text-align:left;}p{margin:0;text-indent:1.4em;text-align:justify;}h1+p,h2+p,h3+p,hr+p,blockquote+p,p:first-child{text-indent:0;}blockquote{margin:1em 1.5em;font-style:italic;}img{max-width:100%;height:auto;display:block;margin:1em auto;}pre{white-space:pre-wrap;font-size:.85em;}.verse{text-indent:0;margin-left:2em;}table{border-collapse:collapse;}td,th{border:1px solid #9995;padding:.2em .4em;}`;
const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function buildEpub({ title, author, lang = 'en', chapters, images = [], cover }) {
  const zip = new window.JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const id = 'urn:uuid:' + uid();
  const manifest = [], spine = [];
  zip.file('OEBPS/style.css', CSS); manifest.push('<item id="css" href="style.css" media-type="text/css"/>');
  if (cover) {
    zip.file('OEBPS/images/cover.jpg', cover);
    manifest.push('<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    zip.file('OEBPS/text/cover.xhtml', `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Cover</title><style>body{margin:0;text-align:center}img{max-height:100vh;max-width:100%}</style></head><body epub:type="cover"><img src="../images/cover.jpg" alt="Cover"/></body></html>`);
    manifest.push('<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>'); spine.push('<itemref idref="cover" linear="no"/>');
  }
  images.forEach((im, i) => { zip.file(`OEBPS/images/${im.name}`, im.data); manifest.push(`<item id="im${i}" href="images/${im.name}" media-type="${im.type}"/>`); });
  chapters.forEach((c, i) => {
    const f = `ch${String(i + 1).padStart(3, '0')}.xhtml`; c.file = f;
    zip.file(`OEBPS/text/${f}`, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"><head><title>${xmlEsc(c.title)}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head><body>${c.xhtml}</body></html>`);
    manifest.push(`<item id="c${i}" href="text/${f}" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${i}"/>`);
  });
  const navList = chapters.map((c) => `<li><a href="text/${c.file}">${xmlEsc(c.title)}</a></li>`).join('');
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navList}</ol></nav></body></html>`);
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${xmlEsc(title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${xmlEsc(c.title)}</text></navLabel><content src="text/${c.file}"/></navPoint>`).join('')}</navMap></ncx>`);
  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${xmlEsc(title)}</dc:title>${author ? `<dc:creator>${xmlEsc(author)}</dc:creator>` : ''}<dc:language>${lang}</dc:language><meta property="dcterms:modified">${now}</meta>${cover ? '<meta name="cover" content="cover-img"/>' : ''}</metadata><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine></package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/* ───────────── public entry ───────────── */
export async function convertToEpub(file, { title, author, onProgress } = {}) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let html = '', meta = {};
  onProgress && onProgress(0.05, 'Reading');
  if (ext === 'txt') html = textToHtml(await file.text());
  else if (ext === 'md' || ext === 'markdown') html = mdToHtml(await file.text());
  else if (['html', 'htm', 'xhtml'].includes(ext)) {
    const d = new DOMParser().parseFromString(await file.text(), 'text/html');
    meta.title = d.querySelector('title')?.textContent?.trim(); meta.author = d.querySelector('meta[name=author]')?.content;
    html = d.body.innerHTML;
  } else if (ext === 'docx') {
    const mammoth = await needMammoth();
    const r = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    html = r.value;
  } else if (ext === 'rtf') html = textToHtml(rtfToText(await file.text()));
  else if (ext === 'fb2') { const r = fb2ToHtml(await file.text()); html = r.html; meta = r; }
  else if (ext === 'pdf') { const r = await pdfToHtml(file, (p) => onProgress && onProgress(0.05 + p * 0.75, 'Reading pages')); html = r.html; meta = r; }
  else throw new Error(`Quire can't convert .${ext} files yet.`);

  onProgress && onProgress(0.82, 'Building chapters');
  const d = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const images = [];
  sanitize(d.body, images);
  const firstH = d.body.querySelector('h1')?.textContent?.trim();
  const generic = (t) => !t || /^(untitled|document|microsoft word|title|unknown|none)\b/i.test(t.trim()) || /\.(docx?|pdf|txt)$/i.test(t.trim());
  const T = (title || (!generic(meta.title) && meta.title) || (ext === 'md' && firstH) || baseName(file.name)).trim();
  const A = (author ?? meta.author ?? '').trim();
  let parts = splitChapters(d.body);
  if (!parts.length) throw new Error('No readable text was found in this file.');
  const chapters = parts.map((p) => ({ title: p.title, xhtml: nodesToXhtml(p.nodes) }));

  onProgress && onProgress(0.9, 'Binding');
  let cover;
  if (meta.coverData) { const r = await fetch(meta.coverData); cover = await r.blob(); }
  if (!cover) cover = await makeCover({ title: T, author: A, seed: T });
  const blob = await buildEpub({ title: T, author: A, chapters, images, cover });
  onProgress && onProgress(1, 'Done');
  return { blob, title: T, author: A, cover, chapters: chapters.length, name: T.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) + '.epub' };
}
