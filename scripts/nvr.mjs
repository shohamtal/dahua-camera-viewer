#!/usr/bin/env node
// Dahua NVR admin CLI — users, logs, exposure checks — over the device's HTTP
// CGI API, reusing the extension's digest client. Run `node scripts/nvr.mjs help`.
//
// Connection comes from env so the password stays out of argv:
//   NVR_HOST=192.168.1.108[:port]  NVR_USER=admin  NVR_PASS=...
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import * as dahua from '../lib/dahua.js';

const HELP = `
Dahua NVR CLI    (env: NVR_HOST, NVR_USER [admin], NVR_PASS)

 Device
   info                         model, serial, firmware, channels
   exposure                     UPnP port maps, P2P cloud, ports, logged-in sessions
   upnp on|off                  enable/disable UPnP router port mapping
   p2p on|off                   enable/disable Dahua P2P cloud (DMSS app remote access)

 Users
   users [-v]                   list accounts (-v: full permission list)
   active                       who is logged in right now, from where
   adduser <name> [opts]        create a limited (user-group) account
       --password <pw>            default: random, printed once
       --channels all|1,2,5       default: all
       --no-playback              live view only
   bulkadd <prefix> <from> <to> [same opts]   e.g. bulkadd apt 1 26 -> apt1..apt26
                                  writes <prefix>-accounts.csv (chmod 600)
   deluser <name>...            delete account(s)
   passwd <name> [newpw]        reset password (random if omitted)
   perms <name> [--channels ..] [--no-playback]   change camera access of a user-group account

 Logs
   log [opts]                   device log, newest last
       --last N                   default 50
       --from "YYYY-MM-DD[ HH:MM:SS]"  --to "..."   default: everything
       --grep <text>              filter (type/user/detail, case-insensitive)

 Flags: --yes skips confirmation on destructive commands.
`;

// ---------- args / conn ----------
const argv = process.argv.slice(2);
const cmd = argv.shift();
const pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['yes', 'no-playback'].includes(k)) opt[k] = true;
    else opt[k] = argv[++i];
  } else if (a === '-v') opt.v = true;
  else pos.push(a);
}
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(HELP); process.exit(0); }

const { NVR_HOST, NVR_USER = 'admin', NVR_PASS } = process.env;
if (!NVR_HOST || !NVR_PASS) { console.error('Set NVR_HOST and NVR_PASS (and NVR_USER if not admin). See: node scripts/nvr.mjs help'); process.exit(1); }
const [host, port = 80] = NVR_HOST.split(':');
const conn = { host, port: +port, user: NVR_USER, pass: NVR_PASS };

