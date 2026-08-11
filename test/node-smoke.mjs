// Dev smoke test — exercises the shared browser client against a real device
// from Node (no CORS in Node, so it proves the digest/MJPEG/find/download logic
// that the extension relies on). Usage:
//   node test/node-smoke.mjs <ip> <user> <pass>
import { md5 } from '../lib/md5.js';
import * as dahua from '../lib/dahua.js';

// Sanity: known MD5 vectors.
console.assert(md5('') === 'd41d8cd98f00b204e9800998ecf8427e', 'md5("") wrong');
console.assert(md5('abc') === '900150983cd24fb0d6963f7d28e17f72', 'md5("abc") wrong');
console.log('md5 vectors OK');

const [ip, user, pass] = process.argv.slice(2);
if (!ip) { console.error('usage: node test/node-smoke.mjs <ip> <user> <pass>'); process.exit(1); }
const conn = { host: ip, port: 80, user, pass };

const info = await dahua.deviceInfo(conn);
console.log('device:', info);

const cams = await dahua.listChannels(conn);
console.log('channels:', cams.map((c) => `${c.channel}:${c.name}`).join(' | '));

// Pull a few MJPEG frames from channel 1.
let frames = 0, bytes = 0;
const ctrl = new AbortController();
const p = dahua.streamMjpeg(conn, 1, 1, (blob) => {
  frames++; bytes += blob.size;
  if (frames >= 10) ctrl.abort();
}, ctrl.signal).catch((e) => { if (e.name !== 'AbortError') throw e; });
await p;
console.log(`MJPEG ch1: got ${frames} frames, avg ${Math.round(bytes / Math.max(1, frames))}B/frame`);

// Recordings for channel 1 today.
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
const recs = await dahua.findRecordings(conn, 1, start, end);
console.log(`recordings ch1 today: ${recs.length}`);
if (recs.length) {
  const r = recs[recs.length - 1];
  console.log('  last clip:', r.startTime, '→', r.endTime, `(${r.durationSec}s, ${(r.length / 1e6).toFixed(1)}MB)`);
  // Verify download streams bytes (grab ~1MB then abort).
  const dc = new AbortController();
  const res = await dahua.downloadClip(conn, 1, r.startTime, r.endTime, 0, dc.signal);
  const reader = res.body.getReader();
  let dl = 0;
  while (dl < 1_000_000) { const { done, value } = await reader.read(); if (done) break; dl += value.length; }
  dc.abort();
  console.log(`  download stream OK: pulled ${(dl / 1e6).toFixed(2)}MB (HTTP ${res.status})`);
}
console.log('\nALL CHECKS PASSED');
