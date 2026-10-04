// Read-only check of recording playback against a real NVR (makes NO changes).
// Answers what the timeline player relies on: do DHAV timestamps match the
// requested time, is the sub stream stored (fast playback), how fast does the
// NVR stream (max useful speed), and what comes back for a time with no video.
//   NVR_HOST=192.168.1.108 NVR_USER=admin NVR_PASS=... node test/playback-probe.mjs [channel]
import * as dahua from '../lib/dahua.js';
import { dhavTime } from '../lib/h264play.js';

const { NVR_HOST, NVR_USER = 'admin', NVR_PASS } = process.env;
if (!NVR_HOST || !NVR_PASS) { console.error('set NVR_HOST and NVR_PASS'); process.exit(1); }
const [host, port = 80] = NVR_HOST.split(':');
const conn = { host, port: +port, user: NVR_USER, pass: NVR_PASS };
const channel = +(process.argv[2] || 1);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const toMs = (s) => { const m = s.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/); return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); };

/** Stream [from, from+secs] and summarise the DHAV frames (reads at most maxMs). */
async function probe(from, secs, subtype, maxMs = 15000) {
  const ctrl = new AbortController(); const t0 = Date.now();
  const res = await dahua.downloadClip(conn, channel, fmt(from), fmt(from + secs * 1000), subtype, ctrl.signal);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0), bytes = 0, video = 0, keys = 0, first = null, last = null;
  const deltas = []; let prevMs = null;
  try {
    while (Date.now() - t0 < maxMs) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length;
      const n = new Uint8Array(buf.length + value.length); n.set(buf); n.set(value, buf.length); buf = n;
      for (;;) {
        let s = -1; for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x44 && buf[i + 1] === 0x48 && buf[i + 2] === 0x41 && buf[i + 3] === 0x56) { s = i; break; }
        if (s < 0 || buf.length < s + 24) break;
        const len = (buf[s + 12] | (buf[s + 13] << 8) | (buf[s + 14] << 16) | (buf[s + 15] << 24)) >>> 0;
        if (len < 24 || len > 5e6) { buf = buf.subarray(s + 4); continue; }
        if (buf.length < s + len) break;
        const type = buf[s + 4];
        if (type === 0xfd || type === 0xfc) {
          video++; if (type === 0xfd) keys++;
          const t = dhavTime(buf, s); if (t != null) { first ??= t; last = t; }
          const ms = buf[s + 20] | (buf[s + 21] << 8);
          if (prevMs != null && deltas.length < 200) deltas.push((ms - prevMs + 65536) % 65536);
          prevMs = ms;
        }
        buf = buf.subarray(s + len);
      }
    }
  } finally { ctrl.abort(); }
  const secsRead = (Date.now() - t0) / 1000;
  const med = deltas.sort((a, b) => a - b)[deltas.length >> 1];
  return { status: res.status, bytes, video, keys, first, last, secsRead, fps: med ? Math.round(1000 / med) : null };
}

const now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
const files = await dahua.findRecordings(conn, channel, new Date(d0.getTime() - 86400e3), new Date(now));
if (!files.length) { console.error(`no recordings for channel ${channel} since yesterday`); process.exit(1); }
const f = files[files.length - 2] || files[files.length - 1];
const at = toMs(f.startTime) + 60e3; // a minute into a finished file
console.log(`channel ${channel}: ${files.length} files since yesterday; probing ${fmt(at)}\n`);

const main = await probe(at, 120, 0);
const skew = main.first != null ? Math.round((main.first - at) / 1000) : '?';
console.log(`main stream: ${main.video} frames (${main.keys} key) in ${main.secsRead.toFixed(1)}s, ${(main.bytes / 1e6).toFixed(1)} MB, ~${main.fps} fps`);
console.log(`  first frame stamped ${main.first ? fmt(main.first) : 'n/a'} (asked ${fmt(at)}, skew ${skew}s)`);
const covered = main.first && main.last ? (main.last - main.first) / 1000 : 0;
console.log(`  streamed ${covered.toFixed(0)}s of video in ${main.secsRead.toFixed(1)}s → max real speed ≈ ${(covered / main.secsRead).toFixed(1)}×\n`);

const sub = await probe(at, 120, 1);
console.log(`sub stream: ${sub.video} frames in ${sub.secsRead.toFixed(1)}s, ${(sub.bytes / 1e6).toFixed(1)} MB` + (sub.video ? ` → max real speed ≈ ${(((sub.last - sub.first) / 1000) / sub.secsRead).toFixed(1)}×` : ' → NOT stored (fast playback will use the main stream)'));

const future = await probe(now + 3600e3, 30, 0, 5000);
console.log(`\nno-video time (1h in the future): HTTP ${future.status}, ${future.bytes} bytes, ${future.video} frames`);
