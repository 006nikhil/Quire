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

async function zipSource(blob) {
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
    try { return await zipSource(blob); }
    catch (e) { if (/images/.test(e.message)) throw e; return archiveSource(blob, name); } // mislabelled RAR
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
