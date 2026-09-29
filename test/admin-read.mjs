// Read-only check of lib/admin.js against a real device (makes NO changes).
//   NVR_HOST=192.168.1.108 NVR_USER=admin NVR_PASS=... node test/admin-read.mjs
import * as admin from '../lib/admin.js';

const { NVR_HOST, NVR_USER = 'admin', NVR_PASS } = process.env;
if (!NVR_HOST || !NVR_PASS) { console.error('set NVR_HOST and NVR_PASS'); process.exit(1); }
const [host, port = 80] = NVR_HOST.split(':');
const conn = { host, port: +port, user: NVR_USER, pass: NVR_PASS };

// Pure helpers first (no device).
const t = admin.parseTable('items[0].Detail=IP: 1.2.3.4\nuser: a\n\r\nitems[0].Time=2026-01-01 00:00:00\r\nx.y[1].z=v');
console.assert(t.items[0].Detail === 'IP: 1.2.3.4\nuser: a' && t.x.y[1].z === 'v', 'parseTable');
console.assert(admin.isLocalIp('192.168.0.5') && admin.isLocalIp('127.0.0.1') && admin.isLocalIp('172.20.1.1') && !admin.isLocalIp('8.8.8.8') && !admin.isLocalIp('172.32.0.1'), 'isLocalIp');
const pw = admin.genPassword();
console.assert(pw.length === 10 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw), 'genPassword');
console.assert(admin.authorities([1, 5], true).join() === 'Monitor_01,Replay_01,Monitor_05,Replay_05', 'authorities');
console.log('helpers OK');

const self = await admin.getSelf(conn);
console.log('self:', self && { name: self.name, group: self.group });
const users = await admin.getUsers(conn);
console.log('users:', users.map((u) => `${u.name}(${u.group}) live:${admin.summarizeAuth(u.authorities).live.length}`).join(' '));
console.log('active:', (await admin.getActiveUsers(conn)).map((a) => `${a.name}@${a.from}/${a.via}`).join(' '));
console.log('device:', await admin.deviceDetails(conn));
console.log('exposure:', JSON.stringify(await admin.exposure(conn)));
console.log('streams:', (await admin.streamInfo(conn)).map((s) => `ch${s.channel} ${s.compression} ${s.width}x${s.height}@${s.fps} ${s.bitrate}kbps ${s.camera?.model || '-'}`).join(' | '));
const clock = await admin.clockConfig(conn);
console.log('time:', await admin.getTime(conn), '| browser:', admin.fmtLocal(new Date()), '| DST', clock.locales.DSTEnable, '| NTP', clock.ntp.Enable, clock.ntp.Address);
const log = await admin.readLog(conn, { from: admin.fmtLocal(new Date(Date.now() - 86400e3)) });
console.log(`log (24h): ${log.length} entries, non-local IPs: ${log.filter((e) => e.ip && !admin.isLocalIp(e.ip)).length}, user events: ${log.filter(admin.isUserEvent).length}`);
console.log('last:', log.slice(-2));
