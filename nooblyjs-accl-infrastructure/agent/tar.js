// Tar archives (spec 8.8 R1, R2): a static site's build output comes back from the agent as a tar stream (`docker cp
// <container>:<dir> -`), and the controller reads it into files. No dependencies: ustar headers, the GNU long-name
// entry ('L') and PAX extended headers ('x', for `path` and `size`) are what Docker writes. Only regular files and
// folders are kept; links and devices are skipped and counted (a link could point outside the site).
//
// pack() writes the same format (ustar, with a PAX header for long names): the mock agent and the tests use it.

const BLOCK = 512;

export class TarError extends Error {}

const field = (buf, start, len) => {
  const raw = buf.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? len : end).toString('utf8');
};

/** A numeric field: octal text, or base-256 when its first byte has the high bit set. */
function number(buf, start, len) {
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i += 1) n = n * 256 + buf[i];
    return n;
  }
  const s = field(buf, start, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError('The archive has a broken header.');
  return Number.parseInt(s, 8);
}

function checksumOk(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === number(header, 148, 8);
}

/** PAX records: "<len> <key>=<value>\n" … → { key: value } */
function pax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const len = Number.parseInt(data.subarray(i, space).toString('ascii'), 10);
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) break;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * A path inside the site: '/'-separated, no empty, '.' or '..' segments, no control characters. → the clean path
 * (without a leading '/') or null when it is not one.
 */
export function cleanPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length) return '';
  if (parts.some((s) => s === '..' || /[\u0000-\u001f\u007f]/.test(s))) return null;
  return parts.join('/');
}

/**
 * Reads an archive.
 * @param {Buffer} buf
 * @param {{ stripFirst?: boolean, maxFiles?: number, maxBytes?: number, maxPath?: number }} [o]
 *   stripFirst: drop each entry's first folder (`docker cp <c>:/app/dist -` puts everything under "dist/")
 * @returns {{ files: { path: string, data: Buffer, mode: number }[], skipped: { path: string, why: string }[] }}
 */
export function unpack(buf, { stripFirst = false, maxFiles = 20_000, maxBytes = 512 * 1024 * 1024, maxPath = 1024 } = {}) {
  const files = [];
  const skipped = [];
  let bytes = 0;
  let offset = 0;
  let longName = null;
  let paxHeader = null;
  let ended = false;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) { ended = true; break; } // two zero blocks end the archive; one is enough to stop
    if (!checksumOk(header)) throw new TarError('The archive has a broken header.');
    const type = String.fromCharCode(header[156] || 0x30);
    let size = number(header, 124, 12);
    if (paxHeader?.size !== undefined && /^\d+$/.test(paxHeader.size)) size = Number(paxHeader.size);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > buf.length) throw new TarError('The archive ends in the middle of a file.');
    const data = buf.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type === 'x') { paxHeader = pax(data); continue; }
    if (type === 'g' || type === 'K') continue;

    const prefix = header.subarray(257, 263).toString('ascii').startsWith('ustar') ? field(header, 345, 155) : '';
    const named = paxHeader?.path ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    paxHeader = null;
    let p = cleanPath(named);
    if (p !== null && stripFirst) p = p.includes('/') ? p.slice(p.indexOf('/') + 1) : '';
    if (type === '5') continue; // folders come from the files' paths
    if (p === null || p.length > maxPath) {
      skipped.push({ path: String(named).slice(0, 200), why: 'not a path inside the site' });
      continue;
    }
    if (!p) continue;
    if (type !== '0' && type !== '7') {
      skipped.push({ path: p, why: type === '2' ? 'a symbolic link' : type === '1' ? 'a hard link' : 'not a regular file' });
      continue;
    }
    bytes += size;
    if (files.length + 1 > maxFiles) throw new TarError(`The site has more than ${maxFiles.toLocaleString('en')} files.`);
    if (bytes > maxBytes) throw new TarError(`The site is over ${Math.round(maxBytes / 1048576)} MB.`);
    files.push({ path: p, data, mode: number(header, 100, 8) });
  }
  if (!ended && offset < buf.length) throw new TarError('The archive ends in the middle of a file.');
  return { files, skipped };
}

function header(name, size, type = '0', mode = 0o644) {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}
const padded = (data) => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);

/**
 * Writes an archive.
 * @param {{ path: string, data: Buffer|string, type?: string }[]} entries   type '0' (file, default), '5' (folder), '2' (link)
 */
export function pack(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.type && e.type !== '0' ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const name = e.type === '5' && !e.path.endsWith('/') ? `${e.path}/` : e.path;
    if (Buffer.byteLength(name) > 100) {
      const rec = (k, v) => {
        const body = ` ${k}=${v}\n`;
        let len = Buffer.byteLength(body);
        len += String(len).length;
        if (String(len).length !== String(len - String(len).length).length) len += 1;
        return `${len}${body}`;
      };
      const ext = Buffer.from(rec('path', name), 'utf8');
      parts.push(header('PaxHeader', ext.length, 'x'), padded(ext));
    }
    parts.push(header(name, data.length, e.type ?? '0', e.type === '5' ? 0o755 : 0o644), padded(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
