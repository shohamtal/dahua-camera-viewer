import * as dahua from './lib/dahua.js';
import { playRecording } from './lib/h264play.js';

// ---- persistent creds (extension storage, localStorage fallback) ---------
const hasChromeStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const store = {
  get: () => hasChromeStore
    ? new Promise((r) => chrome.storage.local.get('conn', (d) => r(d.conn || null)))
    : Promise.resolve(JSON.parse(localStorage.getItem('conn') || 'null')),
  set: (c) => hasChromeStore
    ? new Promise((r) => chrome.storage.local.set({ conn: c }, r))
    : Promise.resolve(localStorage.setItem('conn', JSON.stringify(c))),
  clear: () => hasChromeStore
    ? new Promise((r) => chrome.storage.local.remove('conn', r))
    : Promise.resolve(localStorage.removeItem('conn')),
};

// ---- host permission (requested per-device at runtime, not broad at install) --
const hasPerms = typeof chrome !== 'undefined' && chrome.permissions;
const hostOrigins = (host) => [`http://${host}/*`, `https://${host}/*`];
const hasHostPermission = (host) => hasPerms
  ? new Promise((r) => chrome.permissions.contains({ origins: hostOrigins(host) }, r))
  : Promise.resolve(true);
const requestHostPermission = (host) => hasPerms
  ? new Promise((r) => chrome.permissions.request({ origins: hostOrigins(host) }, r))
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

// ---- login ---------------------------------------------------------------
const loginForm = $('login');
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('login-msg'); msg.textContent = ''; msg.className = 'msg';
  const btn = $('submit'); btn.disabled = true; btn.textContent = 'Connecting…';
  const f = Object.fromEntries(new FormData(loginForm).entries());
  const candidate = { host: f.ip.trim(), port: parseInt(f.port, 10) || 80, user: f.user, pass: f.pass };
  try {
    // Ask for access to just this device's host (this click is the user gesture).
    if (!(await requestHostPermission(candidate.host))) throw new Error('access to this device was not granted');
    const device = await dahua.deviceInfo(candidate);
    if (!device.type && !device.serial) throw new Error('no response from device');
    candidate.device = device;
    conn = candidate;
    if (f.remember) await store.set(candidate); else await store.clear();
    await enterApp();
  } catch (err) {
    msg.textContent = 'Could not connect: ' + err.message;
    msg.classList.add('error');
    btn.disabled = false; btn.textContent = 'Connect';
  }
});

// ---- app shell -----------------------------------------------------------
async function enterApp() {
  $('login-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  const d = conn.device || {};
  $('device').textContent = [d.type, d.serial && 'SN ' + d.serial, conn.host].filter(Boolean).join('  ·  ');
  cameras = await dahua.listChannels(conn);
  const sel = $('rec-camera');
  sel.replaceChildren(...cameras.map((c) => el('option', { value: c.channel, textContent: `${c.name} (ch ${c.channel})` })));
  $('rec-date').value = new Date().toISOString().slice(0, 10);
  startLive();
}

$('logout').addEventListener('click', async () => {
  stopLive();
  await store.clear();
  location.reload();
});

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const live = b.dataset.view === 'live';
  $('view-live').classList.toggle('hidden', !live);
  $('view-recordings').classList.toggle('hidden', live);
  if (live) startLive(); else stopLive();
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
          el('span', { className: 'muted', textContent: `${fmtDur(rec.durationSec)} · ${fmtSize(rec.length)}${rec.type ? ' · ' + rec.type : ''}` })),
        el('div', { className: 'rec-actions' }, prog, playBtn, dlBtn));
      playBtn.addEventListener('click', () => openPlayback(rec, channel));
      dlBtn.addEventListener('click', () => downloadClip(rec, channel, dlBtn, prog));
      list.append(item);
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
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
(async function init() {
  const saved = await store.get();
  // Auto-connect only if we already hold permission for this host (can't prompt
  // without a user gesture at boot — the user re-grants by clicking Connect).
  if (saved && saved.host && await hasHostPermission(saved.host)) {
    try { saved.device = await dahua.deviceInfo(saved); conn = saved; await enterApp(); return; }
    catch { /* fall through to login */ }
  }
  // Prefill IP if we had one.
  if (saved && saved.host) loginForm.ip.value = saved.host;
})();
