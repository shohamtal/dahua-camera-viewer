// Export a recording window as MP4 without re-encoding: the NVR's H.264 frames
// are copied as-is into an ISO-BMFF file (one video track, no audio). Frames are
// written to the sink as they arrive and the index (moov) goes at the end, so a
// long clip never has to fit in memory. Isomorphic — no DOM.
import { downloadClip, findRecordings } from './dahua.js';
import { buildAvcC, toAvcc, readDhav } from './dhav.js';

// ---------- SPS → picture size ----------

class Bits {
  constructor(bytes) {
    // Drop emulation-prevention bytes (00 00 03 → 00 00).
    const out = [];
    let zeros = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 3 && zeros >= 2) { zeros = 0; continue; }
      zeros = bytes[i] === 0 ? zeros + 1 : 0;
      out.push(bytes[i]);
    }
    this.b = out; this.p = 0;
  }
  u(n) { let v = 0; for (let i = 0; i < n; i++, this.p++) v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); return v; }
  ue() { let z = 0; while (this.u(1) === 0 && z < 32) z++; return 2 ** z - 1 + this.u(z); }
  se() { const v = this.ue(); return v & 1 ? (v + 1) / 2 : -v / 2; }
}

/** Coded picture size from an H.264 SPS NAL (header byte first). */
export function spsSize(sps) {
  const r = new Bits(sps.subarray(1));
  const profile = r.u(8); r.u(16); r.ue(); // constraint flags + level, seq_parameter_set_id
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); r.ue(); r.u(1); // bit depths, qpprime_y_zero_transform_bypass
    if (r.u(1)) {           // seq_scaling_matrix_present
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!r.u(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + r.se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) { r.u(1); r.se(); r.se(); for (let i = r.ue(); i > 0; i--) r.se(); }
  r.ue(); r.u(1); // max_num_ref_frames, gaps_in_frame_num_allowed
  const wMbs = r.ue() + 1, hMap = r.ue() + 1, frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1); // direct_8x8_inference
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
  const subW = chroma === 1 || chroma === 2 ? 2 : 1, subH = chroma === 1 ? 2 : 1;
  const unitX = chroma ? subW : 1, unitY = (chroma ? subH : 1) * (2 - frameMbsOnly);
  return { width: wMbs * 16 - (cl + cr) * unitX, height: (2 - frameMbsOnly) * hMap * 16 - (ct + cb) * unitY };
}

// ---------- boxes ----------

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function bytes(...parts) {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : typeof p === 'string' ? ascii(p) : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const u16 = (v) => [(v >>> 8) & 255, v & 255];
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u64 = (v) => [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
const box = (type, ...payload) => { const body = bytes(...payload); return bytes(u32(body.length + 8), type, body); };
const fullBox = (type, version, flags, ...payload) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...payload);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

const FTYP = box('ftyp', 'isom', u32(512), 'isom', 'iso2', 'avc1', 'mp41');
/** ftyp + a 64-bit mdat header; its size is the same before and after the payload is known. */
const head = (mdatPayload) => bytes(FTYP, u32(1), 'mdat', u64(mdatPayload + 16));
export const HEAD_SIZE = FTYP.length + 16;

function moov({ sps, pps, width, height, sizes, durs, keys, dataOffset }) {
  const total = durs.reduce((a, b) => a + b, 0);
  const stts = []; // run-length (count, delta)
  for (const d of durs) { const last = stts[stts.length - 1]; if (last && last[1] === d) last[0]++; else stts.push([1, d]); }
  const avc1 = box('avc1', new Uint8Array(6), u16(1), new Uint8Array(16), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff),
    box('avcC', buildAvcC(sps, pps)));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(stts.length), stts.flatMap(([c, d]) => [...u32(c), ...u32(d)])),
    fullBox('stss', 0, 0, u32(keys.length), keys.flatMap((k) => u32(k))),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(sizes.length), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(sizes.length), sizes.flatMap((s) => u32(s))),
    fullBox('co64', 0, 0, u32(1), u64(dataOffset)));
  const minf = box('minf',
    fullBox('vmhd', 0, 1, new Uint8Array(8)),
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    stbl);
  const mdia = box('mdia',
    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(1000), u32(total), u16(0x55c4), u16(0)), // ms, "und"
    fullBox('hdlr', 0, 0, u32(0), 'vide', new Uint8Array(12), 'VideoHandler\0'),
    minf);
  return box('moov',
    fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(total), u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2)),
    box('trak',
      fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(total), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width * 65536), u32(height * 65536)),
      mdia));
}

