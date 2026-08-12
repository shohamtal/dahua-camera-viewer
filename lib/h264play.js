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

export function playRecording(conn, channel, start, end, canvas, { fps = 20, onStatus = () => {} } = {}) {
  const ctrl = new AbortController();
  const ctx = canvas.getContext('2d');
  let decoder = null, stopped = false, firstDrawn = false, sps = null, pps = null, started = false;
  const queue = []; // {key, data(AVCC), ts}
  let fed = 0;

  function ensureDecoder() {
    if (decoder || !sps || !pps) return;
    const codec = 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]);
    decoder = new VideoDecoder({
      output: (frame) => {
        if (stopped) { frame.close(); return; }
        if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        if (!firstDrawn) { firstDrawn = true; onStatus(''); }
      },
      error: (e) => onStatus('Decode error: ' + e.message),
    });
    decoder.configure({ codec, description: buildAvcC(sps, pps), optimizeForLatency: true });
  }

  const interval = 1000 / fps;
  const pump = setInterval(() => {
    if (stopped || !decoder || decoder.decodeQueueSize > 4) return;
    const c = queue.shift();
    if (!c) return;
    try { decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.data })); } catch {}
  }, interval);

  (async () => {
    let res;
    try { res = await downloadClip(conn, channel, start, end, 0, ctrl.signal); }
    catch (e) { if (e.name !== 'AbortError') onStatus('Load failed: ' + e.message); return; }
    if (!res.ok || !res.body) { onStatus('No recording data'); return; }
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    const append = (c) => { const n = new Uint8Array(buf.length + c.length); n.set(buf); n.set(c, buf.length); buf = n; };

    while (!stopped) {
      let value, done;
      try { ({ value, done } = await reader.read()); } catch { break; }
      if (done) break;
      append(value);

      for (;;) {
        const s = findSig(buf, DHAV, 0);
        if (s === -1) { if (buf.length > 4) buf = buf.subarray(buf.length - 4); break; }
        if (buf.length < s + 16) { if (s > 0) buf = buf.subarray(s); break; }
        const len = u32le(buf, s + 12);
        if (len < 24 || len > 5_000_000) { buf = buf.subarray(s + 4); continue; }
        if (buf.length < s + len) { if (s > 0) buf = buf.subarray(s); break; }

        const frame = buf.subarray(s, Math.max(s, s + len - 8)); // drop 8-byte footer
        for (const nal of splitNals(frame)) {
          const t = nal[0] & 0x1f;
          if (t === 7 && !sps) sps = nal.slice();
          else if (t === 8 && !pps) pps = nal.slice();
        }
        ensureDecoder();
        // Collect this frame's VCL NALs (1 = non-IDR, 5 = IDR); skip AUD/SEI/SPS/PPS.
        const vcl = [];
        let key = false;
        for (const nal of splitNals(frame)) {
          const t = nal[0] & 0x1f;
          if (t === 1 || t === 5) { vcl.push(nal); if (t === 5) key = true; }
        }
        if (vcl.length && decoder) {
          if (!started) { if (!key) { buf = buf.subarray(s + len); continue; } started = true; }
          queue.push({ key, data: toAvcc(vcl), ts: (fed++) * Math.round(1e6 / fps) });
        }
        buf = buf.subarray(s + len);
      }
      while (!stopped && queue.length > 150) await new Promise((r) => setTimeout(r, 50));
    }
  })();

  return {
    stop() {
      stopped = true; ctrl.abort(); clearInterval(pump);
      try { decoder && decoder.state !== 'closed' && decoder.close(); } catch {}
    },
  };
}
