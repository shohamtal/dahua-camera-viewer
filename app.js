import * as dahua from './lib/dahua.js';
import { playRecording } from './lib/h264play.js';
import { initAdmin, showAdmin } from './admin-ui.js';
import { isAdminAccount } from './lib/admin.js';

// ---- saved NVRs (extension storage, localStorage fallback) ---------------
// `devices` is a list of {id, name, host, port, user, pass?, device}; `lastId`
// is the one to reopen. One entry per NVR (host:port); the password is kept
// only when "Remember" is ticked, and dropped on sign out.
const hasChromeStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const kv = {
  get: (k) => hasChromeStore
    ? new Promise((r) => chrome.storage.local.get(k, (d) => r(d[k] ?? null)))
    : Promise.resolve(JSON.parse(localStorage.getItem(k) || 'null')),
  set: (k, v) => hasChromeStore
    ? new Promise((r) => chrome.storage.local.set({ [k]: v }, r))
    : Promise.resolve(localStorage.setItem(k, JSON.stringify(v))),
  remove: (k) => hasChromeStore
    ? new Promise((r) => chrome.storage.local.remove(k, r))
    : Promise.resolve(localStorage.removeItem(k)),
};
const devId = (c) => `${c.host}:${c.port || 80}`;
const devName = (d) => d.name || d.device?.type || d.host;
const forgetPassword = ({ pass, ...rest }) => rest;

async function loadDevices() {
  let list = await kv.get('devices');
  if (!list) { // migrate the single saved login from older versions
    const old = await kv.get('conn');
    list = old?.host ? [{ ...old, id: devId(old), name: '' }] : [];
    await kv.set('devices', list);
    if (list.length) await kv.set('lastId', list[0].id);
    await kv.remove('conn');
  }
  return list;
}
async function saveDevice(d) {
  const list = await loadDevices();
  const i = list.findIndex((x) => x.id === d.id);
  if (i === -1) list.push(d); else list[i] = d;
  await kv.set('devices', list);
  await kv.set('lastId', d.id);
}
async function removeDevice(id) {
  const list = (await loadDevices()).filter((x) => x.id !== id);
  await kv.set('devices', list);
  if ((await kv.get('lastId')) === id) await kv.remove('lastId');
  return list;
}

// ---- host permission (requested per-device at runtime, not broad at install) --
const hasPerms = typeof chrome !== 'undefined' && chrome.permissions;
const hostOrigins = (host) => [`http://${host}/*`, `https://${host}/*`];
const hasHostPermission = (host) => hasPerms
  ? new Promise((r) => chrome.permissions.contains({ origins: hostOrigins(host) }, r))
  : Promise.resolve(true);
const requestHostPermission = (host) => hasPerms
  ? new Promise((r) => chrome.permissions.request({ origins: hostOrigins(host) }, r))
  : Promise.resolve(true);
const removeHostPermission = (host) => hasPerms
  ? new Promise((r) => chrome.permissions.remove({ origins: hostOrigins(host) }, r))
  : Promise.resolve(true);

let conn = null;
let cameras = [];

// ---- element helper ------------------------------------------------------
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
}
const $ = (id) => document.getElementById(id);

// ---- login + saved NVR list ---------------------------------------------
const loginForm = $('login');

function fillForm(d = {}) {
  loginForm.name.value = d.name || '';
  loginForm.ip.value = d.host || '';
  loginForm.port.value = d.port || 80;
  loginForm.user.value = d.user || '';
  loginForm.pass.value = d.pass || '';
  (d.host ? (d.pass ? $('submit') : loginForm.pass) : loginForm.name).focus();
}

