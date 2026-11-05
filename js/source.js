// Page sources for comics and PDFs. Each source exposes:
//   count, async page(i) -> Blob, close()
import { needArchive, needPdf, natCompare } from './util.js';

const IMG = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const mimeOf = (n) => MIME[(n.split('.').pop() || '').toLowerCase()] || 'image/jpeg';
const junk = (p) => /(^|\/)(__MACOSX|\.)/.test(p) || /thumbs\.db$/i.test(p);

export function formatOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'epub') return 'epub';
  if (['cbz', 'zip'].includes(ext)) return 'zip';
  if (['cbr', 'rar'].includes(ext)) return 'rar';
  if (['cb7', '7z'].includes(ext)) return '7z';
  if (['cbt', 'tar'].includes(ext)) return 'tar';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'docx', 'rtf', 'fb2'].includes(ext)) return 'doc';
  return null;
}

// Identify a file by its first bytes, for files with a missing or unusual extension.
export async function sniffFormat(file) {
  try {
    const b = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    const str = (i, n) => String.fromCharCode(...b.slice(i, i + n));
    if (str(0, 4) === '%PDF') return 'pdf';
    if (str(0, 4) === 'Rar!') return 'rar';
    if (b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF) return '7z';
    if (str(257, 5) === 'ustar') return 'tar';
    if (b[0] === 0x50 && b[1] === 0x4B) return str(30, 28) === 'mimetypeapplication/epub+zip' ? 'epub' : 'zip';
  } catch (e) {}
  return null;
}

/* Streaming ZIP/CBZ reader.
   Reads only the archive's index from the end of the file, then slices out one page at a time,
   so an 800 MB comic needs no more memory than a small one. Falls back to JSZip for unusual zips. */
async function readBytes(blob, start, len) { return new Uint8Array(await blob.slice(start, start + len).arrayBuffer()); }
async function lazyZipSource(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557 + 22);
  const tail = await readBytes(blob, size - tailLen, tailLen);
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip-fallback');
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the real values live in the ZIP64 end record, located just before
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('zip-fallback');
    const z64off = Number(dv.getBigUint64(loc + 8, true));
    const z = new DataView((await readBytes(blob, z64off, 56)).buffer);
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error('zip-fallback');
    count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOffset = Number(z.getBigUint64(48, true));
  }
  const cd = await readBytes(blob, cdOffset, cdSize);
  const c = new DataView(cd.buffer);
  const utf8 = new TextDecoder('utf-8'), latin = new TextDecoder('latin1');
  const entries = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
    if (c.getUint32(p, true) !== 0x02014b50) throw new Error('zip-fallback');
    const flags = c.getUint16(p + 8, true), method = c.getUint16(p + 10, true);
    let csize = c.getUint32(p + 20, true), usize = c.getUint32(p + 24, true);
    const nlen = c.getUint16(p + 28, true), xlen = c.getUint16(p + 30, true), clen = c.getUint16(p + 32, true);
    let off = c.getUint32(p + 42, true);
    const name = ((flags & 0x800) ? utf8 : latin).decode(cd.subarray(p + 46, p + 46 + nlen));
    // ZIP64 sizes/offsets in the extra field
    let q = p + 46 + nlen; const xend = q + xlen;
    while (q + 4 <= xend) {
      const id = c.getUint16(q, true), len = c.getUint16(q + 2, true);
      if (id === 0x0001) { let r = q + 4;
        if (usize === 0xffffffff) { usize = Number(c.getBigUint64(r, true)); r += 8; }
        if (csize === 0xffffffff) { csize = Number(c.getBigUint64(r, true)); r += 8; }
        if (off === 0xffffffff) { off = Number(c.getBigUint64(r, true)); } }
      q += 4 + len;
    }
    entries.push({ name, method, csize, usize, off, enc: flags & 1 });
    p += 46 + nlen + xlen + clen;
  }
  const pages = entries.filter((e) => !e.name.endsWith('/') && IMG.test(e.name) && !junk(e.name)).sort((a, b) => natCompare(a.name, b.name));
  if (!pages.length) throw new Error('No images found inside this archive.');
  if (pages.some((e) => e.enc)) throw new Error('This comic is password-protected.');
  if (pages.some((e) => e.method !== 0 && e.method !== 8)) throw new Error('zip-fallback');
  if (pages.some((e) => e.method === 8) && typeof DecompressionStream === 'undefined') throw new Error('zip-fallback');
  return {
    count: pages.length,
    names: pages.map((e) => e.name),
    async page(i) {
      const e = pages[i];
      const lh = new DataView((await readBytes(blob, e.off, 30)).buffer);
      if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Damaged page in this comic.');
      const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const data = blob.slice(start, start + e.csize);
      if (e.method === 0) return new Blob([data], { type: mimeOf(e.name) });
      const out = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const b = await new Response(out).blob();
      return new Blob([b], { type: mimeOf(e.name) });
    },
    close() {},
  };
}

