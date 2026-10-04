// Recordings tab: pick a camera and a day (the calendar marks days that have
// video), then scrub one 24-hour timeline. Coverage and the NVR's motion marks
// are drawn on it; clicking anywhere plays from that moment, at 1×–8× or Max
// (as fast as the NVR streams — ~9× measured on an NVR4108 over LAN).
import * as dahua from './lib/dahua.js';
import { playRecording } from './lib/h264play.js';
import { exportMp4, MAX_EXPORT_MS } from './lib/mp4.js';

let conn = null;
let cameras = [];
let showView = () => {};

const DAY = 86400e3;
const AVAILABILITY_DAYS = 35;     // how far back the calendar looks for video
const SD_FROM_SPEED = 4;          // switch to the sub stream at this speed
const S = {
  channel: null, day: null,       // day: "YYYY-MM-DD"
  days: new Set(), daysByChannel: new Map(),
  files: [], spans: [], segs: [], motion: [], // spans (per file) / segs (merged) / motion: {start, end} epoch ms
  ctl: null, seg: null, pos: null, playing: false, emptyRuns: 0,
  speed: 1, sdBroken: false,
  zoom: 86400, winStart: 0,
  pendingSeek: null, token: 0, calMonth: null,
  ex: { open: false, start: null, end: null, ctrl: null }, // MP4 export panel
};

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) n.append(k);
  return n;
}
const $ = (id) => document.getElementById(id);
const two = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const dayStart = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const fmt = (ms) => { const d = new Date(ms); return `${localDate(d)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const hms = (ms) => fmt(ms).slice(11);
const toMs = (s) => { const m = (s || '').match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
const fmtDur = (s) => s ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : '';
const fmtSize = (b) => { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; };

export function initRecordings(c, cams, opts = {}) {
  conn = c; cameras = cams; showView = opts.showView || showView;
  $('rec-camera').replaceChildren(...cameras.map((cam) => el('option', { value: cam.channel, textContent: `${cam.name} (ch ${cam.channel})` })));
  $('rec-camera').addEventListener('change', (e) => selectCamera(+e.target.value));
  $('rec-day-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleCalendar(); });
  $('rec-prev-day').addEventListener('click', () => stepDay(-1));
  $('rec-next-day').addEventListener('click', () => stepDay(1));
  document.addEventListener('click', (e) => { if (!$('rec-cal').contains(e.target)) $('rec-cal').classList.add('hidden'); });
  $('pb-toggle').addEventListener('click', togglePlay);
  $('pb-back').addEventListener('click', () => S.pos != null && seek(S.pos - 10e3));
  $('pb-fwd').addEventListener('click', () => S.pos != null && seek(S.pos + 10e3));
  $('pb-prev-motion').addEventListener('click', () => jumpMotion(-1));
  $('pb-next-motion').addEventListener('click', () => jumpMotion(1));
  $('pb-speed').addEventListener('change', (e) => setSpeed(+e.target.value));
  document.querySelectorAll('#tl-zoom button').forEach((b) => b.addEventListener('click', () => setZoom(+b.dataset.zoom)));
  wireExport();
  wireTimeline();
  document.addEventListener('keydown', onKey);
}

/** Recordings tab became visible. */
export function showRecordings() {
  if (S.channel == null && S.pendingSeek == null && cameras.length) selectCamera(cameras[0].channel);
}

/** Leaving the tab: stop streaming. */
export function hideRecordings() {
  stopPlayer();
  setPlaying(false);
}

/** Open the Recordings tab at a moment (used by the Events tab). */
export function goToRecording(channel, startTime) {
  const ms = toMs(startTime);
  const day = localDate(new Date(ms));
  S.pendingSeek = ms; // set before showView, so the tab doesn't auto-load camera 1
  showView('recordings');
  if (channel !== S.channel || !S.days.has(day)) { $('rec-camera').value = channel; selectCamera(channel, day); }
  else if (day !== S.day) loadDay(day);
  else { S.pendingSeek = null; seek(ms); }
}

// ---------- camera / day ----------

async function selectCamera(channel, preferDay) {
  stopPlayer(); setPlaying(false);
  S.channel = channel; // sdBroken stays: whether the sub stream is stored is per NVR
  const token = ++S.token;
  status('Checking which days have video…');
  let days = S.daysByChannel.get(channel);
  if (!days || (preferDay && !days.has(preferDay))) { // cached list may predate that day
    try { days = await availableDays(channel); }
    catch (e) { console.warn('list recordings failed:', e.message); if (token === S.token) status('Could not list recordings: ' + e.message); return; }
    S.daysByChannel.set(channel, days);
  }
  if (token !== S.token) return;
  S.days = days;
  const sorted = [...days].sort();
  const day = preferDay && days.has(preferDay) ? preferDay
    : S.day && days.has(S.day) ? S.day : sorted[sorted.length - 1];
  if (!day) { status(`No recordings in the last ${AVAILABILITY_DAYS} days`); clearDay(); return; }
  loadDay(day);
}

/** Days (YYYY-MM-DD) with at least one recording, over the last AVAILABILITY_DAYS. */
async function availableDays(channel) {
  const now = new Date();
  // 7-day searches rather than one 35-day one: some firmware refuses long ranges.
  const files = [];
  for (let back = 0; back < AVAILABILITY_DAYS; back += 7) {
    const to = back ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - back + 1, 0, 0, -1) : now;
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.min(back + 6, AVAILABILITY_DAYS - 1));
    files.push(...await dahua.findRecordings(conn, channel, from, to));
  }
  const days = new Set();
  for (const f of files) {
    const s = toMs(f.startTime), e = toMs(f.endTime) ?? s;
    if (s == null) continue;
    for (let d = dayStart(localDate(new Date(s))); d <= e; d += DAY) days.add(localDate(new Date(d + 3600e3))); // +1h: DST-safe
  }
  return days;
}

async function loadDay(day) {
  stopPlayer(); setPlaying(false); clearPicture();
  S.day = day; S.pos = null; S.seg = null;
  const token = ++S.token;
  $('rec-day-label').textContent = new Date(dayStart(day)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  updateDayButtons();
  status('Loading the day…');
  const from = new Date(dayStart(day)), to = new Date(dayStart(day) + DAY - 1000);
  let files, motion;
  try {
    [files, motion] = await Promise.all([
      dahua.findRecordings(conn, S.channel, from, to),
      dahua.findMotion(conn, S.channel, from, to).catch(() => []),
    ]);
  } catch (e) { console.warn('load day failed:', e.message); if (token === S.token) status('Could not load recordings: ' + e.message); return; }
  if (token !== S.token) return;
  S.files = files.sort((a, b) => a.startTime.localeCompare(b.startTime));
  S.spans = files.map((f) => ({ start: Math.max(from.getTime(), toMs(f.startTime)), end: Math.min(to.getTime() + 1000, toMs(f.endTime)) })).filter((x) => x.end > x.start);
  S.segs = mergeSegments(files, from.getTime(), to.getTime() + 1000);
  S.motion = motion.map((m) => ({ start: toMs(m.startTime), end: toMs(m.endTime) })).filter((m) => m.start != null);
  const covered = S.segs.reduce((n, s) => n + s.end - s.start, 0);
  status(S.segs.length
    ? `${Math.round(covered / 36e5 * 10) / 10} h recorded · ${S.motion.length} motion event(s)` + (S.motion.length ? '' : ' (is motion detection on?)')
    : 'No recordings on this day');
  overlay(S.segs.length ? 'Click the timeline to play' : 'No recordings on this day');
  renderFiles();
  S.winStart = dayStart(day);
  renderTimeline();
  if (S.pendingSeek != null) { const t = S.pendingSeek; S.pendingSeek = null; seek(t); }
}

function clearDay() {
  S.files = []; S.spans = []; S.segs = []; S.motion = []; S.day = null;
  renderTimeline(); renderFiles();
}

/** Merge back-to-back files (gap <= 2 s) into continuous covered spans, clipped to the day. */
function mergeSegments(files, from, to) {
  const out = [];
  for (const f of files) {
    const s = Math.max(from, toMs(f.startTime)), e = Math.min(to, toMs(f.endTime));
    if (!(e > s)) continue;
    const last = out[out.length - 1];
    if (last && s - last.end <= 2000) last.end = Math.max(last.end, e);
    else out.push({ start: s, end: e });
  }
  return out.sort((a, b) => a.start - b.start);
}

function stepDay(dir) {
  const sorted = [...S.days].sort();
  const i = sorted.indexOf(S.day);
  const next = sorted[i + dir];
  if (next) loadDay(next);
}

function updateDayButtons() {
  const sorted = [...S.days].sort();
  const i = sorted.indexOf(S.day);
  $('rec-prev-day').disabled = i <= 0;
  $('rec-next-day').disabled = i === -1 || i >= sorted.length - 1;
}

// ---------- calendar ----------

function toggleCalendar() {
  const cal = $('rec-cal');
  if (!cal.classList.contains('hidden')) { cal.classList.add('hidden'); return; }
  const ref = new Date(dayStart(S.day || localDate(new Date())));
  S.calMonth = new Date(ref.getFullYear(), ref.getMonth(), 1);
  renderCalendar();
  cal.classList.remove('hidden');
}

function renderCalendar() {
  const m = S.calMonth, today = localDate(new Date());
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const nDays = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(el('span'));
  for (let d = 1; d <= nDays; d++) {
    const key = localDate(new Date(m.getFullYear(), m.getMonth(), d));
    const has = S.days.has(key);
    const b = el('button', {
      type: 'button', textContent: d, disabled: !has,
      className: ['cal-day', has && 'has', key === S.day && 'sel', key === today && 'today'].filter(Boolean).join(' '),
      title: has ? 'Has recordings' : 'No recordings',
    });
    b.addEventListener('click', (e) => { e.stopPropagation(); $('rec-cal').classList.add('hidden'); loadDay(key); });
    cells.push(b);
  }
  const nav = (dir) => (e) => { e.stopPropagation(); S.calMonth = new Date(m.getFullYear(), m.getMonth() + dir, 1); renderCalendar(); };
  const weekdays = [...Array(7)].map((_, i) => el('span', { className: 'cal-wd', textContent: new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'narrow' }) }));
  $('rec-cal').replaceChildren(
    el('div', { className: 'cal-head' },
      el('button', { type: 'button', className: 'ghost', textContent: '‹', onclick: nav(-1) }),
      el('strong', { textContent: m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
      el('button', { type: 'button', className: 'ghost', textContent: '›', onclick: nav(1) })),
    el('div', { className: 'cal-grid' }, ...weekdays, ...cells),
    el('p', { className: 'cal-note muted', textContent: `Highlighted days have video (last ${AVAILABILITY_DAYS} days checked).` }));
}

// ---------- playback ----------

function stopPlayer() { if (S.ctl) { S.ctl.stop(); S.ctl = null; } }

function setPlaying(on) {
  S.playing = on;
  $('pb-toggle').textContent = on ? '⏸' : '▶';
  $('pb-toggle').title = on ? 'Pause (space)' : 'Play (space)';
}

/** The recording file covering ms — the longest-running one when files overlap. */
function fileAt(ms) {
  let best = null;
  for (const f of S.spans) if (ms >= f.start && ms < f.end && (!best || f.end > best.end)) best = f;
  return best;
}

/**
 * Play from ms. Inside a gap → jump to the next recording. Each request covers
 * one recording file (the NVR stops at the end of the file a request started
 * in); when it ends, playback continues in the next file.
 */
function seek(ms, { auto = false } = {}) {
  if (!S.segs.length) return;
  if (!auto) S.emptyRuns = 0;
  const d0 = dayStart(S.day);
  ms = Math.max(d0, Math.min(ms, d0 + DAY - 1000));
  const seg = S.segs.find((s) => ms < s.end);
  if (!seg) { stopPlayer(); setPlaying(false); S.pos = S.segs[S.segs.length - 1].end; updatePlayhead(); overlay('No recordings after this time'); return; }
  let note = '';
  if (ms < seg.start) { note = `No video at ${hms(ms)} — jumped to ${hms(seg.start)}`; ms = seg.start; }
  const end = Math.min(fileAt(ms)?.end ?? seg.end, seg.end);
  stopPlayer();
  S.seg = seg; S.pos = ms;
  updatePlayhead();
  setPlaying(true);
  const subtype = S.speed >= SD_FROM_SPEED && !S.sdBroken ? 1 : 0;
  $('pb-quality').textContent = subtype ? 'SD' : 'HD';
  $('pb-quality').title = subtype ? 'Low-quality stream while playing fast' : 'Full-quality stream';
  if (!auto) { overlay(''); spinner(true); }
  if (note) status(note);
  const ctl = playRecording(conn, S.channel, fmt(ms), fmt(end), $('rec-canvas'), {
    speed: S.speed, subtype,
    onStatus: (t) => { if (S.ctl === ctl && !/^No recording data/.test(t)) overlay(t); }, // '' = first frame drawn
    onTime: (t) => { if (S.ctl === ctl) { S.pos = t; updatePlayhead(); } },
    onEnded: ({ frames }) => {
      if (S.ctl !== ctl) return;
      // The sub stream isn't stored on every NVR: fall back to the main stream.
      if (subtype === 1 && !frames) { S.sdBroken = true; seek(S.pos, { auto: true }); return; }
      S.emptyRuns = frames ? 0 : S.emptyRuns + 1;
      if (S.emptyRuns >= 3) { console.warn(`no video from the NVR around ${fmt(ms)}`); stopPlayer(); setPlaying(false); overlay(`The NVR sent no video around ${hms(ms)}`); return; }
      // Stream stopped early inside the file → pick up where it stopped; else the next file.
      const next = frames && S.pos < end - 5000 ? S.pos + 1000 : end;
      if (next < seg.end - 500) { seek(next, { auto: true }); return; }
      const after = S.segs[S.segs.indexOf(seg) + 1];
      if (after) seek(after.start, { auto: true });
      else { stopPlayer(); setPlaying(false); overlay('End of recordings for this day'); }
    },
  });
  S.ctl = ctl;
}

function togglePlay() {
  if (!S.segs.length) return;
  if (!S.ctl) { seek(S.pos ?? S.segs[0].start); return; }
  if (S.ctl.paused) { S.ctl.resume(); setPlaying(true); } else { S.ctl.pause(); setPlaying(false); }
}

function setSpeed(v) {
  const crossed = (S.speed >= SD_FROM_SPEED) !== (v >= SD_FROM_SPEED);
  S.speed = v;
  if (!S.ctl) return;
  if (crossed && !S.sdBroken) seek(S.pos); // switch HD <-> SD at the current moment
  else S.ctl.setSpeed(v);
}

/** Jump to the next (dir=1) or previous (dir=-1) motion event. */
function jumpMotion(dir) {
  if (!S.motion.length) { status('No motion events on this day'); return; }
  const pos = S.pos ?? (dir > 0 ? dayStart(S.day) - 1 : dayStart(S.day) + DAY);
  const target = dir > 0
    ? S.motion.find((m) => m.start > pos + 1000)
    : [...S.motion].reverse().find((m) => m.start < pos - 3000); // -3 s: pressing again keeps going back
  if (!target) { status(dir > 0 ? 'No more motion after this' : 'No motion before this'); return; }
  seek(target.start);
}

function onKey(e) {
  if ($('view-recordings').classList.contains('hidden') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? jumpMotion(-1) : S.pos != null && seek(S.pos - 10e3); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? jumpMotion(1) : S.pos != null && seek(S.pos + 10e3); }
}

function status(t) { $('rec-status').textContent = t || ''; }
/** Message over the video (dims the last frame); also ends any spinner. */
function overlay(t) { const o = $('rec-overlay'); o.textContent = t || ''; o.style.display = t ? 'grid' : 'none'; spinner(false); }
/** Spinner over the last frame while a seek loads — the picture stays put. */
function spinner(on) { $('rec-spinner').classList.toggle('hidden', !on); }
function clearPicture() { const c = $('rec-canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height); }

// ---------- timeline ----------

function windowRange() {
  const d0 = dayStart(S.day || localDate(new Date())), span = S.zoom * 1000;
  if (span >= DAY) return [d0, d0 + DAY];
  S.winStart = Math.max(d0, Math.min(S.winStart, d0 + DAY - span));
  return [S.winStart, S.winStart + span];
}

function setZoom(z) {
  S.zoom = z;
  const span = z * 1000;
  const center = S.pos ?? (S.segs.length ? S.segs[S.segs.length - 1].end : dayStart(S.day) + DAY / 2);
  S.winStart = center - span / 2;
  document.querySelectorAll('#tl-zoom button').forEach((b) => b.classList.toggle('active', +b.dataset.zoom === z));
  renderTimeline();
}

function renderTimeline() {
  const bar = $('tl-bar');
  if (!S.day) { bar.replaceChildren(); return; }
  const [ws, we] = windowRange(), span = we - ws;
  const x = (t) => `${((t - ws) / span) * 100}%`;
  const w = (a, b) => `${Math.max(((Math.min(b, we) - Math.max(a, ws)) / span) * 100, 0.15)}%`;
  const kids = [];
  for (const s of S.segs) if (s.end > ws && s.start < we) kids.push(el('div', { className: 'tl-seg', style: `left:${x(Math.max(s.start, ws))};width:${w(s.start, s.end)}` }));
  for (const m of S.motion) if (m.end > ws && m.start < we) kids.push(el('div', { className: 'tl-mot', style: `left:${x(Math.max(m.start, ws))};width:${w(m.start, m.end)}`, title: `Motion ${hms(m.start)}` }));
  const step = span >= DAY ? 3 * 3600e3 : span >= 3600e3 ? 600e3 : 60e3;
  for (let t = Math.ceil(ws / step) * step; t <= we; t += step) {
    const d = new Date(t);
    const label = `${two(d.getHours())}:${two(d.getMinutes())}`;
    kids.push(el('div', { className: 'tl-tick', style: `left:${x(t)}` }, el('span', { textContent: label })));
  }
  if (S.ex.open && S.ex.end > S.ex.start && S.ex.end > ws && S.ex.start < we) kids.push(el('div', { className: 'tl-sel', style: `left:${x(Math.max(S.ex.start, ws))};width:${w(S.ex.start, S.ex.end)}`, title: 'Export range' }));
  kids.push(el('div', { id: 'tl-head', className: 'tl-head' }), el('div', { id: 'tl-hover', className: 'tl-hover' }));
  bar.replaceChildren(...kids);
  $('tl-range').textContent = span >= DAY ? '' : `${hms(ws).slice(0, 5)} – ${hms(we).slice(0, 5)}`;
  updatePlayhead(true);
}

function updatePlayhead(fromRender) {
  $('pb-time').textContent = S.pos != null ? hms(S.pos) : '--:--:--';
  const head = $('tl-head');
  if (!head) return;
  if (S.pos == null) { head.style.display = 'none'; return; }
  const [ws, we] = windowRange();
  // Zoomed in and the playhead left the window: follow it.
  if (!fromRender && (S.pos < ws || S.pos > we) && we - ws < DAY) { S.winStart = S.pos - (we - ws) * 0.1; renderTimeline(); return; }
  head.style.display = S.pos >= ws && S.pos <= we ? 'block' : 'none';
  head.style.left = `${((S.pos - ws) / (we - ws)) * 100}%`;
}

function wireTimeline() {
  const bar = $('tl-bar');
  const timeAt = (clientX) => {
    const r = bar.getBoundingClientRect(), [ws, we] = windowRange();
    return ws + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (we - ws);
  };
  const hover = (clientX) => {
    const h = $('tl-hover'); if (!h || !S.day) return;
    const t = timeAt(clientX), r = bar.getBoundingClientRect();
    const inMotion = S.motion.some((m) => t >= m.start - 5000 && t <= m.end + 5000);
    const covered = S.segs.some((s) => t >= s.start && t < s.end);
    h.textContent = hms(t) + (inMotion ? ' · motion' : covered ? '' : ' · no video');
    h.style.left = `${clientX - r.left}px`; h.style.display = 'block';
  };
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => { if (!S.segs.length) return; dragging = true; bar.setPointerCapture(e.pointerId); hover(e.clientX); });
  bar.addEventListener('pointermove', (e) => hover(e.clientX));
  bar.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; seek(timeAt(e.clientX)); });
  bar.addEventListener('pointerleave', () => { if (!dragging && $('tl-hover')) $('tl-hover').style.display = 'none'; });
  // Zoomed in: the mouse wheel pans the window.
  bar.addEventListener('wheel', (e) => {
    if (S.zoom >= 86400 || !S.day) return;
    e.preventDefault();
    S.winStart += (e.deltaY || e.deltaX) / 600 * S.zoom * 1000 * 0.25;
    renderTimeline();
  }, { passive: false });
}

// ---------- MP4 export ----------

const toInput = (ms) => fmt(ms).replace(' ', 'T');
const fromInput = (v) => { const m = (v || '').match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)(?::(\d+))?/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null; };
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${two(s % 60)}`; };

