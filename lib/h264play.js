// In-browser recording playback: stream a bounded .dav window from the NVR,
// demux Dahua's DHAV container into H.264, and decode with WebCodecs onto a
// canvas. Only the bytes actually watched are fetched — no multi-GB download.
//
// WebCodecs H.264 is fed the well-supported way: an avcC `description` built
// from SPS/PPS, and each frame's VCL NALs as 4-byte length-prefixed data
// (AVCC). AUD/SEI NALs are dropped.
import { downloadClip } from './dahua.js';

const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const DHAV = [0x44, 0x48, 0x41, 0x56]; // "DHAV"

function findSig(buf, sig, from) {
  outer: for (let i = from; i <= buf.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig[j]) continue outer;
    return i;
  }
  return -1;
}

// Split an Annex-B buffer into NAL byte-slices (header byte first, no start code).
function splitNals(buf) {
  const starts = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { starts.push([i + 3, i]); i += 2; }
      else if (buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push([i + 4, i]); i += 3; }
    }
  }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k][0];
    const e = k + 1 < starts.length ? starts[k + 1][1] : buf.length;
    if (e > s) out.push(buf.subarray(s, e));
  }
  return out;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

function buildAvcC(sps, pps) {
  const len = 11 + sps.length + pps.length;
  const b = new Uint8Array(len);
  let o = 0;
  b[o++] = 1; b[o++] = sps[1]; b[o++] = sps[2]; b[o++] = sps[3];
  b[o++] = 0xff;            // lengthSizeMinusOne = 3
  b[o++] = 0xe1;            // numSPS = 1
  b[o++] = (sps.length >> 8) & 0xff; b[o++] = sps.length & 0xff;
  b.set(sps, o); o += sps.length;
  b[o++] = 1;               // numPPS = 1
  b[o++] = (pps.length >> 8) & 0xff; b[o++] = pps.length & 0xff;
  b.set(pps, o);
  return b;
}

// Concatenate VCL NALs as 4-byte length-prefixed (AVCC).
function toAvcc(vclNals) {
  let total = 0;
  for (const n of vclNals) total += 4 + n.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of vclNals) {
    out[o++] = (n.length >>> 24) & 0xff; out[o++] = (n.length >>> 16) & 0xff;
    out[o++] = (n.length >>> 8) & 0xff; out[o++] = n.length & 0xff;
    out.set(n, o); o += n.length;
  }
  return out;
}

/**
 * DHAV header (after "DHAV"): +4 frame type, +12 u32 length, +16 packed local
 * date-time, +20 u16 millisecond counter. Returns epoch ms, or null if the
 * stamp doesn't look like a date (layout as in ffmpeg's dhav demuxer).
 */
export function dhavTime(b, s) {
  const t = u32le(b, s + 16);
  const sec = t & 0x3f, min = (t >> 6) & 0x3f, hour = (t >> 12) & 0x1f;
  const day = (t >> 17) & 0x1f, mon = (t >> 22) & 0x0f, year = 2000 + ((t >>> 26) & 0x3f);
  if (!mon || mon > 12 || !day || hour > 23 || min > 59 || sec > 59) return null;
  return new Date(year, mon - 1, day, hour, min, sec).getTime();
}

/**
 * Play [start, end] ("YYYY-MM-DD HH:MM:SS") of a channel onto a canvas.
 * - speed: playback rate. Up to 4× every frame is decoded; from 8× only key
 *   frames are shown (the stream still has to be read, but decode stays cheap).
 * - subtype: 0 main stream, 1 sub stream (much smaller — good for fast speeds).
 * - onTime(ms): recording wall-clock time of the frame on screen.
 * - onEnded({frames}): the stream ran out (end of the window, or the NVR had
 *   nothing there); frames = how many video frames arrived.
 */