function renderSaved(list) {
  const box = $('saved');
  box.classList.toggle('hidden', !list.length);
  $('login-title').textContent = list.length ? 'Your NVRs' : 'Dahua Camera Viewer';
  $('form-title').classList.toggle('hidden', !list.length);
  $('saved-list').replaceChildren(...list.map((d) => {
    const remove = el('button', { className: 'ghost', textContent: '✕', title: 'Forget this NVR' });
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Forget "${devName(d)}" and its saved login?`)) return;
      const rest = await removeDevice(d.id);
      // Drop the host grant too, unless another saved NVR shares the address.
      if (!rest.some((x) => x.host === d.host)) await removeHostPermission(d.host);
      renderSaved(rest);
    });
    const edit = el('button', { className: 'ghost', textContent: 'Edit', title: 'Edit name / login' });
    edit.addEventListener('click', (e) => { e.stopPropagation(); fillForm(d); });
    const item = el('li', { className: 'saved-item', title: d.pass ? 'Connect' : 'Enter the password to connect' },
      el('div', { className: 'saved-main' },
        el('strong', { textContent: devName(d) }),
        el('span', { className: 'muted', textContent: `${d.host}${+d.port !== 80 ? ':' + d.port : ''} · ${d.user}${d.pass ? '' : ' · no saved password'}` })),
      edit, remove);
    // Connecting straight from the click keeps the user gesture for the permission prompt.
    item.addEventListener('click', () => (d.pass ? connectTo(d, true) : fillForm(d)));
    return item;
  }));
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(loginForm).entries());
  const host = f.ip.trim(), port = parseInt(f.port, 10) || 80;
  connectTo({ id: devId({ host, port }), name: f.name.trim(), host, port, user: f.user, pass: f.pass }, !!f.remember);
});

async function connectTo(candidate, remember) {
  const msg = $('login-msg'); msg.textContent = ''; msg.className = 'msg';
  const btn = $('submit'); btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    // Ask for access to just this device's host (the click is the user gesture).
    if (!(await requestHostPermission(candidate.host))) throw new Error('access to this device was not granted');
    const device = await dahua.deviceInfo(candidate);
    if (!device.type && !device.serial) throw new Error('no response from device');
    const c = { ...candidate, device };
    await saveDevice(remember ? c : forgetPassword(c));
    conn = c;
    await enterApp();
  } catch (err) {
    msg.textContent = `Could not connect to ${devName(candidate)}: ${err.message}`;
    msg.classList.add('error');
    btn.disabled = false; btn.textContent = 'Connect';
  }
}

// ---- app shell -----------------------------------------------------------
async function enterApp() {
  $('login-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  const d = conn.device || {};
  $('device').textContent = [d.type, d.serial && 'SN ' + d.serial, conn.host + (+conn.port !== 80 ? ':' + conn.port : '')].filter(Boolean).join('  ·  ');
  const devices = await loadDevices();
  $('dev-switch').replaceChildren(
    ...devices.map((x) => el('option', { value: x.id, textContent: devName(x), selected: x.id === conn.id })),
    el('option', { value: '__add', textContent: '+ Add NVR…' }));
  // The Admin tab is only for admin-group accounts. The NVR refuses changes from
  // limited accounts anyway, but they'd see errors and a falsely clean Security page.
  let isAdmin;
  [cameras, isAdmin] = await Promise.all([dahua.listChannels(conn), isAdminAccount(conn).catch(() => false)]);
  document.querySelector('.seg-btn[data-view=admin]').classList.toggle('hidden', !isAdmin);
  const sel = $('rec-camera');
  sel.replaceChildren(...cameras.map((c) => el('option', { value: c.channel, textContent: `${c.name} (ch ${c.channel})` })));
  $('rec-date').value = $('ev-date').value = localDate(new Date());
  $('ev-camera').replaceChildren(el('option', { value: 'all', textContent: 'All cameras' }),
    ...cameras.map((c) => el('option', { value: c.channel, textContent: `${c.name} (ch ${c.channel})` })));
  if (isAdmin) initAdmin(conn, cameras);
  startLive();
}

$('logout').addEventListener('click', async () => {
  stopLive();
  await saveDevice(forgetPassword(conn));
  location.reload();
});

// Switching reloads the page: every view, stream and admin section starts
// clean against the other NVR (auto-reconnect picks it up via lastId).
$('dev-switch').addEventListener('change', async (e) => {
  stopLive();
  if (e.target.value === '__add') location.hash = 'add';
  else await kv.set('lastId', e.target.value);
  location.reload();
});

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const view = b.dataset.view;
  for (const v of ['live', 'recordings', 'events', 'admin']) $(`view-${v}`).classList.toggle('hidden', v !== view);
  if (view === 'live') startLive(); else stopLive();
  if (view === 'admin') showAdmin();
}));

// ---- live grid: snapshot thumbnails, stream on demand --------------------
// Thumbnails load SEQUENTIALLY (the NVR rate-limits parallel snapshots), then
// refresh on a slow cycle. Each tile streams live only when clicked.
let liveItems = [];
let thumbToken = 0;

function stopLive() {
  thumbToken++; // cancel the running loop
  liveItems.forEach((it) => it.dispose());
  liveItems = [];
  $('grid').replaceChildren();
}

function startLive() {
  stopLive();
  const grid = $('grid');
  for (const cam of cameras) grid.append(buildTile(cam));
  runThumbLoop(++thumbToken);
}

function buildTile(cam) {
  const img = el('img');
  const status = el('div', { className: 'tile-status', textContent: '…' });
  const liveBtn = el('button', { className: 'tile-btn', textContent: '▶', title: 'Start live' });
  const fsBtn = el('button', { className: 'tile-btn', textContent: '⤢', title: 'Fullscreen' });
  const videoWrap = el('div', { className: 'tile-video' }, img, status, el('div', { className: 'tile-btns' }, liveBtn, fsBtn));
  const tile = el('div', { className: 'tile' }, videoWrap,
    el('div', { className: 'tile-label' }, `${cam.name} · ch ${cam.channel}`));

  let liveAbort = null, lastUrl = null, isLive = false;
  const swap = (url) => { img.src = url; status.style.display = 'none'; if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = url; };
  function startInline() {
    if (isLive) return;
    isLive = true; liveBtn.textContent = '⏹'; liveBtn.title = 'Stop live'; status.style.display = 'none';
    liveAbort = new AbortController();
    dahua.streamMjpeg(conn, cam.channel, 1, (blob) => {
      const url = URL.createObjectURL(blob); const probe = new Image();
      probe.onload = () => swap(url); probe.onerror = () => URL.revokeObjectURL(url); probe.src = url;
    }, liveAbort.signal).catch((e) => { if (e.name !== 'AbortError' && !img.src) { status.style.display = 'grid'; status.textContent = 'No signal'; } });
  }
  function stopInline() {
    if (!isLive) return;
    isLive = false; liveBtn.textContent = '▶'; liveBtn.title = 'Start live';
    if (liveAbort) { liveAbort.abort(); liveAbort = null; }
  }
  liveBtn.addEventListener('click', (e) => { e.stopPropagation(); isLive ? stopInline() : startInline(); });
  fsBtn.addEventListener('click', (e) => { e.stopPropagation(); openFullscreen(cam); });
  videoWrap.addEventListener('click', () => (isLive ? stopInline() : startInline()));

  // Instant thumbnail: grab a single substream frame, then close. The slow,
  // sharp snapshot upgrade arrives via the sequential thumb loop.
  const ffAbort = new AbortController();
  let gotFF = false;
  dahua.streamMjpeg(conn, cam.channel, 1, (blob) => {
    if (gotFF) return; gotFF = true;
    if (!isLive) swap(URL.createObjectURL(blob));
    ffAbort.abort();
  }, ffAbort.signal).catch(() => {});

  liveItems.push({
    channel: cam.channel,
    isLive: () => isLive,
    hasImg: () => !!img.src,
    setThumb: (url) => { if (!isLive) swap(url); },
    noSignal: () => { if (!img.src) { status.style.display = 'grid'; status.textContent = 'No signal'; } },
    dispose: () => { try { ffAbort.abort(); } catch {} if (liveAbort) liveAbort.abort(); if (lastUrl) URL.revokeObjectURL(lastUrl); },
  });
  return tile;
}

async function runThumbLoop(token) {
  while (token === thumbToken) {
    for (const it of liveItems) {
      if (token !== thumbToken) return;
      if (it.isLive()) continue;
      try {
        const blob = await dahua.snapshotBlob(conn, it.channel);
        if (token !== thumbToken) return;
        it.setThumb(URL.createObjectURL(blob));
      } catch { it.noSignal(); }
      await new Promise((r) => setTimeout(r, 150)); // gap between sequential requests
    }
    await new Promise((r) => setTimeout(r, 15000)); // slow refresh cycle
  }
}

// ---- fullscreen single camera -------------------------------------------
let fsAbort = null, fsLastUrl = null;
function openFullscreen(cam) {
  closeFullscreen();
  const modal = $('modal'), img = $('modal-img'), status = $('modal-status');
  $('modal-title').textContent = `${cam.name} · ch ${cam.channel}`;
  img.removeAttribute('src'); status.style.display = 'grid'; status.textContent = 'Connecting…';
  modal.classList.remove('hidden');
  fsAbort = new AbortController();
  dahua.streamMjpeg(conn, cam.channel, 1, (blob) => {
    status.style.display = 'none';
    const url = URL.createObjectURL(blob);
    const probe = new Image();
    probe.onload = () => { img.src = url; if (fsLastUrl) URL.revokeObjectURL(fsLastUrl); fsLastUrl = url; };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  }, fsAbort.signal).catch((e) => { if (e.name !== 'AbortError') { status.style.display = 'grid'; status.textContent = 'No signal'; } });
}
function closeFullscreen() {
  if (fsAbort) { fsAbort.abort(); fsAbort = null; }
  if (fsLastUrl) { URL.revokeObjectURL(fsLastUrl); fsLastUrl = null; }
  $('modal').classList.add('hidden');
  $('modal-img').removeAttribute('src');
}
$('modal-close').addEventListener('click', closeFullscreen);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeFullscreen(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFullscreen(); });

// ---- recording playback (WebCodecs) + timeline ---------------------------
let playCtl = null, pbRec = null, pbChannel = null, pbDur = 0, pbBase = 0, pbPos = 0, pbSeeking = false;
const two = (n) => String(n).padStart(2, '0');
function fmtHMS(sec) { sec = Math.max(0, Math.floor(sec)); return `${two(sec / 3600 | 0)}:${two((sec / 60 | 0) % 60)}:${two(sec % 60)}`; }
function addSeconds(str, sec) {
  const m = str.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/);
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6] + sec);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
function setPos(pos) { pbPos = pos; if (!pbSeeking) { $('pb-seek').value = pos; $('pb-cur').textContent = fmtHMS(pos); } }

function openPlayback(rec, channel) {
  closePlayback();
  pbRec = rec; pbChannel = channel; pbDur = rec.durationSec || 0;
  $('play-title').textContent = `${timeOnly(rec.startTime)} → ${timeOnly(rec.endTime)} · ch ${channel}`;
  $('pb-seek').max = pbDur; $('pb-seek').value = 0; $('pb-dur').textContent = fmtHMS(pbDur); $('pb-cur').textContent = '00:00:00';
  $('play-modal').classList.remove('hidden');
  if (!('VideoDecoder' in window)) { const s = $('play-status'); s.style.display = 'grid'; s.textContent = 'This browser has no WebCodecs support'; return; }
  startPlaybackAt(0);
}
function startPlaybackAt(sec) {
  sec = Math.max(0, Math.min(pbDur ? pbDur - 1 : sec, sec));
  if (playCtl) playCtl.stop();
  pbBase = sec; setPos(sec);
  $('pb-toggle').textContent = '⏸';
  const status = $('play-status'); status.style.display = 'grid'; status.textContent = 'Buffering…';
  playCtl = playRecording(conn, pbChannel, addSeconds(pbRec.startTime, sec), pbRec.endTime, $('play-canvas'), {
    onStatus: (t) => { if (t) { status.style.display = 'grid'; status.textContent = t; } else status.style.display = 'none'; },
    onProgress: (p) => setPos(pbBase + p),
  });
}
function closePlayback() {
  if (playCtl) { playCtl.stop(); playCtl = null; }
  $('play-modal').classList.add('hidden');
}
$('pb-toggle').addEventListener('click', () => {
  if (!playCtl) return;
  if (playCtl.paused) { playCtl.resume(); $('pb-toggle').textContent = '⏸'; }
  else { playCtl.pause(); $('pb-toggle').textContent = '▶'; }
});
$('pb-back').addEventListener('click', () => startPlaybackAt(pbPos - 60));
$('pb-fwd').addEventListener('click', () => startPlaybackAt(pbPos + 60));
$('pb-seek').addEventListener('input', () => { pbSeeking = true; $('pb-cur').textContent = fmtHMS(+$('pb-seek').value); });
$('pb-seek').addEventListener('change', () => { const v = +$('pb-seek').value; pbSeeking = false; startPlaybackAt(v); });
$('play-close').addEventListener('click', closePlayback);
$('play-modal').addEventListener('click', (e) => { if (e.target.id === 'play-modal') closePlayback(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlayback(); });

// ---- recordings ----------------------------------------------------------
const fmtDur = (s) => s ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : '';
const fmtSize = (b) => { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; };
const timeOnly = (s) => (s || '').split(' ')[1] || s;

$('rec-search').addEventListener('click', searchRecordings);

async function searchRecordings() {
  const channel = parseInt($('rec-camera').value, 10);
  const date = $('rec-date').value;
  const status = $('rec-status'); const list = $('rec-list');
  if (!channel || !date) { status.textContent = 'Pick a camera and date'; return; }
  status.textContent = 'Searching…'; list.replaceChildren();
  const [y, m, dd] = date.split('-').map(Number);
  const start = new Date(y, m - 1, dd, 0, 0, 0), end = new Date(y, m - 1, dd, 23, 59, 59);
  try {
    const recs = await dahua.findRecordings(conn, channel, start, end);
    status.textContent = recs.length ? `${recs.length} clip(s)` : 'No recordings found';
    for (const rec of recs) {
      const prog = el('span', { className: 'dl-progress' });
      const playBtn = el('button', { textContent: 'Play' });
      const dlBtn = el('button', { textContent: 'Download' });
      const item = el('li', { className: 'rec-item' },
        el('div', { className: 'rec-main' },
          el('span', { className: 'rec-time', textContent: `${timeOnly(rec.startTime)} → ${timeOnly(rec.endTime)}` }),
          el('span', { className: 'muted', textContent: `${fmtDur(rec.durationSec)} · ${fmtSize(rec.length)}${rec.type ? ' · ' + rec.type : ''}${dahua.isMotion(rec) ? ' · motion' : ''}` })),
        el('div', { className: 'rec-actions' }, prog, playBtn, dlBtn));
      playBtn.addEventListener('click', () => openPlayback(rec, channel));
      dlBtn.addEventListener('click', () => downloadClip(rec, channel, dlBtn, prog));
      list.append(item);
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
}

// ---- motion events -------------------------------------------------------
// Motion-flagged recordings for a day: a 24h strip per camera plus a newest-first
// list. Clicking an event (strip mark or list row) opens it in the player.
let evToken = 0;
const localDate = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const secOfDay = (s) => { const m = (s || '').match(/ (\d+):(\d+):(\d+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

$('ev-search').addEventListener('click', searchEvents);

async function searchEvents() {
  const token = ++evToken;
  const pick = $('ev-camera').value, date = $('ev-date').value;
  const status = $('ev-status');
  if (!date) { status.textContent = 'Pick a date'; return; }
  const cams = pick === 'all' ? cameras : cameras.filter((c) => c.channel === +pick);
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0), end = new Date(y, m - 1, d, 23, 59, 59);
  const found = [], failed = [];
  $('ev-strips').replaceChildren(); $('ev-list').replaceChildren();
  // One camera at a time: each search holds a media-finder object on the NVR.
  for (const cam of cams) {
    status.textContent = `Searching ${cam.name}…`;
    try {
      const events = await dahua.findMotion(conn, cam.channel, start, end);
      if (token !== evToken) return;
      found.push({ cam, events });
      renderEvents(found);
    } catch (e) {
      if (token !== evToken) return;
      failed.push(`${cam.name} (${e.message})`);
    }
  }
  const total = found.reduce((n, f) => n + f.events.length, 0);
  status.textContent = (total ? `${total} motion event(s)` : 'No motion events found') + (failed.length ? ` · failed: ${failed.join(', ')}` : '');
}

function renderEvents(found) {
  const strips = found.map(({ cam, events }) => {
    const bar = el('div', { className: 'ev-bar' });
    for (const ev of events) {
      const s = secOfDay(ev.startTime);
      const e = ev.endTime.slice(0, 10) === ev.startTime.slice(0, 10) ? secOfDay(ev.endTime) : 86400;
      bar.append(el('button', {
        className: 'ev-mark', title: `${timeOnly(ev.startTime)} → ${timeOnly(ev.endTime)} · ${fmtDur(ev.durationSec)}`,
        style: `left:${s / 864}%;width:${Math.max(e - s, 0) / 864}%`,
        onclick: () => openPlayback(ev, cam.channel),
      }));
    }
    return el('div', { className: `ev-row${events.length ? '' : ' empty'}` },
      el('div', { className: 'ev-name' }, cam.name, el('span', { className: 'muted', textContent: ` ${events.length}` })), bar);
  });
  $('ev-strips').replaceChildren(
    el('div', { className: 'ev-row ev-hours' }, el('div'), el('div', { className: 'ev-bar' },
      ...[0, 3, 6, 9, 12, 15, 18, 21].map((h) => el('span', { style: `left:${h / 24 * 100}%`, textContent: `${two(h)}:00` })))),
    ...strips);

  const all = found.flatMap(({ cam, events }) => events.map((ev) => ({ cam, ev })))
    .sort((a, b) => b.ev.startTime.localeCompare(a.ev.startTime));
  $('ev-list').replaceChildren(...all.map(({ cam, ev }) => {
    const prog = el('span', { className: 'dl-progress' });
    const dlBtn = el('button', { textContent: 'Download' });
    dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadClip(ev, cam.channel, dlBtn, prog); });
    return el('li', { className: 'rec-item ev-item', onclick: () => openPlayback(ev, cam.channel) },
      el('div', { className: 'rec-main' },
        el('span', { className: 'rec-time', textContent: `${timeOnly(ev.startTime)} → ${timeOnly(ev.endTime)}` }),
        el('span', { className: 'muted', textContent: `${cam.name} · ${fmtDur(ev.durationSec)}${ev.length ? ' · ' + fmtSize(ev.length) : ''}` })),
      el('div', { className: 'rec-actions' }, prog, el('button', { textContent: 'Play' }), dlBtn));
  }));
}

async function downloadClip(rec, channel, btn, prog) {
  const name = `ch${channel}_${rec.startTime.replace(/[-: ]/g, '')}.dav`;
  const ctrl = new AbortController();
  btn.disabled = true; btn.textContent = 'Downloading…'; prog.textContent = '0%';
  try {
    const res = await dahua.downloadClip(conn, channel, rec.startTime, rec.endTime, 0, ctrl.signal);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || rec.length || 0;
    const reader = res.body.getReader();

    // Prefer streaming straight to disk (no memory blow-up on hour-long clips).
    if (window.showSaveFilePicker) {
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: name }); }
      catch (e) { if (e.name === 'AbortError') { ctrl.abort(); reset(); return; } throw e; }
      const w = await handle.createWritable();
      let done = 0;
      for (;;) { const { value, done: d } = await reader.read(); if (d) break; await w.write(value); done += value.length; prog.textContent = pct(done, total); }
      await w.close();
    } else {
      // Fallback: buffer then anchor-download.
      const chunks = []; let done = 0;
      for (;;) { const { value, done: d } = await reader.read(); if (d) break; chunks.push(value); done += value.length; prog.textContent = pct(done, total); }
      const url = URL.createObjectURL(new Blob(chunks));
      el('a', { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    prog.textContent = 'saved'; btn.textContent = 'Download'; btn.disabled = false;
  } catch (e) {
    prog.textContent = 'failed'; btn.textContent = 'Download'; btn.disabled = false;
    console.error(e);
  }
  function reset() { btn.disabled = false; btn.textContent = 'Download'; prog.textContent = ''; }
}
const pct = (done, total) => total ? Math.min(100, Math.round(done / total * 100)) + '%' : (done / 1e6).toFixed(0) + 'MB';

// ---- boot ----------------------------------------------------------------
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

(async function init() {
  const devices = await loadDevices();
  const lastId = await kv.get('lastId');
  const last = devices.find((d) => d.id === lastId);
  const adding = location.hash === '#add';
  if (adding) history.replaceState(null, '', location.pathname);
  renderSaved(devices);
  if (adding || !last) return fillForm();
  // Prefill the last NVR, so a failed auto-connect is one click away.
  fillForm(last);
  if (!last.pass) return; // signed out: keep the NVR + user, not the password
  const msg = $('login-msg'), btn = $('submit');
  // Can't prompt for permission without a user gesture — Connect re-grants it.
  if (!(await hasHostPermission(last.host))) { msg.textContent = `Click Connect to allow access to ${last.host} again.`; return; }
  msg.textContent = `Reconnecting to ${devName(last)}…`; btn.disabled = true; btn.textContent = 'Reconnecting…';
  try {
    const device = await withTimeout(dahua.deviceInfo(last), 10000, 'the device did not answer');
    if (!device.type && !device.serial) throw new Error('no response from device');
    conn = { ...last, device };
    await saveDevice(conn); // refresh the stored model/serial
    await enterApp();
  } catch (e) {
    msg.textContent = `Couldn't reconnect to ${devName(last)} automatically: ${e.message}. Check it's reachable, then click Connect.`;
    msg.classList.add('error');
    btn.disabled = false; btn.textContent = 'Connect';
  }
})();