function wireExport() {
  $('pb-export').addEventListener('click', () => (S.ex.open ? closeExport() : openExport()));
  $('ex-close').addEventListener('click', closeExport);
  $('ex-start').addEventListener('input', readExportInputs);
  $('ex-end').addEventListener('input', readExportInputs);
  $('ex-start-here').addEventListener('click', () => {
    if (S.pos == null) return;
    const len = S.ex.end - S.ex.start;
    S.ex.start = S.pos;
    if (!(len > 0 && len <= MAX_EXPORT_MS)) S.ex.end = S.pos + 5 * 60e3;
    else S.ex.end = S.pos + len; // keep the chosen length
    syncExportInputs();
  });
  $('ex-end-here').addEventListener('click', () => { if (S.pos != null) { S.ex.end = S.pos; syncExportInputs(); } });
  $('ex-go').addEventListener('click', runExport);
  $('ex-cancel').addEventListener('click', () => S.ex.ctrl?.abort());
}

function openExport() {
  if (!S.segs.length) { status('No recordings on this day to export'); return; }
  const lastEnd = S.segs[S.segs.length - 1].end;
  const start = S.pos ?? Math.max(S.segs[0].start, lastEnd - 5 * 60e3);
  S.ex.start = start; S.ex.end = Math.min(start + 5 * 60e3, lastEnd > start ? lastEnd : start + 5 * 60e3);
  S.ex.open = true;
  $('rec-export').classList.remove('hidden');
  $('pb-export').classList.add('active');
  $('ex-msg').textContent = '';
  syncExportInputs();
}

