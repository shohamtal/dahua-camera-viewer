// First: starts capturing errors before anything else runs.
import { initFeedback, setFeedbackContext, noteSuccessfulUse } from './feedback.js';
import * as dahua from './lib/dahua.js';
import { initAdmin, showAdmin } from './admin-ui.js';
import { initRecordings, showRecordings, hideRecordings, goToRecording, downloadClip } from './recordings-ui.js';
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
    console.warn('connect failed:', err.message);
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
  setFeedbackContext({ conn, devices });
  $('dev-switch').replaceChildren(
    ...devices.map((x) => el('option', { value: x.id, textContent: devName(x), selected: x.id === conn.id })),
    el('option', { value: '__add', textContent: '+ Add NVR…' }));
  // The Admin tab is only for admin-group accounts. The NVR refuses changes from
  // limited accounts anyway, but they'd see errors and a falsely clean Security page.
  let isAdmin;
  [cameras, isAdmin] = await Promise.all([dahua.listChannels(conn), isAdminAccount(conn).catch(() => false)]);
  document.querySelector('.seg-btn[data-view=admin]').classList.toggle('hidden', !isAdmin);
  $('ev-date').value = localDate(new Date());
  initRecordings(conn, cameras, { showView });
  setFeedbackContext({ cameras });
  noteSuccessfulUse();
  $('ev-camera').replaceChildren(el('option', { value: 'all', textContent: 'All cameras' }),
    ...cameras.map((c) => el('option', { value: c.channel, textContent: `${c.name} (ch ${c.channel})` })));
  if (isAdmin) initAdmin(conn, cameras);
  // A tab may have been clicked while cameras were loading: open whichever is active now.
  const active = document.querySelector('.seg-btn.active:not(.hidden)')?.dataset.view || 'live';
  showView(active);
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

function showView(view) {
  document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  for (const v of ['live', 'recordings', 'events', 'admin']) $(`view-${v}`).classList.toggle('hidden', v !== view);
  if (view === 'live') startLive(); else stopLive();
  if (view === 'recordings') showRecordings(); else hideRecordings();
  if (view === 'admin') showAdmin();
}
document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

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

// ---- formatting helpers --------------------------------------------------
const two = (n) => String(n).padStart(2, '0');
const fmtDur = (s) => s ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : '';
const fmtSize = (b) => { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; };
const timeOnly = (s) => (s || '').split(' ')[1] || s;

// ---- motion events -------------------------------------------------------
// Motion-flagged recordings for a day: a 24h strip per camera plus a newest-first
// list. Clicking an event (strip mark or list row) opens it on the Recordings timeline.
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
        onclick: () => goToRecording(cam.channel, ev.startTime),
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
    return el('li', { className: 'rec-item ev-item', onclick: () => goToRecording(cam.channel, ev.startTime) },
      el('div', { className: 'rec-main' },
        el('span', { className: 'rec-time', textContent: `${timeOnly(ev.startTime)} → ${timeOnly(ev.endTime)}` }),
        el('span', { className: 'muted', textContent: `${cam.name} · ${fmtDur(ev.durationSec)}${ev.length ? ' · ' + fmtSize(ev.length) : ''}` })),
      el('div', { className: 'rec-actions' }, prog, el('button', { textContent: 'Play' }), dlBtn));
  }));
}

// ---- boot ----------------------------------------------------------------
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

initFeedback();

(async function init() {
  const devices = await loadDevices();
  setFeedbackContext({ devices });
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
    console.warn('auto-reconnect failed:', e.message);
    msg.textContent = `Couldn't reconnect to ${devName(last)} automatically: ${e.message}. Check it's reachable, then click Connect.`;
    msg.classList.add('error');
    btn.disabled = false; btn.textContent = 'Connect';
  }
})();
