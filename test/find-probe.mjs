// Read-only: why does the recordings search fail for a channel? Compares the NVR's
// answers for that channel and channel 1 (makes NO changes).
//   NVR_HOST=192.168.1.108 NVR_PASS=... node test/find-probe.mjs 5
import { digestFetch } from '../lib/dahua.js';

const { NVR_HOST, NVR_USER = 'admin', NVR_PASS } = process.env;
if (!NVR_HOST || !NVR_PASS) { console.error('set NVR_HOST and NVR_PASS'); process.exit(1); }
const [host, port = 80] = NVR_HOST.split(':');
const conn = { host, port: +port, user: NVR_USER, pass: NVR_PASS };
const ch = +(process.argv[2] || 5);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const get = async (uri) => { const r = await digestFetch(conn, uri); return { status: r.status, body: (await r.text()).trim() }; };
const short = (b) => b.replace(/\r?\n/g, ' | ').slice(0, 160);

// How is this channel set to record?
for (const name of ['RecordMode', 'Record']) {
  const { status, body } = await get(`/cgi-bin/configManager.cgi?action=getConfig&name=${name}`);
  const mine = body.split(/\r?\n/).filter((l) => l.includes(`[${ch - 1}]`)).slice(0, name === 'Record' ? 6 : 10);
  console.log(`${name} (HTTP ${status}) for channel ${ch}:\n  ${mine.length ? mine.join('\n  ') : short(body)}`);
}

async function find(channel, from, to, extra = '') {
  const { body: created } = await get('/cgi-bin/mediaFileFind.cgi?action=factory.create');
  const object = (created.match(/result=(\S+)/) || [])[1];
  if (!object) return `factory.create failed: ${short(created)}`;
  const q = `/cgi-bin/mediaFileFind.cgi?action=findFile&object=${object}&condition.Channel=${channel - 1}` +
    `&condition.StartTime=${encodeURIComponent(fmt(from))}&condition.EndTime=${encodeURIComponent(fmt(to))}${extra}`;
  const f = await get(q);
  let out = `findFile HTTP ${f.status} "${short(f.body)}"`;
  if (f.status === 200) {
    const n = await get(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${object}&count=5`);
    const first = (n.body.match(/items\[0\]\.StartTime=(.+)/) || [])[1];
    out += ` → findNextFile HTTP ${n.status}, ${(n.body.match(/found=(\d+)/) || [])[1] ?? '?'} found${first ? `, first ${first.trim()}` : ''}`;
  }
  await get(`/cgi-bin/mediaFileFind.cgi?action=close&object=${object}`).catch(() => {});
  await get(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${object}`).catch(() => {});
  return out;
}

const now = new Date(), day0 = new Date(now); day0.setHours(0, 0, 0, 0);
const ranges = [
  ['last hour', new Date(now - 3600e3), now],
  ['today', day0, now],
  ['yesterday', new Date(day0 - 86400e3), new Date(day0 - 1000)],
  ['last 7 days', new Date(day0 - 6 * 86400e3), now],
];
for (const c of [ch, 1]) {
  console.log(`\n== channel ${c}`);
  for (const [label, a, b] of ranges) console.log(`  ${label.padEnd(12)} ${await find(c, a, b)}`);
  console.log(`  ${'today, dav'.padEnd(12)} ${await find(c, day0, now, '&condition.Types[0]=dav')}`);
}