// ---------- export ----------

const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const toMs = (s) => { const m = (s || '').match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
export const MAX_EXPORT_MS = 20 * 60e3;

/**
 * Requests needed for [startMs, endMs]: each stays inside one recording file
 * (the NVR stops a request at the end of the file it started in). Returns
 * {windows: [[from, to]], skippedMs} — skippedMs = time with no recording.
 */
export function exportWindows(files, startMs, endMs) {
  const spans = files.map((f) => [toMs(f.startTime), toMs(f.endTime)]).filter(([a, b]) => a != null && b > a);
  const windows = []; let cur = startMs, skippedMs = 0;
  while (cur < endMs - 500) {
    let best = null;
    for (const [a, b] of spans) if (a <= cur && cur < b && (!best || b > best[1])) best = [a, b];
    if (best) { const to = Math.min(best[1], endMs); windows.push([cur, to]); cur = to; continue; }
    const next = Math.min(...spans.filter(([a]) => a > cur && a < endMs).map(([a]) => a));
    if (!Number.isFinite(next)) { skippedMs += endMs - cur; break; }
    skippedMs += next - cur; cur = next;
  }
  return { windows, skippedMs };
}

/**
 * Export [startMs, endMs] of a channel (1-based) as MP4 into `sink`:
 *   { write(bytes), writeAt(position, bytes), close() } (may return promises).
 * onProgress(0..1). Resolves to {frames, seconds, skippedMs, width, height}.
 * Throws if there's no recording or no H.264 video in the range.
 */
export async function exportMp4(conn, channel, startMs, endMs, sink, { signal, onProgress = () => {}, maxMs = MAX_EXPORT_MS } = {}) {
  if (!(endMs > startMs)) throw new Error('The end must be after the start');
  if (endMs - startMs > maxMs) throw new Error(`Exports are limited to ${Math.round(maxMs / 60e3)} minutes`);
  const files = await findRecordings(conn, channel, new Date(startMs), new Date(endMs));
  const { windows, skippedMs } = exportWindows(files, startMs, endMs);
  if (!windows.length) throw new Error('No recording in this range');

  await sink.write(new Uint8Array(HEAD_SIZE)); // placeholder, rewritten at the end
  let sps = null, pps = null, dataSize = 0, prev = null, sawVideoBytes = false;
  const sizes = [], durs = [], keys = [];
  for (const [from, to] of windows) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const res = await downloadClip(conn, channel, fmt(from), fmt(to), 0, signal);
    if (!res.ok || !res.body) continue; // e.g. HTTP 400: nothing stored there after all
    let first = true;
    for await (const f of readDhav(res.body)) {
      sawVideoBytes = true;
      if (!sps && f.sps) sps = f.sps;
      if (!pps && f.pps) pps = f.pps;
      if (!sizes.length && !f.key) continue; // a playable file starts at a key frame
      if (f.at != null && f.at >= to + 1000) break; // never past the requested window
      // Duration of the previous sample from the ms counter; across requests (or
      // jumps) fall back to the typical frame duration, so gaps are skipped.
      if (prev) {
        const d = (f.ms - prev.ms + 65536) % 65536;
        durs[durs.length - 1] = !first && d > 0 && d < 1000 ? d : typicalDur(durs);
      }
      const data = toAvcc(f.vcl);
      await sink.write(data);
      sizes.push(data.length); durs.push(0); dataSize += data.length;
      if (f.key) keys.push(sizes.length);
      prev = f; first = false;
      if (f.at != null) onProgress(Math.min(1, Math.max(0, (f.at - startMs) / (endMs - startMs))));
    }
  }
  if (!sizes.length || !sps || !pps) {
    throw new Error(sawVideoBytes || sizes.length ? 'No usable H.264 video in this range' : 'The NVR sent no video for this range (the camera may record H.265, which export does not support)');
  }
  durs[durs.length - 1] = typicalDur(durs);
  const { width, height } = spsSize(sps);
  await sink.write(moov({ sps, pps, width, height, sizes, durs, keys, dataOffset: HEAD_SIZE }));
  await sink.writeAt(0, head(dataSize)); // after the moov: a positional write moves a stream's cursor
  await sink.close();
  onProgress(1);
  return { frames: sizes.length, seconds: durs.reduce((a, b) => a + b, 0) / 1000, skippedMs, width, height };
}

function typicalDur(durs) {
  const known = durs.filter((d) => d > 0).slice(-50).sort((a, b) => a - b);
  return known.length ? known[known.length >> 1] : 40;
}
