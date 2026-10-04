// Read-only: why does the recordings search fail for a channel? Compares the NVR's
// answers for that channel with the others (makes NO changes).
//   NVR_HOST=192.168.1.108 NVR_PASS=... node test/find-probe.mjs 5
import { digestFetch, listChannels, downloadClip } from '../lib/dahua.js';

const { NVR_HOST, NVR_USER = 'admin', NVR_PASS } = process.env;
if (!NVR_HOST || !NVR_PASS) { console.error('set NVR_HOST and NVR_PASS'); process.exit(1); }
const [host, port = 80] = NVR_HOST.split(':');
const conn = { host, port: +port, user: NVR_USER, pass: NVR_PASS };
const ch = +(process.argv[2] || 5);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const get = async (uri) => { const r = await digestFetch(conn, uri); return { status: r.status, body: (await r.text()).trim() }; };
const short = (b) => b.replace(/\r?\n/g, ' | ').slice(0, 120);
const nn = pad(ch);

// 1. Does the logged-in account have live/playback rights for this channel?
const me = await get(`/cgi-bin/userManager.cgi?action=getUserInfo&name=${encodeURIComponent(NVR_USER)}`);
const auth = [...me.body.matchAll(/AuthorityList\[\d+\]=(\S+)/g)].map((m) => m[1]);
const group = (me.body.match(/user\.Group=(\S+)/) || [])[1];
console.log(`account: group=${group ?? '?'} (HTTP ${me.status}), ${auth.length} rights; Monitor_${nn}: ${auth.includes(`Monitor_${nn}`)}, Replay_${nn}: ${auth.includes(`Replay_${nn}`)}` +
  `; playback rights for: ${auth.filter((a) => a.startsWith('Replay_')).map((a) => +a.slice(7)).join(',') || 'none listed'}`);

// 2. Recording mode of every channel (0 = schedule, 1 = always/manual, 2 = off).
const cams = await listChannels(conn);
const rm = (await get('/cgi-bin/configManager.cgi?action=getConfig&name=RecordMode')).body;
console.log('record mode per channel:', cams.map((c) => `${c.channel}=${(rm.match(new RegExp(`RecordMode\\[${c.channel - 1}\\]\\.Mode=(\\d+)`)) || [])[1] ?? '?'}`).join(' '));

async function find(channelIndex, from, to, extra = '') {
  const { body: created } = await get('/cgi-bin/mediaFileFind.cgi?action=factory.create');
  const object = (created.match(/result=(\S+)/) || [])[1];
  if (!object) return `factory.create failed: ${short(created)}`;
  const f = await get(`/cgi-bin/mediaFileFind.cgi?action=findFile&object=${object}&condition.Channel=${channelIndex}` +
    `&condition.StartTime=${encodeURIComponent(fmt(from))}&condition.EndTime=${encodeURIComponent(fmt(to))}${extra}`);
  let out = `HTTP ${f.status}`;
  if (f.status === 200) {
    const n = await get(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${object}&count=3`);
    const first = (n.body.match(/items\[0\]\.StartTime=(.+)/) || [])[1];
    const flags = [...new Set([...n.body.matchAll(/\.(?:Flags|Events)\[0\]=(\S+)/g)].map((m) => m[1]))].join('/');
    out += `, ${(n.body.match(/found=(\d+)/) || [])[1] ?? '?'} found${first ? ` from ${first.trim()}` : ''}${flags ? ` [${flags}]` : ''}`;
  } else out += ` "${short(f.body)}"`;
  await get(`/cgi-bin/mediaFileFind.cgi?action=close&object=${object}`).catch(() => {});
  await get(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${object}`).catch(() => {});
  return out;
}

// 3. Today's search on every channel.
const now = new Date(), day0 = new Date(now); day0.setHours(0, 0, 0, 0);
console.log('\nsearch today, per channel:');
for (const c of cams) console.log(`  ch ${c.channel}: ${await find(c.channel - 1, day0, now)}`);

// 4. Variants of the search for this channel.
console.log(`\nch ${ch} variants (today):`);
const variants = [
  ['Flags Timing', '&condition.Flags[0]=Timing'],
  ['Flags Manual', '&condition.Flags[0]=Manual'],
  ['Flags Event', '&condition.Flags[0]=Event'],
  ['Types dav', '&condition.Types[0]=dav'],
  ['Types jpg', '&condition.Types[0]=jpg'],
  ['VideoStream Main', '&condition.VideoStream=Main'],
];
for (const [label, extra] of variants) console.log(`  ${label.padEnd(17)} ${await find(ch - 1, day0, now, extra)}`);
console.log(`  ${'Channel=' + ch + ' (1-based)'.padEnd(10)} ${await find(ch, day0, now)}`);

// 5. Does playback work for this channel even though the search doesn't?
for (const c of [ch, 1]) {
  const at = new Date(now - 10 * 60e3), ctrl = new AbortController();
  try {
    const res = await downloadClip(conn, c, fmt(at), fmt(new Date(+at + 10e3)), 0, ctrl.signal);
    let bytes = 0; const reader = res.body.getReader(); const t0 = Date.now();
    while (Date.now() - t0 < 5000) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; }
    ctrl.abort();
    console.log(`\nplayback ch ${c} (10 s from 10 min ago): HTTP ${res.status}, ${(bytes / 1e6).toFixed(2)} MB`);
  } catch (e) { console.log(`\nplayback ch ${c}: ${e.message}`); }
}