// ---------- helpers ----------
async function cgi(uri) {
  const res = await dahua.digestFetch(conn, uri);
  const body = await res.text();
  if (res.status === 401) {
    throw new Error(`login rejected for "${NVR_USER}" — check NVR_PASS (still the placeholder?). ` +
      'Careful: repeated wrong passwords lock the account for a while.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${uri.replace(/(Password|pwd\w*)=[^&]*/gi, '$1=***')}: ${body.trim()}`);
  return body;
}
const enc = encodeURIComponent;

// "a[0].B[1].C=v" lines -> nested objects/arrays.
function parseTable(body) {
  const root = {};
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const path = line.slice(0, i).trim().replace(/\[(\d+)\]/g, '.$1').split('.');
    let o = root;
    path.forEach((k, j) => {
      if (j === path.length - 1) o[k] = line.slice(i + 1).trim();
      else o = o[k] ??= /^\d+$/.test(path[j + 1]) ? [] : {};
    });
  }
  return root;
}

async function getUsers() {
  return (parseTable(await cgi('/cgi-bin/userManager.cgi?action=getUserInfoAll')).users || []).filter(Boolean);
}

async function confirm(q) {
  if (opt.yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

function genPassword() {
  const L = 'abcdefghjkmnpqrstuvwxyz', U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789';
  const pick = (s) => s[randomInt(s.length)];
  const c = [pick(L), pick(U), pick(D), ...Array.from({ length: 7 }, () => pick(L + U + D))];
  for (let i = c.length - 1; i > 0; i--) { const j = randomInt(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join('');
}

async function channelList(spec) {
  const cams = await dahua.listChannels(conn);
  if (!spec || spec === 'all') return cams.map((c) => c.channel);
  const want = spec.split(',').map((s) => parseInt(s, 10));
  const bad = want.filter((n) => !cams.some((c) => c.channel === n));
  if (bad.length) throw new Error(`no such channel(s): ${bad.join(',')} (device has 1..${cams.length})`);
  return want;
}

function authorities(chans, playback) {
  const out = [];
  for (const ch of chans) {
    const n = String(ch).padStart(2, '0');
    out.push(`Monitor_${n}`);
    if (playback) out.push(`Replay_${n}`);
  }
  return out;
}

async function addUser({ name, password, group = 'user', memo = '', auth }) {
  const q = [
    'action=addUser', `user.Name=${enc(name)}`, `user.Password=${enc(password)}`,
    `user.Group=${enc(group)}`, 'user.Sharable=true', 'user.Reserved=false', `user.Memo=${enc(memo)}`,
    ...auth.map((a, i) => `user.AuthorityList[${i}]=${enc(a)}`),
  ].join('&');
  return (await cgi(`/cgi-bin/userManager.cgi?${q}`)).trim();
}

const summarize = (auth) => {
  const mon = auth.filter((a) => a.startsWith('Monitor_')).map((a) => +a.slice(8));
  const rep = auth.filter((a) => a.startsWith('Replay_')).map((a) => +a.slice(7));
  const sys = auth.filter((a) => a.startsWith('Auth'));
  return `live:[${mon.join(',')}] playback:[${rep.join(',')}]` + (sys.length ? ` +${sys.length} system perms` : '');
};

// ---------- commands ----------
const commands = {
  async info() {
    console.log(await dahua.deviceInfo(conn));
    for (const c of await dahua.listChannels(conn)) console.log(`  ch${c.channel}: ${c.name}`);
  },

  async users() {
    const rows = (await getUsers()).map((u) => ({
      id: u.Id, name: u.Name, group: u.Group, memo: u.Memo || '',
      access: opt.v ? (u.AuthorityList || []).join(',') : summarize(u.AuthorityList || []),
    }));
    console.table(rows);
  },

  async active() {
    const t = parseTable(await cgi('/cgi-bin/userManager.cgi?action=getActiveUserInfoAll'));
    console.table((t.users || []).filter(Boolean).map((u) => ({
      name: u.Name, group: u.Group, from: u.ClientAddress, via: u.ClientType, since: u.LoginTime,
    })));
  },

  async adduser() {
    const [name] = pos;
    if (!name) throw new Error('usage: adduser <name> [--password pw] [--channels all|1,2] [--no-playback]');
    const password = opt.password || genPassword();
    const chans = await channelList(opt.channels);
    const r = await addUser({ name, password, memo: opt.memo || '', auth: authorities(chans, !opt['no-playback']) });
    console.log(`${name}: ${r}\n  password: ${password}\n  cameras: ${chans.join(',')}  playback: ${!opt['no-playback']}`);
  },

  async bulkadd() {
    const [prefix, from, to] = pos;
    if (!prefix || !from || !to) throw new Error('usage: bulkadd <prefix> <from> <to> [--channels ..] [--no-playback]');
    const chans = await channelList(opt.channels);
    const auth = authorities(chans, !opt['no-playback']);
    const existing = new Set((await getUsers()).map((u) => u.Name));
    const out = [];
    for (let n = +from; n <= +to; n++) {
      const name = `${prefix}${n}`;
      if (existing.has(name)) { console.log(`skip ${name}: exists`); continue; }
      const password = genPassword();
      try {
        const r = await addUser({ name, password, memo: `${prefix} ${n}`, auth });
        out.push({ name, password, result: r });
      } catch (e) { out.push({ name, password: '', result: e.message }); }
    }
    console.table(out);
    const ok = out.filter((o) => o.result === 'OK');
    if (ok.length) {
      const file = `${prefix}-accounts.csv`;
      writeFileSync(file, 'username,password,cameras,playback\n' +
        ok.map((o) => `${o.name},${o.password},"${chans.join(' ')}",${!opt['no-playback']}`).join('\n') + '\n', { mode: 0o600 });
      console.log(`Saved ${file} (chmod 600) — hand out, then delete it.`);
    }
  },

  async deluser() {
    if (!pos.length) throw new Error('usage: deluser <name>...');
    const users = await getUsers();
    for (const name of pos) {
      const u = users.find((x) => x.Name === name);
      if (!u) { console.log(`${name}: no such user`); continue; }
      if (u.Reserved === 'true' || name === NVR_USER) { console.log(`${name}: refusing (reserved or the account you're logged in with)`); continue; }
      if (!(await confirm(`Delete ${name} (group ${u.Group}, memo "${u.Memo || ''}")?`))) continue;
      console.log(`${name}: ${(await cgi(`/cgi-bin/userManager.cgi?action=deleteUser&name=${enc(name)}`)).trim()}`);
    }
  },

  async passwd() {
    const [name, given] = pos;
    if (!name) throw new Error('usage: passwd <name> [newpw]');
    const password = given || genPassword();
    if (name === NVR_USER) {
      // Own account: the documented call, needs the current password.
      if (!(await confirm(`Change password of ${name} (the account this CLI uses)?`))) return;
      const r = await cgi(`/cgi-bin/userManager.cgi?action=modifyPassword&name=${enc(name)}&pwd=${enc(password)}&pwdOld=${enc(NVR_PASS)}`);
      console.log(`${name}: ${r.trim()}\n  new password: ${password}\n  -> update NVR_PASS`);
      return;
    }
    // Other accounts: the CGI API can't set another user's password without
    // knowing the old one, so recreate the account with identical settings.
    const u = (await getUsers()).find((x) => x.Name === name);
    if (!u) throw new Error(`${name}: no such user`);
    if (!(await confirm(`Reset password of ${name} (delete + recreate with the same group/permissions)?`))) return;
    await cgi(`/cgi-bin/userManager.cgi?action=deleteUser&name=${enc(name)}`);
    const r = await addUser({ name, password, group: u.Group, memo: u.Memo || '', auth: u.AuthorityList || [] });
    console.log(`${name}: ${r}\n  new password: ${password}`);
  },

  async perms() {
    const [name] = pos;
    if (!name) throw new Error('usage: perms <name> [--channels all|1,2] [--no-playback]');
    const u = (await getUsers()).find((x) => x.Name === name);
    if (!u) throw new Error(`${name}: no such user`);
    if (u.Group !== 'user') throw new Error(`${name} is in group "${u.Group}" — only user-group accounts are edited here`);
    const auth = authorities(await channelList(opt.channels), !opt['no-playback']);
    const q = [`action=modifyUser&name=${enc(name)}`, ...auth.map((a, i) => `user.AuthorityList[${i}]=${a}`)].join('&');
    console.log(`${name}: ${(await cgi(`/cgi-bin/userManager.cgi?${q}`)).trim()}  -> ${summarize(auth)}`);
  },

  async log() {
    const from = opt.from || '2000-01-01 00:00:00';
    const to = opt.to || '2037-12-31 23:59:59';
    const full = (s, end) => (s.length === 10 ? `${s} ${end ? '23:59:59' : '00:00:00'}` : s);
    const start = await cgi(`/cgi-bin/log.cgi?action=startFind&condition.StartTime=${enc(full(from))}&condition.EndTime=${enc(full(to, true))}`);
    const token = (start.match(/token=(\d+)/) || [])[1];
    if (!token) throw new Error(`log search failed: ${start}`);
    const items = [];
    try {
      for (;;) {
        const t = parseTable(await cgi(`/cgi-bin/log.cgi?action=doFind&token=${token}&count=100`));
        const got = (t.items || []).filter(Boolean);
        items.push(...got);
        if (got.length < 100) break;
      }
    } finally { await cgi(`/cgi-bin/log.cgi?action=stopFind&token=${token}`).catch(() => {}); }
    let rows = items.map((i) => ({
      time: i.Time, user: i.User || '', type: i.Type || '',
      detail: (i.Detail || '').replace(/\s+/g, ' ').trim(),
    }));
    if (opt.grep) {
      const g = opt.grep.toLowerCase();
      rows = rows.filter((r) => `${r.type} ${r.user} ${r.detail}`.toLowerCase().includes(g));
    }
    rows.sort((a, b) => a.time.localeCompare(b.time));
    const last = +(opt.last || 50);
    console.log(`${rows.length} entries${rows.length > last ? `, showing last ${last} (use --last N)` : ''}`);
    for (const r of rows.slice(-last)) console.log(`${r.time}  ${r.user.padEnd(10)}  ${r.type}  ${r.detail}`);
  },

  async exposure() {
    const get = async (n) => parseTable(await cgi(`/cgi-bin/configManager.cgi?action=getConfig&name=${n}`)).table?.[n];
    const [upnp, p2p, dvrip, web] = await Promise.all(['UPnP', 'T2UServer', 'DVRIP', 'Web'].map((n) => get(n).catch(() => null)));
    console.log(`Web port: ${web?.Port}   TCP (37777-style) port: ${dvrip?.TCPPort}   HTTPS/SSL: ${dvrip?.SSLPort}`);
    console.log(`UPnP: ${upnp?.Enable === 'true' ? 'ENABLED' : 'disabled'}`);
    for (const m of (upnp?.MapTable || []).filter(Boolean)) {
      if (m.Enable === 'true') console.log(`  !! router forwards internet ${m.Protocol} ${m.OuterPort} -> ${m.InnerPort} (${m.ServiceName})`);
    }
    const p = (Array.isArray(p2p) ? p2p : [p2p]).filter(Boolean);
    console.log(`P2P cloud: ${p.some((x) => x.Enable === 'true') ? `ENABLED (${p[0]?.RegisterServer || p[0]?.Address})` : 'disabled'}`);
    console.log('Logged in now:');
    await commands.active();
  },

  async upnp() {
    const on = pos[0] === 'on' ? 'true' : pos[0] === 'off' ? 'false' : null;
    if (!on) throw new Error('usage: upnp on|off');
    console.log((await cgi(`/cgi-bin/configManager.cgi?action=setConfig&UPnP.Enable=${on}`)).trim());
  },

  async p2p() {
    const on = pos[0] === 'on' ? 'true' : pos[0] === 'off' ? 'false' : null;
    if (!on) throw new Error('usage: p2p on|off');
    if (on === 'false' && !(await confirm('Disable P2P? The DMSS phone app will stop working remotely.'))) return;
    console.log((await cgi(`/cgi-bin/configManager.cgi?action=setConfig&T2UServer[0].Enable=${on}`)).trim());
  },
};

if (!commands[cmd]) { console.error(`unknown command: ${cmd}`); console.log(HELP); process.exit(1); }
try { await commands[cmd](); }
catch (e) { console.error('error:', e.message); process.exit(1); }
