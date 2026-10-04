// Export a short window from a real NVR to an MP4 file (read-only on the NVR).
//   NVR_HOST=192.168.1.108 NVR_PASS=... node test/export-mp4.mjs <channel> "<YYYY-MM-DD HH:MM:SS>" <minutes> [out.mp4]
// Then check it: ffprobe out.mp4 (or open it in any player).
import fs from 'node:fs';
import { exportMp4 } from '../lib/mp4.js';

const { NVR_HOST, NVR_USER = 'admin', NVR_PASS } = process.env;
const [channel = '1', start, minutes = '1', out = 'export-test.mp4'] = process.argv.slice(2);
if (!NVR_HOST || !NVR_PASS || !start) { console.error('usage: NVR_HOST=ip NVR_PASS=… node test/export-mp4.mjs <channel> "<YYYY-MM-DD HH:MM:SS>" <minutes> [out.mp4]'); process.exit(1); }
const [host, port = 80] = NVR_HOST.split(':');
const conn = { host, port: +port, user: NVR_USER, pass: NVR_PASS };
const m = start.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/);
const from = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();

const fd = fs.openSync(out, 'w');
const sink = {
  write: (b) => { fs.writeSync(fd, b); },
  writeAt: (pos, b) => { fs.writeSync(fd, b, 0, b.length, pos); },
  close: () => fs.closeSync(fd),
};
const t0 = Date.now();
let last = -1;
const r = await exportMp4(conn, +channel, from, from + +minutes * 60e3, sink, {
  maxMs: 24 * 3600e3, // the UI caps at 20 min; the test allows more
  onProgress: (p) => { const pc = Math.floor(p * 10) * 10; if (pc !== last) { last = pc; process.stdout.write(`${pc}% `); } },
});
console.log(`\n${out}: ${r.width}x${r.height}, ${r.frames} frames, ${r.seconds.toFixed(1)} s of video` +
  (r.skippedMs ? `, ${Math.round(r.skippedMs / 1000)} s without recording skipped` : '') +
  `, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
