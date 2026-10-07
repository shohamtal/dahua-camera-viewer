// Admin tab: security overview, users, device log, sub-streams and clock — a
// UI over lib/admin.js. Each section loads when first opened; after every
// change it re-reads the device so the page shows what the NVR really stored.
import * as admin from './lib/admin.js';

let conn = null;
let cameras = [];
let current = 'overview';
const loaded = new Set();

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) n.append(k);
  return n;
}
const $ = (id) => document.getElementById(id);

export function initAdmin(c, cams) {
  conn = c; cameras = cams; loaded.clear();
  document.querySelectorAll('#admin-nav button').forEach((b) => b.addEventListener('click', () => openSection(b.dataset.sec)));
}

export function showAdmin() { openSection(current); }
/** Pick the section the Admin tab opens on next (e.g. 'streams' from the live grid). */
export function setAdminSection(name) { current = name; }

function openSection(name) {
  current = name;
  document.querySelectorAll('#admin-nav button').forEach((b) => b.classList.toggle('active', b.dataset.sec === name));
  document.querySelectorAll('.adm-sec').forEach((s) => s.classList.toggle('hidden', s.id !== `adm-${name}`));
  if (!loaded.has(name)) { loaded.add(name); SECTIONS[name]($(`adm-${name}`)); }
}

// ---------- shared bits ----------

/** Replace root's content with the result of an async render, showing load/error states. */
async function load(root, render) {
  root.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
  try { root.replaceChildren(...[].concat(await render())); }
  catch (e) { root.replaceChildren(el('p', { className: 'msg error', textContent: e.message }), el('button', { textContent: 'Retry', onclick: () => load(root, render) })); }
}

/** Run a device change from a button: disable it, report errors on `msg`. */
async function act(btn, msg, fn) {
  btn.disabled = true; if (msg) { msg.textContent = ''; msg.className = 'msg'; }
  try { await fn(); }
  catch (e) { if (msg) { msg.textContent = e.message; msg.classList.add('error'); } else alert(e.message); }
  finally { btn.disabled = false; }
}