function closeExport() {
  if (S.ex.ctrl) return; // finish or cancel the running export first
  S.ex.open = false;
  $('rec-export').classList.add('hidden');
  $('pb-export').classList.remove('active');
  renderTimeline();
}

function syncExportInputs() {
  $('ex-start').value = toInput(S.ex.start);
  $('ex-end').value = toInput(S.ex.end);
  validateExport();
}

function readExportInputs() {
  S.ex.start = fromInput($('ex-start').value);
  S.ex.end = fromInput($('ex-end').value);
  validateExport();
}

/** Check the range, explain what will happen, and enable the button only when it can work. */
function validateExport() {
  const { start, end } = S.ex;
  let info = '', ok = false;
  if (start == null || end == null) info = 'Pick a start and an end';
  else if (end <= start) info = 'The end must be after the start';
  else if (end - start > MAX_EXPORT_MS) info = `Up to ${MAX_EXPORT_MS / 60e3} minutes per export (this is ${mmss(end - start)})`;
  else {
    const d0 = dayStart(S.day), d1 = d0 + DAY;
    const covered = S.segs.reduce((n, s) => n + Math.max(0, Math.min(s.end, end) - Math.max(s.start, start)), 0);
    const outside = Math.max(0, d0 - start) + Math.max(0, end - d1); // other days: checked when exporting
    if (!covered && !outside) info = 'No recording in this range';
    else {
      ok = true;
      const missing = end - start - covered - outside;
      info = `${mmss(end - start)} long` + (missing > 2000 ? ` · ${mmss(missing)} without recording will be skipped` : '');
    }
  }
  $('ex-info').textContent = info;
  $('ex-info').classList.toggle('error', !ok);
  $('ex-go').disabled = !ok || !!S.ex.ctrl;
  renderTimeline();
}

