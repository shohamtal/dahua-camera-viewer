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

let conn = null;
let cameras = [];
let liveAborts = [];

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

// ---- live grid (MJPEG) ---------------------------------------------------
function stopLive() {
  liveAborts.forEach((a) => a.abort());
  liveAborts = [];
  $('grid').replaceChildren();
}

function startLive() {
  stopLive();
  const grid = $('grid');
  for (const cam of cameras) {
    const img = el('img');
    const status = el('div', { className: 'tile-status', textContent: 'Connecting…' });
    const videoWrap = el('div', { className: 'tile-video' }, img, status);
    videoWrap.title = 'Click for fullscreen';
    videoWrap.addEventListener('click', () => openFullscreen(cam));
    const tile = el('div', { className: 'tile' }, videoWrap,
      el('div', { className: 'tile-label' }, `${cam.name} · ch ${cam.channel}`));
    grid.append(tile);

    const ctrl = new AbortController();
    liveAborts.push(ctrl);
    let got = false, lastUrl = null;
    const timer = setTimeout(() => { if (!got) status.textContent = 'No signal'; }, 12000);
    dahua.streamMjpeg(conn, cam.channel, 1, (blob) => {
      got = true; clearTimeout(timer); status.style.display = 'none';
      // Decode off-screen first so a partial/corrupt frame never flashes on-screen.
      const url = URL.createObjectURL(blob);
      const probe = new Image();
      probe.onload = () => { img.src = url; if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = url; };
      probe.onerror = () => URL.revokeObjectURL(url);
      probe.src = url;
    }, ctrl.signal).catch((err) => {
      if (err.name === 'AbortError') return;
      clearTimeout(timer); status.style.display = 'grid'; status.textContent = 'No signal';
    });
  }
}

// ---- fullscreen single camera -------------------------------------------
let fsAbort = null, fsLastUrl = null;
function openFullscreen(cam) {
  closeFullscreen();
  stopLive(); // free the grid's connections so the single view is smooth
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
  const wasOpen = !$('modal').classList.contains('hidden');
  if (fsAbort) { fsAbort.abort(); fsAbort = null; }
  if (fsLastUrl) { URL.revokeObjectURL(fsLastUrl); fsLastUrl = null; }
  $('modal').classList.add('hidden');
  $('modal-img').removeAttribute('src');
  // Resume the grid if we're still on the Live tab.
  if (wasOpen && !$('view-live').classList.contains('hidden')) startLive();
}
$('modal-close').addEventListener('click', closeFullscreen);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeFullscreen(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFullscreen(); });

// ---- recording playback (WebCodecs) -------------------------------------
let playCtl = null;
function openPlayback(rec, channel) {
  closePlayback();
  $('play-title').textContent = `${timeOnly(rec.startTime)} → ${timeOnly(rec.endTime)} · ch ${channel}`;
  const status = $('play-status');
  status.style.display = 'grid'; status.textContent = 'Buffering…';
  $('play-modal').classList.remove('hidden');
  if (!('VideoDecoder' in window)) { status.textContent = 'This browser has no WebCodecs support'; return; }
  playCtl = playRecording(conn, channel, rec.startTime, rec.endTime, $('play-canvas'), {
    onStatus: (t) => { if (t) { status.style.display = 'grid'; status.textContent = t; } else status.style.display = 'none'; },
  });
}
function closePlayback() {
  if (playCtl) { playCtl.stop(); playCtl = null; }
  $('play-modal').classList.add('hidden');
}
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
  if (saved && saved.host) {
    try { saved.device = await dahua.deviceInfo(saved); conn = saved; await enterApp(); return; }
    catch { /* fall through to login */ }
  }
  // Prefill IP if we had one.
  if (saved && saved.host) loginForm.ip.value = saved.host;
})();