async function jszipSource(blob) {
  const zip = await window.JSZip.loadAsync(blob);
  const entries = Object.values(zip.files).filter((f) => !f.dir && IMG.test(f.name) && !junk(f.name)).sort((a, b) => natCompare(a.name, b.name));
  if (!entries.length) throw new Error('No images found inside this archive.');
  return {
    count: entries.length,
    names: entries.map((e) => e.name),
    async page(i) { const e = entries[i]; const ab = await e.async('arraybuffer'); return new Blob([ab], { type: mimeOf(e.name) }); },
    close() {},
  };
}

async function zipSource(blob) {
  try { return await lazyZipSource(blob); }
  catch (e) {
    if (e.message !== 'zip-fallback') throw e;
    if (blob.size > 300 * 1024 * 1024) throw new Error('This archive uses a zip format that is too large to open on a phone. Re-zipping it on a computer fixes this.');
    return jszipSource(blob);
  }
}

async function archiveSource(blob, name) {
  const Archive = await needArchive();
  const file = blob instanceof File ? blob : new File([blob], name || 'comic.cbr');
  const arc = await Archive.open(file);
  const list = (await arc.getFilesArray()).filter((f) => IMG.test(f.file.name) && !junk((f.path || '') + f.file.name))
    .sort((a, b) => natCompare((a.path || '') + a.file.name, (b.path || '') + b.file.name));
  if (!list.length) throw new Error('No images found inside this archive.');
  const cache = new Map();
  return {
    count: list.length,
    names: list.map((f) => f.file.name),
    async page(i) {
      if (cache.has(i)) return cache.get(i);
      const p = list[i].file.extract().then((f) => new Blob([f], { type: mimeOf(list[i].file.name) }));
      cache.set(i, p);
      if (cache.size > 12) cache.delete(cache.keys().next().value);
      return p;
    },
    close() { try { arc.close && arc.close(); } catch (e) {} },
  };
}

async function pdfSource(blob) {
  const pdfjs = await needPdf();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const target = Math.min(2000, Math.max(1100, Math.round(window.innerWidth * (window.devicePixelRatio || 1) * 1.2)));
  return {
    count: doc.numPages,
    names: [],
    async page(i, width = target) {
      const pg = await doc.getPage(i + 1);
      const vp0 = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: width / vp0.width });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      pg.cleanup();
      return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    },
    close() { doc.destroy(); },
  };
}

export async function openSource(blob, format, name) {
  if (format === 'zip') {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) return zipSource(blob);
    return archiveSource(blob, name); // a RAR or 7z named .cbz
  }
  if (format === 'pdf') return pdfSource(blob);
  if (['rar', '7z', 'tar'].includes(format)) {
    // many .cbr files are actually zips
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) return zipSource(blob);
    return archiveSource(blob, name);
  }
  throw new Error('Unsupported comic format');
}
