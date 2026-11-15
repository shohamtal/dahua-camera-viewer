// NVR administration over the Dahua HTTP CGI API: users, device log, security
// and exposure checks, stream and clock settings. Isomorphic like dahua.js
// (only fetch/TextDecoder/crypto.getRandomValues), so the extension page and
// Node scripts/tests share it.
import { digestFetch } from './dahua.js';

// ---------- transport / parsing ----------

/** GET a CGI uri and return the body text; throws with a readable message. */
export async function cgi(conn, uri) {
  const res = await digestFetch(conn, uri);
  const body = await res.text();
  if (res.status === 401) throw new Error(`login rejected for "${conn.user}" (or this account lacks permission)`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.trim() || 'error'} (${uri.split('?')[0]})`);
  return body;
}

/**
 * Dahua "key=value" body -> [[key, value]] in order. Records are separated by
 * CRLF, but some values (log Detail) contain bare LFs, so any line that does
 * not start with a key= is a continuation of the previous value.
 */
export function parseLines(body) {
  const out = [];
  for (const line of String(body).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w.[\]:-]*)=(.*)$/);
    if (m) out.push([m[1], m[2]]);
    else if (out.length && line.trim()) out[out.length - 1][1] += '\n' + line;
  }
  return out.map(([k, v]) => [k, v.trim()]);
}

/** Dahua body -> nested objects/arrays ("a[0].B.C=v" -> {a:[{B:{C:v}}]}). */
export function parseTable(body) {
  const root = {};
  for (const [key, value] of parseLines(body)) {
    const path = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    // Device data is untrusted. Only walk into objects this parser made itself
    // (own properties): never __proto__, nor inherited members like toString,
    // which would change built-ins shared by the whole page. A key that runs
    // through a plain value ("a.b=x" then "a.b.c=y") is dropped.
    if (path.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) continue;
    let o = root;
    for (let j = 0; j < path.length && o; j++) {
      const k = path[j];
      if (j === path.length - 1) o[k] = value;
      else {
        if (!Object.hasOwn(o, k)) o[k] = /^\d+$/.test(path[j + 1]) ? [] : {};
        o = o[k] !== null && typeof o[k] === 'object' ? o[k] : null;
      }
    }
  }
  return root;
}

const enc = encodeURIComponent;
// Keep [ ] readable in config keys (Dahua expects them literally).
const encKey = (k) => enc(k).replace(/%5B/g, '[').replace(/%5D/g, ']');
const list = (a) => (Array.isArray(a) ? a.filter(Boolean) : a ? [a] : []);

export async function getConfig(conn, name) {
  return parseTable(await cgi(conn, `/cgi-bin/configManager.cgi?action=getConfig&name=${enc(name)}`)).table?.[name];
}

/** setConfig with a flat {key: value} map, e.g. {'Locales.DSTEnable': true}. */
export async function setConfig(conn, changes) {
  const q = Object.entries(changes).map(([k, v]) => `${encKey(k)}=${enc(String(v))}`).join('&');
  return (await cgi(conn, `/cgi-bin/configManager.cgi?action=setConfig&${q}`)).trim();
}

// ---------- passwords ----------

/** Random password meeting Dahua's rule (letters + digits), no look-alikes. */
export function genPassword(len = 10) {
  const L = 'abcdefghjkmnpqrstuvwxyz', U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', A = L + U + D;
  const rnd = (n) => { // unbiased index < n
    const b = new Uint32Array(1);
    const lim = Math.floor(2 ** 32 / n) * n;
    do globalThis.crypto.getRandomValues(b); while (b[0] >= lim);
    return b[0] % n;
  };
  const c = [L[rnd(L.length)], U[rnd(U.length)], D[rnd(D.length)]];
  while (c.length < len) c.push(A[rnd(A.length)]);
  for (let i = c.length - 1; i > 0; i--) { const j = rnd(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join('');
}

// ---------- users ----------

const toUser = (u) => ({
  id: u.Id, name: u.Name, group: u.Group, memo: u.Memo || '',
  reserved: u.Reserved === 'true', authorities: list(u.AuthorityList),
});

export async function getUsers(conn) {
  return list(parseTable(await cgi(conn, '/cgi-bin/userManager.cgi?action=getUserInfoAll')).users).map(toUser);
}

/** The logged-in account's info, or null when the device refuses to say. */
export async function getSelf(conn) {
  try {
    const u = parseTable(await cgi(conn, `/cgi-bin/userManager.cgi?action=getUserInfo&name=${enc(conn.user)}`)).user;
    return u ? toUser(u) : null;
  } catch { return null; }
}

/**
 * Whether the logged-in account is in the admin group. If the device won't
 * describe the account, probe the user list: limited accounts are refused it.
 */
export async function isAdminAccount(conn) {
  const self = await getSelf(conn);
  if (self) return self.group === 'admin';
  return getUsers(conn).then(() => true, () => false);
}

export async function getActiveUsers(conn) {
  return list(parseTable(await cgi(conn, '/cgi-bin/userManager.cgi?action=getActiveUserInfoAll')).users).map((u) => ({
    name: u.Name, group: u.Group, from: u.ClientAddress, via: u.ClientType, since: u.LoginTime,
  }));
}

/** Monitor_NN (live) and optionally Replay_NN (playback) for 1-based channels. */
export function authorities(channels, playback) {
  const out = [];
  for (const ch of channels) {
    const n = String(ch).padStart(2, '0');
    out.push(`Monitor_${n}`);
    if (playback) out.push(`Replay_${n}`);
  }
  return out;
}

export function summarizeAuth(auth) {
  const nums = (p) => auth.filter((a) => a.startsWith(p)).map((a) => +a.slice(p.length)).sort((a, b) => a - b);
  return { live: nums('Monitor_'), playback: nums('Replay_'), system: auth.filter((a) => a.startsWith('Auth')) };
}

export async function addUser(conn, { name, password, group = 'user', memo = '', auth }) {
  const q = [
    'action=addUser', `user.Name=${enc(name)}`, `user.Password=${enc(password)}`,
    `user.Group=${enc(group)}`, 'user.Sharable=true', 'user.Reserved=false', `user.Memo=${enc(memo)}`,
    ...auth.map((a, i) => `user.AuthorityList[${i}]=${enc(a)}`),
  ].join('&');
  return (await cgi(conn, `/cgi-bin/userManager.cgi?${q}`)).trim();
}

export async function deleteUser(conn, name) {
  return (await cgi(conn, `/cgi-bin/userManager.cgi?action=deleteUser&name=${enc(name)}`)).trim();
}

/**
 * New password for another account. The CGI API can't set someone else's
 * password without their old one, so recreate the account with the same
 * group, permissions and memo. (The built-in admin can't be reset this way.)
 */
export async function resetPassword(conn, user, password) {
  await deleteUser(conn, user.name);
  return addUser(conn, { name: user.name, password, group: user.group, memo: user.memo, auth: user.authorities });
}

export async function setUserAuthorities(conn, name, auth) {
  const q = [`action=modifyUser&name=${enc(name)}`, ...auth.map((a, i) => `user.AuthorityList[${i}]=${enc(a)}`)].join('&');
  return (await cgi(conn, `/cgi-bin/userManager.cgi?${q}`)).trim();
}

// ---------- log ----------

const pad = (n) => String(n).padStart(2, '0');
/** Date -> "YYYY-MM-DD HH:MM:SS" in local time (what the NVR expects). */
export function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** All log entries in [from, to] ("YYYY-MM-DD HH:MM:SS"), oldest first. */
export async function readLog(conn, { from = '2000-01-01 00:00:00', to = '2037-12-31 23:59:59' } = {}) {
  const start = await cgi(conn, `/cgi-bin/log.cgi?action=startFind&condition.StartTime=${enc(from)}&condition.EndTime=${enc(to)}`);
  const token = (start.match(/token=(\d+)/) || [])[1];
  if (!token) throw new Error('log search failed: ' + start.trim());
  const items = [];
  try {
    for (let guard = 0; guard < 100; guard++) {
      const got = list(parseTable(await cgi(conn, `/cgi-bin/log.cgi?action=doFind&token=${token}&count=100`)).items);
      items.push(...got);
      if (got.length < 100) break;
    }
  } finally {
    await cgi(conn, `/cgi-bin/log.cgi?action=stopFind&token=${token}`).catch(() => {});
  }
  return items.map((i) => {
    const detail = (i.Detail || '').replace(/\s+/g, ' ').trim();
    return { time: i.Time || '', user: i.User || '', type: i.Type || '', detail, ip: (detail.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) || [])[0] || '' };
  }).sort((a, b) => a.time.localeCompare(b.time));
}

/** Private/loopback address (LAN, the P2P relay's 127.0.0.1, or CGNAT 100.64/10 as used by Tailscale). */
export function isLocalIp(ip) {
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

/**
 * An address that isn't on the local network. Sessions on the NVR's own screen
 * report a word ("Local"), not an address: those aren't outside. IPv6 counts as
 * local only for loopback, link-local (fe80::/10) and unique-local (fc00::/7).
 */
export function isOutsideIp(from) {
  let a = String(from || '').trim().toLowerCase().replace(/^\[|\](:\d+)?$/g, '');
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) a = mapped[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return !isLocalIp(a);
  if (/^[0-9a-f:]+$/.test(a) && a.includes(':')) return !(a === '::1' || /^fe[89ab]/.test(a) || /^f[cd]/.test(a));
  return false;
}

/**
 * One CSV cell. Device strings are untrusted: a value starting with = + - @ (or
 * tab / CR) would run as a formula in a spreadsheet, so it gets a leading '.
 */
export function csvCell(v) {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
}

// Event types are localized by the device; match user-management events in
// the languages seen in practice (English, Hebrew) plus generic wording.
const USER_EVENT = /(add|delete|remove|modify|edit)\w*\s*(user|account)|(user|account)\s*(add|delete|remov|modif|edit)|(הוסף|מחק|ערוך|הסר)\s*משתמש|משתמש\s*(נוסף|נמחק)/i;
export const isUserEvent = (e) => USER_EVENT.test(`${e.type} ${e.detail}`);

// ---------- device / security ----------

export async function deviceDetails(conn) {
  const kv = async (a) => Object.fromEntries(parseLines(await cgi(conn, `/cgi-bin/magicBox.cgi?action=${a}`).catch(() => '')));
  const [type, sn, ver, hw, sys] = await Promise.all(['getDeviceType', 'getSerialNo', 'getSoftwareVersion', 'getHardwareVersion', 'getSystemInfo'].map(kv));
  const [version, build] = (ver.version || '').split(',').map((s) => s.trim());
  const buildDate = (build || '').replace(/^build:\s*/i, '');
  return {
    type: type.type || sys.deviceType || '', serial: sn.sn || sys.serialNumber || '',
    version: version || '', buildDate, hardware: hw.version || '',
    updateSerial: sys.updateSerial || '', processor: sys.processor || '',
    // CVE-2021-33044/33045 (auth bypass, actively exploited): Dahua's advisory and
    // fixed builds date from September 2021. true = older build, false = newer,
    // null = the build date couldn't be read (never report that as fine).
    vulnerable: /^\d{4}-\d{2}/.test(buildDate) ? buildDate.slice(0, 7) < '2021-09' : null,
  };
}

export async function exposure(conn) {
  // A failed read is "unknown" (known: false), never "off".
  // "This model has no such setting" (HTTP 400/404) is a real answer: off.
  const failed = new Set();
  const get = (n) => getConfig(conn, n).catch((e) => { if (!/^HTTP 40[04]\b/.test(e.message)) failed.add(n); return null; });
  const [upnp, p2p, dvrip, web] = await Promise.all(['UPnP', 'T2UServer', 'DVRIP', 'Web'].map(get));
  const upnpOn = upnp?.Enable === 'true';
  const p2pList = list(p2p);
  return {
    upnp: {
      known: !failed.has('UPnP'),
      enabled: upnpOn,
      maps: list(upnp?.MapTable).filter((m) => m.Enable === 'true')
        .map((m) => ({ proto: m.Protocol, outer: m.OuterPort, inner: m.InnerPort, name: m.ServiceName })),
    },
    p2p: { known: !failed.has('T2UServer'), enabled: p2pList.some((x) => x.Enable === 'true'), server: p2pList[0]?.RegisterServer || p2pList[0]?.Address || '' },
    ports: { web: web?.Port || '', tcp: dvrip?.TCPPort || '', udp: dvrip?.UDPPort || '', ssl: dvrip?.SSLPort || '' },
  };
}

// ---------- streams ----------

/** Per-channel sub-stream settings + connected camera model (1-based channel). */
export async function streamInfo(conn) {
  const [encode, remote] = await Promise.all([getConfig(conn, 'Encode'), getConfig(conn, 'RemoteDevice').catch(() => ({}))]);
  const cams = {};
  for (const [k, v] of Object.entries(remote || {})) {
    const m = k.match(/_(\d+)$/); // uuid:System_CONFIG_NETCAMERA_INFO_<index>
    if (m && v?.Enable === 'true') cams[+m[1] + 1] = { model: v.DeviceType || '', address: v.Address || '', version: v.Version || '' };
  }
  // Keep array positions: empty channels leave holes, and index = channel - 1.
  return Array.from(Array.isArray(encode) ? encode : [], (e, i) => {
    const sub = e?.ExtraFormat?.[0];
    const v = sub?.Video;
    return v ? {
      channel: i + 1, enabled: sub.VideoEnable === 'true', compression: v.Compression,
      width: +v.Width, height: +v.Height, fps: +v.FPS, bitrate: +v.BitRate, control: v.BitRateControl,
      camera: cams[i + 1] || null,
    } : null;
  }).filter(Boolean);
}

export const subStreamKey = (channel, field) => `Encode[${channel - 1}].ExtraFormat[0].Video.${field}`;

// ---------- clock ----------

export async function getTime(conn) {
  return (await cgi(conn, '/cgi-bin/global.cgi?action=getCurrentTime')).match(/result=(.+)/)?.[1]?.trim() || '';
}

export async function setTime(conn, localTime) {
  return (await cgi(conn, `/cgi-bin/global.cgi?action=setCurrentTime&time=${enc(localTime)}`)).trim();
}

export async function clockConfig(conn) {
  const [locales, ntp] = await Promise.all([getConfig(conn, 'Locales'), getConfig(conn, 'NTP')]);
  return { locales: locales || {}, ntp: ntp || {} };
}
