// Dahua's DHAV container (.dav): read H.264 frames out of a recording stream.
// Shared by the player (h264play.js) and MP4 export (mp4.js). Isomorphic — no DOM.

export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const DHAV = [0x44, 0x48, 0x41, 0x56]; // "DHAV"

function findSig(buf, sig, from) {
  outer: for (let i = from; i <= buf.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig[j]) continue outer;
    return i;
  }
  return -1;
}

// Split an Annex-B buffer into NAL byte-slices (header byte first, no start code).
export function splitNals(buf) {
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

/** avcC decoder configuration record from SPS/PPS (for WebCodecs and MP4). */
export function buildAvcC(sps, pps) {
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
export function toAvcc(vclNals) {
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
 * Iterate the H.264 video frames of a .dav stream (a fetch Response body).
 * Yields {key, vcl, sps, pps, ms, at}: vcl = the frame's slice NALs (1 non-IDR,
 * 5 IDR); sps/pps = this frame's parameter sets or null; ms = the header's u16
 * millisecond counter (wraps at 65536); at = wall-clock epoch ms or null.
 * Frames without H.264 slices (audio, metadata, H.265) are skipped.
 */
export async function* readDhav(body) {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const n = new Uint8Array(buf.length + value.length); n.set(buf); n.set(value, buf.length); buf = n;

      for (;;) {
        const s = findSig(buf, DHAV, 0);
        if (s === -1) { if (buf.length > 4) buf = buf.subarray(buf.length - 4); break; }
        if (buf.length < s + 24) { if (s > 0) buf = buf.subarray(s); break; }
        const len = u32le(buf, s + 12);
        if (len < 24 || len > 5_000_000) { buf = buf.subarray(s + 4); continue; }
        if (buf.length < s + len) { if (s > 0) buf = buf.subarray(s); break; }

        // Payload = after the 24-byte header and its extension (length at +22), before
        // the 8-byte footer. Never scan the header: its bytes (sequence, length,
        // time) can happen to look like an H.264 start code.
        const from = s + 24 + buf[s + 22];
        const nals = splitNals(buf.subarray(Math.min(from, s + len - 8), s + len - 8));
        let sps = null, pps = null, key = false;
        const vcl = [];
        for (const nal of nals) {
          const t = nal[0] & 0x1f;
          if (t === 7) sps = nal.slice();
          else if (t === 8) pps = nal.slice();
          else if (t === 1 || t === 5) { vcl.push(nal); if (t === 5) key = true; } // skip AUD/SEI
        }
        const ms = buf[s + 20] | (buf[s + 21] << 8), at = dhavTime(buf, s);
        buf = buf.subarray(s + len);
        if (vcl.length) yield { key, vcl, sps, pps, ms, at };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
