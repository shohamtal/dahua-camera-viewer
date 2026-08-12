// Browser-side Dahua client. Talks to the device directly over fetch()
// with HTTP Digest auth. Runs unchanged in a Chrome extension page (which
// has host permission, so CORS does not apply) and in Node (for tests).
import { md5 } from './md5.js';

const rand = (n = 8) => {
  const a = new Uint8Array(n);
  (globalThis.crypto || crypto).getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(header)) !== null) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function buildAuth({ user, pass, method, uri, challenge, nc }) {
  const { realm = '', nonce = '', opaque, qop } = challenge;
  const cnonce = rand();
  const ncHex = String(nc).padStart(8, '0');
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

function baseUrl(conn) {
  return `http://${conn.host}:${conn.port || 80}`;
}

/**
 * Digest-authenticated fetch. Does the 401 challenge round-trip and returns
 * the authenticated Response (body still unread, so it can be streamed).
 */
export async function digestFetch(conn, uri, { method = 'GET', signal } = {}) {
  const url = baseUrl(conn) + uri;
  const first = await fetch(url, { method, credentials: 'omit', signal });
  if (first.status !== 401) return first;
  const wa = first.headers.get('www-authenticate');
  // Drain the challenge body so the connection is freed.
  try { await first.arrayBuffer(); } catch { /* ignore */ }
  if (!wa) throw new Error('No auth challenge from device');
  const challenge = parseChallenge(wa);
  const auth = buildAuth({ user: conn.user, pass: conn.pass, method, uri, challenge, nc: 1 });
  return fetch(url, { method, credentials: 'omit', signal, headers: { Authorization: auth } });
}

async function text(conn, uri, opts) {
  const res = await digestFetch(conn, uri, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${uri}`);
  return res.text();
}

function parseKV(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > -1) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export async function deviceInfo(conn) {
  const [t, s, v] = await Promise.all([
    text(conn, '/cgi-bin/magicBox.cgi?action=getDeviceType').catch(() => ''),
    text(conn, '/cgi-bin/magicBox.cgi?action=getSerialNo').catch(() => ''),
    text(conn, '/cgi-bin/magicBox.cgi?action=getSoftwareVersion').catch(() => ''),
  ]);
  return {
    type: parseKV(t).type || '',
    serial: parseKV(s).sn || '',
    firmware: (parseKV(v).version || '').split(',')[0] || '',
  };
}

export async function listChannels(conn) {
  let max = 1;
  try {
    const def = parseKV(await text(conn, '/cgi-bin/magicBox.cgi?action=getProductDefinition&name=MaxRemoteInputChannels'));
    max = parseInt(def['table.MaxRemoteInputChannels'], 10) || 1;
  } catch { /* single camera */ }
  const titles = {};
  try {
    const cfg = parseKV(await text(conn, '/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle'));
    for (const [k, v] of Object.entries(cfg)) {
      const m = k.match(/table\.ChannelTitle\[(\d+)\]\.Name/);
      if (m && v) titles[+m[1]] = v;
    }
  } catch { /* no titles */ }
  const channels = [];
  for (let i = 0; i < Math.max(max, Object.keys(titles).length || 1); i++) {
    channels.push({ channel: i + 1, name: titles[i] || `Camera ${i + 1}` });
  }
  return channels;
}

/** Full-resolution snapshot (main stream JPEG) as a Blob — used for thumbnails. */
export async function snapshotBlob(conn, channel, signal) {
  const res = await digestFetch(conn, `/cgi-bin/snapshot.cgi?channel=${channel}`, { signal });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('empty snapshot');
  return blob;
}

/** URI for a channel's MJPEG substream (already MJPG-encoded on the device). */
export function mjpegUri(channel, subtype = 1) {
  return `/cgi-bin/mjpg/video.cgi?channel=${channel}&subtype=${subtype}`;
}

/**
 * Open an MJPEG stream and invoke onFrame(Blob) for each JPEG frame.
 * Robust against Dahua's loose framing: scans the byte stream for
 * SOI (FFD8) .. EOI (FFD9) pairs rather than trusting Content-Length.
 * Returns when the signal aborts or the stream ends.
 */
export async function streamMjpeg(conn, channel, subtype, onFrame, signal) {
  const res = await digestFetch(conn, mjpegUri(channel, subtype), { signal });
  if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  const append = (chunk) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf); next.set(chunk, buf.length);
    buf = next;
  };
  const indexOf = (sig, from) => {
    for (let i = from; i <= buf.length - 2; i++) {
      if (buf[i] === sig[0] && buf[i + 1] === sig[1]) return i;
    }
    return -1;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    append(value);
    // Extract every complete JPEG currently in the buffer.
    while (true) {
      const soi = indexOf([0xff, 0xd8], 0);
      if (soi === -1) { if (buf.length > 1) buf = buf.subarray(buf.length - 1); break; }
      const eoi = indexOf([0xff, 0xd9], soi + 2);
      if (eoi === -1) { if (soi > 0) buf = buf.subarray(soi); break; }
      const frame = buf.slice(soi, eoi + 2);
      onFrame(new Blob([frame], { type: 'image/jpeg' }));
      buf = buf.subarray(eoi + 2);
    }
  }
}

const pad = (n) => String(n).padStart(2, '0');
function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function durationBetween(a, b) {
  const t = (s) => {
    const m = (s || '').match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  };
  const s = t(a), e = t(b);
  return s !== null && e !== null ? Math.max(0, Math.round((e - s) / 1000)) : 0;
}

/** Find recordings for a channel (1-based) on a day. */
export async function findRecordings(conn, channel, start, end) {
  const object = (parseKV(await text(conn, '/cgi-bin/mediaFileFind.cgi?action=factory.create')).result || '').trim();
  if (!object) throw new Error('Could not create media finder');
  const q =
    `/cgi-bin/mediaFileFind.cgi?action=findFile&object=${object}` +
    `&condition.Channel=${channel - 1}` +
    `&condition.StartTime=${encodeURIComponent(fmt(start))}` +
    `&condition.EndTime=${encodeURIComponent(fmt(end))}`;
  await text(conn, q);
  const items = [];
  for (let guard = 0; guard < 200; guard++) {
    const kv = parseKV(await text(conn, `/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${object}&count=100`));
    const found = parseInt(kv.found, 10) || 0;
    if (!found) break;
    const byIdx = {};
    for (const [k, v] of Object.entries(kv)) {
      const m = k.match(/items\[(\d+)\]\.(.+)/);
      if (m) (byIdx[m[1]] ||= {})[m[2]] = v;
    }
    for (const it of Object.values(byIdx)) {
      if (!it.FilePath) continue;
      items.push({
        path: it.FilePath,
        startTime: it.StartTime || '',
        endTime: it.EndTime || '',
        length: parseInt(it.Length, 10) || 0,
        type: it.Type || '',
        durationSec: durationBetween(it.StartTime, it.EndTime),
      });
    }
    if (found < 100) break;
  }
  await text(conn, `/cgi-bin/mediaFileFind.cgi?action=close&object=${object}`).catch(() => {});
  await text(conn, `/cgi-bin/mediaFileFind.cgi?action=destroy&object=${object}`).catch(() => {});
  return items;
}

/**
 * Authenticated Response streaming a bounded .dav clip for [start,end] on a
 * channel (1-based). Caller pipes response.body to disk.
 * start/end are "YYYY-MM-DD HH:MM:SS" strings.
 */
export function downloadClip(conn, channel, start, end, subtype = 0, signal) {
  const t = (s) => encodeURIComponent(s);
  const uri =
    `/cgi-bin/loadfile.cgi?action=startLoad&channel=${channel - 1}` +
    `&startTime=${t(start)}&endTime=${t(end)}&subtype=${subtype}`;
  return digestFetch(conn, uri, { signal });
}