export function playRecording(conn, channel, start, end, canvas, {
  fps = 20, speed = 1, subtype = 0, onStatus = () => {}, onTime = () => {}, onEnded = () => {},
} = {}) {
  const ctrl = new AbortController();
  const ctx = canvas.getContext('2d');
  let decoder = null, stopped = false, paused = false, firstDrawn = false, sps = null, pps = null;
  let needKey = true;      // decode resumes only at a key frame (start, after skipping)
  let ended = false, endedFired = false, frames = 0;
  const queue = [];        // {key, data(AVCC), vt: video ms from start, at: wall-clock ms|null}
  const wallByTs = new Map();
  let lastSec = -1, clock = null, lastDecodedVt = 0, lastTick = performance.now();
  const startMs = (() => { const m = start.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0; })();

  function ensureDecoder() {
    if (decoder || !sps || !pps) return;
    const codec = 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]);
    decoder = new VideoDecoder({
      output: (frame) => {
        const at = wallByTs.get(frame.timestamp); wallByTs.delete(frame.timestamp);
        if (stopped) { frame.close(); return; }
        if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        if (!firstDrawn) { firstDrawn = true; onStatus(''); }
        const t = at ?? startMs + frame.timestamp / 1000;
        if (Math.floor(t / 1000) !== lastSec) { lastSec = Math.floor(t / 1000); onTime(t); }
      },
      error: (e) => onStatus('Decode error: ' + e.message),
    });
    decoder.configure({ codec, description: buildAvcC(sps, pps), optimizeForLatency: true });
  }

  function decode(c) {
    const ts = Math.round(c.vt * 1000);
    if (c.at != null) wallByTs.set(ts, c.at);
    try { decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: ts, data: c.data })); }
    catch { needKey = true; }
    lastDecodedVt = c.vt;
  }

  // Release frames as the playback clock (video ms × speed) passes them.
  const pump = setInterval(() => {
    const now = performance.now(), dt = now - lastTick; lastTick = now;
    if (stopped) return;
    // Fires even with no decoder: the NVR may send nothing for a time with no video.
    if (ended && !queue.length && !endedFired && (!decoder || decoder.decodeQueueSize === 0)) { endedFired = true; onEnded({ frames }); }
    if (!decoder) return;
    if (!queue.length) {
      if (clock != null) clock = Math.min(clock, lastDecodedVt + 300); // don't run ahead of the data
      return;
    }
    if (paused) return;
    if (clock == null) clock = queue[0].vt;
    clock += dt * speed;
    const keysOnly = speed >= 8;
    for (let n = 0; queue.length && queue[0].vt <= clock && decoder.decodeQueueSize < 8 && n < 120; n++) {
      const c = queue.shift();
      // Skip deltas in key-frame mode, after a skip, or when we've fallen >1.5 s behind.
      if (!c.key && (keysOnly || needKey || clock - c.vt > 1500)) { needKey = true; continue; }
      needKey = false;
      decode(c);
    }
  }, 25);

  (async () => {
    let res;
    try { res = await downloadClip(conn, channel, start, end, subtype, ctrl.signal); }
    catch (e) { if (e.name !== 'AbortError') onStatus('Load failed: ' + e.message); ended = true; return; }
    if (!res.ok || !res.body) { onStatus('No recording data'); ended = true; return; }
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    const append = (c) => { const n = new Uint8Array(buf.length + c.length); n.set(buf); n.set(c, buf.length); buf = n; };
    let vt = 0, prevMs = null;

    while (!stopped) {
      let value, done;
      try { ({ value, done } = await reader.read()); } catch { break; }
      if (done) break;
      append(value);

      for (;;) {
        const s = findSig(buf, DHAV, 0);
        if (s === -1) { if (buf.length > 4) buf = buf.subarray(buf.length - 4); break; }
        if (buf.length < s + 24) { if (s > 0) buf = buf.subarray(s); break; }
        const len = u32le(buf, s + 12);
        if (len < 24 || len > 5_000_000) { buf = buf.subarray(s + 4); continue; }
        if (buf.length < s + len) { if (s > 0) buf = buf.subarray(s); break; }

        const frame = buf.subarray(s, Math.max(s, s + len - 8)); // drop 8-byte footer
        const nals = splitNals(frame);
        for (const nal of nals) {
          const t = nal[0] & 0x1f;
          if (t === 7 && !sps) sps = nal.slice();
          else if (t === 8 && !pps) pps = nal.slice();
        }
        ensureDecoder();
        // Collect this frame's VCL NALs (1 = non-IDR, 5 = IDR); skip AUD/SEI/SPS/PPS.
        const vcl = [];
        let key = false;
        for (const nal of nals) {
          const t = nal[0] & 0x1f;
          if (t === 1 || t === 5) { vcl.push(nal); if (t === 5) key = true; }
        }
        if (vcl.length) {
          // Pace by the header's ms counter (wraps at 65536); jumps fall back to 1/fps.
          const ms = buf[s + 20] | (buf[s + 21] << 8);
          if (prevMs != null) { const d = (ms - prevMs + 65536) % 65536; vt += d > 0 && d < 4000 ? d : 1000 / fps; }
          prevMs = ms;
          frames++;
          if (decoder) queue.push({ key, data: toAvcc(vcl), vt, at: dhavTime(buf, s) });
        }
        buf = buf.subarray(s + len);
      }
      // Stay at most ~20 s (of video) ahead of the playback clock.
      while (!stopped && queue.length > 60 && queue[queue.length - 1].vt - (clock ?? 0) > 20000) await new Promise((r) => setTimeout(r, 50));
    }
    ended = true;
  })();

  return {
    stop() {
      stopped = true; ctrl.abort(); clearInterval(pump);
      try { decoder && decoder.state !== 'closed' && decoder.close(); } catch {}
    },
    pause() { paused = true; },
    resume() { paused = false; lastTick = performance.now(); },
    setSpeed(s) { speed = s; },
    get paused() { return paused; },
  };
}