function exportName() {
  const cam = (cameras.find((c) => c.channel === S.channel)?.name || `ch${S.channel}`).replace(/[\\/:*?"<>|\s]+/g, '_');
  const a = fmt(S.ex.start).replace(/:/g, '-').replace(' ', '_'), b = fmt(S.ex.end);
  const to = b.slice(0, 10) === a.slice(0, 10) ? b.slice(11).replace(/:/g, '-') : b.replace(/:/g, '-').replace(' ', '_');
  return `${cam}_${a}_to_${to}.mp4`;
}

async function runExport() {
  const name = exportName(), { start, end } = S.ex;
  const msg = $('ex-msg'); msg.textContent = ''; msg.className = 'msg';
  // Where to save — ask first, while the click still counts as a user gesture.
  let sink;
  if (window.showSaveFilePicker) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
    const w = await handle.createWritable();
    sink = {
      write: (d) => w.write(d),
      writeAt: (position, d) => w.write({ type: 'write', position, data: d }),
      close: () => w.close(),
      abort: () => w.abort().catch(() => {}),
    };
  } else {
    // Fallback: build the file in memory, then download it.
    const parts = [];
    sink = {
      write: (d) => { parts.push(d); },
      writeAt: (_, d) => { parts[0] = d; }, // the only positional write is the header, which is part 0
      close: () => {
        const url = URL.createObjectURL(new Blob(parts, { type: 'video/mp4' }));
        el('a', { href: url, download: name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 60e3);
      },
      abort: () => { parts.length = 0; },
    };
  }
  const ctrl = S.ex.ctrl = new AbortController();
  setExportBusy(true);
  try {
    const r = await exportMp4(conn, S.channel, start, end, sink, {
      signal: ctrl.signal,
      onProgress: (p) => { $('ex-bar').style.width = `${Math.round(p * 100)}%`; },
    });
    msg.textContent = `Saved ${name} — ${mmss(r.seconds * 1000)} of video, ${r.width}×${r.height}` + (r.skippedMs > 2000 ? ` (${mmss(r.skippedMs)} without recording skipped)` : '');
  } catch (e) {
    await sink.abort?.();
    if (e.name !== 'AbortError') console.warn('export failed:', e.message);
    msg.textContent = e.name === 'AbortError' ? 'Export cancelled' : 'Export failed: ' + e.message;
    msg.classList.add('error');
  } finally {
    S.ex.ctrl = null;
    setExportBusy(false);
  }
}

function setExportBusy(on) {
  for (const id of ['ex-start', 'ex-end', 'ex-start-here', 'ex-end-here', 'ex-close']) $(id).disabled = on;
  $('ex-cancel').classList.toggle('hidden', !on);
  $('ex-progress').classList.toggle('hidden', !on);
  $('ex-bar').style.width = '0%';
  if (on) $('ex-go').disabled = true; else validateExport();
  $('ex-go').textContent = on ? 'Exporting…' : 'Export MP4';
}

// ---------- files (downloads) ----------

function renderFiles() {
  $('rec-files-count').textContent = S.files.length ? `(${S.files.length})` : '';
  $('rec-list').replaceChildren(...S.files.map((rec) => {
    const prog = el('span', { className: 'dl-progress' });
    const dlBtn = el('button', { textContent: 'Download' });
    dlBtn.addEventListener('click', () => downloadClip(rec, S.channel, dlBtn, prog));
    return el('li', { className: 'rec-item' },
      el('div', { className: 'rec-main' },
        el('span', { className: 'rec-time', textContent: `${rec.startTime.slice(11)} → ${rec.endTime.slice(11)}` }),
        el('span', { className: 'muted', textContent: [fmtDur(rec.durationSec), fmtSize(rec.length), dahua.isMotion(rec) && 'motion'].filter(Boolean).join(' · ') })),
      el('div', { className: 'rec-actions' }, prog,
        el('button', { textContent: 'Play', onclick: () => { seek(toMs(rec.startTime)); window.scrollTo({ top: 0, behavior: 'smooth' }); } }),
        dlBtn));
  }));
}

/** Save a recording window as .dav (streams to disk where the browser allows). */
export async function downloadClip(rec, channel, btn, prog) {
  const name = `ch${channel}_${rec.startTime.replace(/[-: ]/g, '')}.dav`;
  const ctrl = new AbortController();
  const reset = () => { btn.disabled = false; btn.textContent = 'Download'; };
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
      catch (e) { if (e.name === 'AbortError') { ctrl.abort(); reset(); prog.textContent = ''; return; } throw e; }
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
    prog.textContent = 'saved'; reset();
  } catch (e) {
    prog.textContent = 'failed'; reset();
    console.error(e);
  }
}
const pct = (done, total) => total ? Math.min(100, Math.round(done / total * 100)) + '%' : (done / 1e6).toFixed(0) + 'MB';