const ok = (r, what) => { if (!/^OK\b/i.test(r)) throw new Error(`${what}: ${r || 'no answer'}`); return r; };
const card = (title, ...kids) => el('div', { className: 'adm-card' }, el('h3', { textContent: title }), ...kids);
const kv = (pairs) => el('dl', { className: 'kv' }, ...pairs.filter(([, v]) => v !== '' && v != null).flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
const badge = (text, kind = '') => el('span', { className: `badge ${kind}`, textContent: text });
const flag = (kind, text) => el('li', { className: `flag ${kind}`, textContent: text });

function table(head, rows) {
  return el('div', { className: 'tbl-wrap' }, el('table', { className: 'tbl' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...rows)));
}

const camName = (ch) => cameras.find((c) => c.channel === ch)?.name || `ch ${ch}`;
function channelsText(nums) {
  if (!nums.length) return 'none';
  if (cameras.length && cameras.every((c) => nums.includes(c.channel))) return 'all';
  return nums.join(', ');
}

/** Checkbox grid of cameras; get() returns the ticked 1-based channels. */
function channelPicker(selected = cameras.map((c) => c.channel)) {
  const boxes = cameras.map((c) => el('input', { type: 'checkbox', value: c.channel, checked: selected.includes(c.channel) }));
  const setAll = (v) => boxes.forEach((b) => { b.checked = v; });
  const node = el('div', { className: 'ch-pick' },
    el('div', { className: 'ch-pick-head' }, el('span', { className: 'muted', textContent: 'Cameras' }),
      el('button', { type: 'button', className: 'link', textContent: 'all', onclick: () => setAll(true) }),
      el('button', { type: 'button', className: 'link', textContent: 'none', onclick: () => setAll(false) })),
    el('div', { className: 'ch-grid' }, ...boxes.map((b, i) => el('label', { className: 'check' }, b, `${cameras[i].channel}. ${cameras[i].name}`))));
  return { node, get: () => boxes.filter((b) => b.checked).map((b) => +b.value) };
}

/** Dahua's rule: 8–32 chars, at least two of letters / digits / symbols. */
function passwordProblem(pw) {
  if (pw.length < 8 || pw.length > 32) return 'Password must be 8–32 characters';
  const kinds = [/[a-z]/i, /\d/, /[^a-z\d]/i].filter((r) => r.test(pw)).length;
  return kinds < 2 ? 'Password must mix at least two of letters, digits and symbols' : '';
}

// ---------- security overview ----------

function renderOverview(root) {
  return load(root, async () => {
    const [dev, exp, active, users] = await Promise.all([
      admin.deviceDetails(conn), admin.exposure(conn),
      admin.getActiveUsers(conn).catch(() => []), admin.getUsers(conn).catch(() => null),
    ]);
    const msg = el('p', { className: 'msg' });
    const reload = () => renderOverview(root);

    const flags = [];
    if (dev.vulnerable) flags.push(flag('bad', `Firmware build ${dev.buildDate} predates the 2021 fix for an actively exploited login bypass (CVE-2021-33044/33045). Update it from Dahua's download center for your exact model — until then, deleted rogue accounts can come back.`));
    if (exp.upnp.enabled) flags.push(flag('bad', `UPnP is on${exp.upnp.maps.length ? `, forwarding ${exp.upnp.maps.map((m) => `${m.proto} ${m.outer}`).join(', ')}` : ''}: the NVR can open ports on your router to the internet.`));
    const admins = (users || []).filter((u) => u.group === 'admin' && !u.reserved);
    if (admins.length) flags.push(flag('warn', `${admins.length} extra admin-group account(s): ${admins.map((u) => u.name).join(', ')}. Delete any you don't recognise (see Users).`));
    const outside = active.filter((a) => a.from && !admin.isLocalIp(a.from));
    if (outside.length) flags.push(flag('warn', `Logged in right now from outside your network: ${outside.map((a) => `${a.name} @ ${a.from}`).join(', ')}.`));
    if (exp.p2p.enabled) flags.push(flag('info', 'P2P cloud is on (the DMSS app uses it for remote viewing). Turn it off if nobody needs that.'));
    if (!flags.length) flags.push(flag('good', 'No red flags found.'));

    const upnpBtn = el('button', { textContent: exp.upnp.enabled ? 'Turn UPnP off' : 'Turn UPnP on' });
    upnpBtn.onclick = () => {
      const on = !exp.upnp.enabled;
      if (on && !confirm('Turning UPnP on lets the NVR open ports on your router. Continue?')) return;
      act(upnpBtn, msg, async () => {
        ok(await admin.setConfig(conn, { 'UPnP.Enable': on }), 'UPnP');
        if (!on) alert('UPnP is off. Also delete any forwards it already created in your router\'s UPnP / port-forwarding page.');
        reload();
      });
    };
    const p2pBtn = el('button', { textContent: exp.p2p.enabled ? 'Turn P2P off' : 'Turn P2P on' });
    p2pBtn.onclick = () => {
      const on = !exp.p2p.enabled;
      if (!on && !confirm('With P2P off, the DMSS app stops working away from home. Continue?')) return;
      act(p2pBtn, msg, async () => { ok(await admin.setConfig(conn, { 'T2UServer[0].Enable': on }), 'P2P'); reload(); });
    };

    const ports = Object.entries(exp.ports).filter(([, v]) => v).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ');
    return [
      el('ul', { className: 'flags' }, ...flags),
      msg,
      el('div', { className: 'adm-cards' },
        card('Device', kv([
          ['Model', dev.type], ['Serial', dev.serial], ['Firmware', dev.version],
          ['Build', dev.buildDate ? el('span', {}, dev.buildDate, ' ', dev.vulnerable ? badge('vulnerable', 'bad') : badge('ok', 'good')) : ''],
          ['Hardware', dev.hardware], ['Processor', dev.processor],
        ])),
        card('Internet exposure', kv([
          ['UPnP', el('span', {}, exp.upnp.enabled ? badge('on', 'bad') : badge('off', 'good'), ' ', upnpBtn)],
          ['Forwards', exp.upnp.maps.map((m) => `${m.proto} ${m.outer}→${m.inner}${m.name ? ` (${m.name})` : ''}`).join(', ') || (exp.upnp.enabled ? 'none' : '')],
          ['P2P cloud', el('span', {}, exp.p2p.enabled ? badge('on', 'warn') : badge('off', 'good'), ' ', p2pBtn)],
          ['P2P server', exp.p2p.enabled ? exp.p2p.server : ''],
          ['Ports', ports],
        ]))),
      card(`Logged in now (${active.length})`, active.length
        ? table(['User', 'Group', 'From', 'Via', 'Since'], active.map((a) => el('tr', { className: a.from && !admin.isLocalIp(a.from) ? 'row-warn' : '' },
          ...[a.name, a.group, a.from + (a.from?.startsWith('127.') ? ' (P2P relay)' : ''), a.via, a.since].map((t) => el('td', { textContent: t || '' })))))
        : el('p', { className: 'muted', textContent: 'Nobody (or this account can\'t see sessions).' })),
      el('button', { textContent: 'Re-check', onclick: reload }),
    ];
  });
}

// ---------- users ----------

function renderUsers(root) {
  // The notice sits outside the reloadable list so a new password stays visible.
  const notice = el('div');
  const body = el('div');
  root.replaceChildren(notice, body);

  const showPassword = (name, pw, what) => notice.replaceChildren(el('div', { className: 'secret' },
    el('div', {}, el('strong', { textContent: `${what}: ` }), `${name} / `, el('code', { textContent: pw })),
    el('div', { className: 'muted', textContent: 'Copy it now — it isn\'t stored anywhere and won\'t be shown again.' }),
    el('div', { className: 'row' },
      el('button', { textContent: 'Copy', onclick: (e) => navigator.clipboard.writeText(pw).then(() => { e.target.textContent = 'Copied'; }) }),
      el('button', { className: 'ghost', textContent: 'Dismiss', onclick: () => notice.replaceChildren() }))));

  const reload = () => load(body, async () => {
    const [users, self] = await Promise.all([admin.getUsers(conn), admin.getSelf(conn)]);
    const me = self?.name || conn.user;
    const msg = el('p', { className: 'msg' });
    const addBox = el('div');

    const addBtn = el('button', { className: 'primary', textContent: '+ Add user' });
    addBtn.onclick = () => { addBox.replaceChildren(userForm({
      onCancel: () => addBox.replaceChildren(),
      onSave: async ({ name, password, memo, channels, playback }) => {
        if (users.some((u) => u.name === name)) throw new Error(`"${name}" already exists`);
        ok(await admin.addUser(conn, { name, password, memo, auth: admin.authorities(channels, playback) }), 'add user');
        showPassword(name, password, 'New account');
        reload();
      },
    })); };

    const rows = users.map((u) => {
      const s = admin.summarizeAuth(u.authorities);
      const isMe = u.name === me;
      const suspicious = u.group === 'admin' && !u.reserved;
      const edit = el('tr', { className: 'hidden' }, el('td', { colSpan: 6 }));
      const acts = el('div', { className: 'acts' });

      if (!u.reserved && u.group !== 'admin') {
        acts.append(el('button', { textContent: 'Cameras', onclick: () => {
          edit.classList.toggle('hidden');
          edit.firstChild.replaceChildren(permsForm(u, s, { onCancel: () => edit.classList.add('hidden'), onSaved: reload }));
        } }));
      }
      if (!u.reserved && !isMe) {
        const pwBtn = el('button', { textContent: 'New password' });
        pwBtn.onclick = () => {
          if (!confirm(`Give "${u.name}" a new random password?\n\nThe NVR can't set another user's password directly, so the account is deleted and recreated with the same group, cameras and note. Anyone logged in as ${u.name} is signed out.`)) return;
          act(pwBtn, msg, async () => {
            const pw = admin.genPassword();
            ok(await admin.deleteUser(conn, u.name), 'delete');
            try { ok(await admin.addUser(conn, { name: u.name, password: pw, group: u.group, memo: u.memo, auth: u.authorities }), 'recreate'); }
            catch (e) { reload(); throw new Error(`"${u.name}" was deleted but recreating it failed (${e.message}). Add it again with + Add user.`); }
            showPassword(u.name, pw, 'New password');
            reload();
          });
        };
        const delBtn = el('button', { className: 'danger', textContent: 'Delete' });
        delBtn.onclick = () => {
          if (!confirm(`Delete the account "${u.name}"? This can't be undone.`)) return;
          act(delBtn, msg, async () => { ok(await admin.deleteUser(conn, u.name), 'delete'); reload(); });
        };
        acts.append(pwBtn, delBtn);
      }
      if (u.reserved || isMe) acts.append(el('span', { className: 'muted small', textContent: 'change password in the NVR web UI' }));

      const row = el('tr', { className: suspicious ? 'row-warn' : '' },
        el('td', {}, el('strong', { textContent: u.name }), isMe ? ' ' : '', isMe ? badge('you') : '', u.reserved ? ' ' : '', u.reserved ? badge('built-in') : ''),
        el('td', {}, u.group === 'admin' ? badge('admin', suspicious ? 'bad' : 'warn') : u.group),
        el('td', { textContent: u.group === 'admin' ? 'all' : channelsText(s.live) }),
        el('td', { textContent: u.group === 'admin' ? 'all' : channelsText(s.playback) }),
        el('td', { className: 'memo', textContent: u.memo }),
        el('td', {}, acts));
      return [row, edit];
    }).flat();

    return [
      el('div', { className: 'row' }, addBtn, el('span', { className: 'muted', textContent: `${users.length} account(s). Give each person their own limited account instead of sharing admin.` })),
      addBox, msg,
      table(['User', 'Group', 'Live', 'Playback', 'Note', ''], rows),
      el('p', { className: 'muted small', textContent: 'Highlighted: admin-group accounts other than the built-in one. Bots that exploit old firmware add these silently — delete any you don\'t recognise, then change the admin password and update the firmware.' }),
    ];
  });
  reload();
}

function userForm({ onSave, onCancel }) {
  const name = el('input', { placeholder: 'apt1', required: true, autocomplete: 'off' });
  const pw = el('input', { value: admin.genPassword(), autocomplete: 'off', spellcheck: false });
  const memo = el('input', { placeholder: 'e.g. apartment 1 — optional' });
  const playback = el('input', { type: 'checkbox', checked: true });
  const picker = channelPicker();
  const msg = el('p', { className: 'msg' });
  const save = el('button', { type: 'submit', className: 'primary', textContent: 'Create account' });
  const form = el('form', { className: 'adm-card adm-form' },
    el('h3', { textContent: 'New account' }),
    el('div', { className: 'form-row' },
      el('label', {}, 'Username', name),
      el('label', {}, 'Password', el('div', { className: 'with-btn' }, pw, el('button', { type: 'button', title: 'Generate another', textContent: '↻', onclick: () => { pw.value = admin.genPassword(); } }))),
      el('label', {}, 'Note', memo)),
    picker.node,
    el('label', { className: 'check' }, playback, 'Can watch recordings (playback)'),
    el('p', { className: 'muted small', textContent: 'Created in the "user" group with only live (and optionally playback) access to the chosen cameras — no settings, no PTZ, no user management.' }),
    el('div', { className: 'row' }, save, el('button', { type: 'button', className: 'ghost', textContent: 'Cancel', onclick: onCancel })),
    msg);
  form.onsubmit = (e) => {
    e.preventDefault();
    act(save, msg, async () => {
      const n = name.value.trim(), p = pw.value, channels = picker.get();
      if (!/^[\w.@-]{1,31}$/.test(n)) throw new Error('Username: letters, digits, _ . @ - only');
      const bad = passwordProblem(p); if (bad) throw new Error(bad);
      if (!channels.length) throw new Error('Pick at least one camera');
      await onSave({ name: n, password: p, memo: memo.value.trim(), channels, playback: playback.checked });
    });
  };
  setTimeout(() => name.focus());
  return form;
}

function permsForm(u, s, { onCancel, onSaved }) {
  const picker = channelPicker(s.live);
  const playback = el('input', { type: 'checkbox', checked: s.playback.length > 0 });
  const msg = el('p', { className: 'msg' });
  const save = el('button', { className: 'primary', textContent: 'Save' });
  save.onclick = () => act(save, msg, async () => {
    const channels = picker.get();
    if (!channels.length) throw new Error('Pick at least one camera');
    // Keep the account's non-camera rights; only the Monitor/Replay set changes.
    const other = u.authorities.filter((a) => !/^(Monitor|Replay)_\d+$/.test(a));
    ok(await admin.setUserAuthorities(conn, u.name, [...other, ...admin.authorities(channels, playback.checked)]), 'save');
    onSaved();
  });
  return el('div', { className: 'adm-form inline-edit' },
    picker.node,
    el('label', { className: 'check' }, playback, 'Playback on these cameras'),
    s.system.length ? el('p', { className: 'muted small', textContent: `Other rights kept as-is: ${s.system.join(', ')}` }) : '',
    el('div', { className: 'row' }, save, el('button', { className: 'ghost', textContent: 'Cancel', onclick: onCancel })),
    msg);
}

// ---------- log ----------

const toInput = (d) => admin.fmtLocal(d).slice(0, 16).replace(' ', 'T');
const fromInput = (v) => v.replace('T', ' ') + ':00';

function renderLog(root) {
  const from = el('input', { type: 'datetime-local', value: toInput(new Date(Date.now() - 86400e3)) });
  const to = el('input', { type: 'datetime-local', value: toInput(new Date(Date.now() + 60e3)) });
  const q = el('input', { type: 'search', placeholder: 'Filter: IP, user, event…' });
  const onlyOutside = el('input', { type: 'checkbox' });
  const onlyUsers = el('input', { type: 'checkbox' });
  const go = el('button', { className: 'primary', textContent: 'Load log' });
  const csv = el('button', { textContent: 'Save CSV', disabled: true });
  const status = el('span', { className: 'muted' });
  const out = el('div');
  let entries = [], shown = [];

  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    shown = entries.filter((e) => (!onlyOutside.checked || (e.ip && !admin.isLocalIp(e.ip)))
      && (!onlyUsers.checked || admin.isUserEvent(e))
      && (!needle || `${e.time} ${e.user} ${e.type} ${e.detail}`.toLowerCase().includes(needle)));
    const outsideN = entries.filter((e) => e.ip && !admin.isLocalIp(e.ip)).length;
    status.textContent = `${entries.length} entries · ${outsideN} from outside IPs · ${entries.filter(admin.isUserEvent).length} account changes${shown.length !== entries.length ? ` · showing ${shown.length}` : ''}`;
    csv.disabled = !shown.length;
    out.replaceChildren(table(['Time', 'User', 'Event', 'Detail'], shown.slice().reverse().map((e) =>
      el('tr', { className: admin.isUserEvent(e) ? 'row-bad' : e.ip && !admin.isLocalIp(e.ip) ? 'row-warn' : '' },
        el('td', { className: 'nowrap', textContent: e.time }), el('td', { textContent: e.user }),
        el('td', { textContent: e.type }), el('td', { className: 'detail', textContent: e.detail })))));
  };
  [q, onlyOutside, onlyUsers].forEach((i) => i.addEventListener('input', () => entries.length && draw()));

  go.onclick = () => act(go, null, async () => {
    status.textContent = 'Reading log…'; out.replaceChildren();
    try { entries = await admin.readLog(conn, { from: fromInput(from.value), to: fromInput(to.value) }); draw(); }
    catch (e) { status.textContent = ''; out.replaceChildren(el('p', { className: 'msg error', textContent: e.message })); }
  });
  csv.onclick = () => {
    const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const text = ['time,user,type,ip,detail', ...shown.map((e) => [e.time, e.user, e.type, e.ip, e.detail].map(cell).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    el('a', { href: url, download: `nvr-log-${from.value.slice(0, 10)}.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  root.replaceChildren(
    el('div', { className: 'toolbar' },
      el('label', { className: 'inline' }, 'From', from), el('label', { className: 'inline' }, 'To', to), go, csv),
    el('div', { className: 'toolbar' }, q,
      el('label', { className: 'check' }, onlyOutside, 'Outside IPs only'),
      el('label', { className: 'check' }, onlyUsers, 'Account changes only'), status),
    el('p', { className: 'muted small', textContent: 'The log is a ring buffer (~1024 entries) and every visit here adds a login/logout, so save it before investigating. Red rows: account added/changed/deleted. Amber: logins from outside your network (127.0.0.1 is the P2P relay). The CSV contains IPs and usernames — don\'t share it.' }),
    out);
}

// ---------- streams ----------

function renderStreams(root) {
  return load(root, async () => {
    const streams = await admin.streamInfo(conn);
    const msg = el('p', { className: 'msg' });
    const rows = streams.map((s) => {
      const codecs = [...new Set([s.compression, 'H.264', 'H.265', 'MJPG'])];
      const codec = el('select', {}, ...codecs.map((c) => el('option', { value: c, textContent: c, selected: c === s.compression })));
      const fps = el('input', { type: 'number', min: 1, max: 30, value: s.fps, className: 'num' });
      const rate = el('input', { type: 'number', min: 32, max: 8192, step: 32, value: s.bitrate, className: 'num' });
      const save = el('button', { textContent: 'Save', disabled: true });
      [codec, fps, rate].forEach((i) => i.addEventListener('input', () => { save.disabled = false; }));
      save.onclick = () => act(save, msg, async () => {
        const changes = {};
        if (codec.value !== s.compression) changes[admin.subStreamKey(s.channel, 'Compression')] = codec.value;
        if (+fps.value !== s.fps) changes[admin.subStreamKey(s.channel, 'FPS')] = +fps.value;
        if (+rate.value !== s.bitrate) changes[admin.subStreamKey(s.channel, 'BitRate')] = +rate.value;
        if (Object.keys(changes).length) ok(await admin.setConfig(conn, changes), `ch ${s.channel}`);
        renderStreams(root);
      });
      return el('tr', { className: s.enabled ? '' : 'row-dim' },
        el('td', { textContent: s.channel }),
        el('td', {}, camName(s.channel), s.camera?.model ? el('div', { className: 'muted small', textContent: s.camera.model }) : ''),
        el('td', {}, s.enabled ? badge('on', 'good') : badge('off')),
        el('td', {}, codec),
        el('td', { className: 'nowrap', textContent: `${s.width}×${s.height}` }),
        el('td', {}, fps), el('td', {}, rate, ' ', el('span', { className: 'muted small', textContent: s.control || '' })),
        el('td', {}, save));
    });
    return [
      el('p', { className: 'muted', textContent: 'Live tiles use each camera\'s sub-stream. More FPS / bitrate = smoother live view, but more load on the NVR and network.' }),
      msg,
      table(['Ch', 'Camera', 'Sub-stream', 'Codec', 'Size', 'FPS', 'Bitrate (kbps)', ''], rows),
    ];
  });
}

// ---------- clock ----------

function renderClock(root) {
  return load(root, async () => {
    const [nvrTime, cfg] = await Promise.all([admin.getTime(conn), admin.clockConfig(conn)]);
    const msg = el('p', { className: 'msg' });
    const reload = () => renderClock(root);
    const drift = Math.round((new Date(nvrTime.replace(' ', 'T')) - Date.now()) / 1000);
    const driftText = !nvrTime ? '' : Math.abs(drift) < 5 ? 'in sync' : `NVR is ${fmtSpan(Math.abs(drift))} ${drift > 0 ? 'ahead' : 'behind'}`;

    const sync = el('button', { className: 'primary', textContent: 'Set NVR clock to this computer' });
    sync.onclick = () => act(sync, msg, async () => { ok(await admin.setTime(conn, admin.fmtLocal(new Date())), 'set time'); reload(); });

    const ntpOn = el('input', { type: 'checkbox', checked: cfg.ntp.Enable === 'true' });
    const ntpAddr = el('input', { value: cfg.ntp.Address || '', placeholder: 'pool.ntp.org' });
    const ntpSave = el('button', { textContent: 'Save NTP' });
    ntpSave.onclick = () => act(ntpSave, msg, async () => {
      if (ntpOn.checked && !ntpAddr.value.trim()) throw new Error('Enter an NTP server');
      ok(await admin.setConfig(conn, { 'NTP.Enable': ntpOn.checked, 'NTP.Address': ntpAddr.value.trim() }), 'NTP');
      reload();
    });

    return [
      msg,
      el('div', { className: 'adm-cards' },
        card('Time', kv([
          ['NVR', nvrTime || '?'], ['This computer', admin.fmtLocal(new Date())],
          ['Difference', driftText ? (Math.abs(drift) < 60 ? driftText : el('span', {}, badge(driftText, 'warn'))) : ''],
          ['Time format', cfg.locales.TimeFormat], ['Daylight saving', cfg.locales.DSTEnable === 'true' ? 'on' : 'off'],
        ]), el('div', { className: 'row' }, sync, el('button', { className: 'ghost', textContent: 'Refresh', onclick: reload })),
        el('p', { className: 'muted small', textContent: 'Recording search uses the NVR\'s clock, so a wrong clock makes clips appear at the wrong time.' })),
        card('Network time (NTP)', el('div', { className: 'adm-form' },
          el('label', { className: 'check' }, ntpOn, 'Sync automatically'),
          el('label', {}, 'Server', ntpAddr),
          kv([['Port', cfg.ntp.Port], ['Every', cfg.ntp.UpdatePeriod ? `${cfg.ntp.UpdatePeriod} min` : ''], ['Time zone', cfg.ntp.TimeZoneDesc || cfg.ntp.TimeZone]]),
          el('div', { className: 'row' }, ntpSave)))),
    ];
  });
}

function fmtSpan(s) {
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

const SECTIONS = { overview: renderOverview, users: renderUsers, log: renderLog, streams: renderStreams, clock: renderClock };
