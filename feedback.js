// Feedback to the developer — never automatic:
// 1. A local error log (last 200 entries) and a "Report a problem" dialog that
//    shows the user exactly what would be shared, with addresses, serials,
//    usernames and camera names replaced, and sends it only via the user's own
//    click (a pre-filled GitHub issue, or Copy).
// 2. An occasional, dismissible request to rate the extension on the store.

export const REPO = 'shohamtal/dahua-camera-viewer';
export const STORE_ID = 'eljnhbbnjmgffhfnmmpdnjjikjdhcpbf';
const LOG_MAX = 200;
const RATE_AFTER_DAYS = 5;     // distinct days with a successful connection
const RATE_SNOOZE_DAYS = 10;   // "Maybe later" asks again after this many more

const hasChromeStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const store = {
  get: (k) => hasChromeStore
    ? new Promise((r) => chrome.storage.local.get(k, (d) => r(d[k] ?? null)))
    : Promise.resolve(JSON.parse(localStorage.getItem(k) || 'null')),
  set: (k, v) => hasChromeStore
    ? new Promise((r) => chrome.storage.local.set({ [k]: v }, r))
    : Promise.resolve(localStorage.setItem(k, JSON.stringify(v))),
};
const $ = (id) => document.getElementById(id);
const version = () => (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().version) || 'dev';

// ---------- error log ----------

let log = [];
let saveTimer = null;
const ctx = { conn: null, cameras: [], devices: [] };

/** Add a line to the local log (also used for notable app failures). */
export function logEvent(level, ...args) {
  const msg = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}${a.stack ? '\n' + a.stack.split('\n').slice(1, 4).join('\n') : ''}` : typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 600);
  log.push({ t: new Date().toISOString(), level, msg });
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('diagLog', log), 1500); // survives a reload
}
const safeJson = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

// Capture uncaught errors and console warnings/errors from the moment this loads.
store.get('diagLog').then((saved) => { if (Array.isArray(saved)) log = [...saved, ...log].slice(-LOG_MAX); });
window.addEventListener('error', (e) => logEvent('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logEvent('error', 'Unhandled promise rejection:', e.reason));
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { logEvent(level, ...args); orig(...args); };
}

/** What the report may need to hide (current NVR, cameras, saved NVRs). */
export function setFeedbackContext({ conn, cameras, devices }) {
  if (conn !== undefined) ctx.conn = conn;
  if (cameras) ctx.cameras = cameras;
  if (devices) ctx.devices = devices;
}

/** Replace anything identifying: IPs, host, users, passwords, serials, names, MACs, emails. */
export function redact(text) {
  let s = String(text);
  const exact = [];
  const add = (v, label) => { if (v && String(v).length >= 2) exact.push([String(v), label]); };
  for (const d of [ctx.conn, ...ctx.devices].filter(Boolean)) {
    add(d.pass, '<password>'); add(d.host, '<nvr-address>'); add(d.device?.serial, '<serial>'); add(d.name, '<nvr-name>'); add(d.user, '<user>');
  }
  ctx.cameras.forEach((c) => add(c.name, `<camera ${c.channel}>`));
  exact.sort((a, b) => b[0].length - a[0].length); // longest first
  for (const [v, label] of exact) s = s.split(v).join(label);
  return s
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi, '<mac>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/([?&](?:user|username|name|pwd|password|pass|loginName)=)[^&\s]*/gi, '$1<hidden>');
}

/** The full report text — exactly what the user sees before sharing. */
export function buildReport(what = '', { maxLog = 60 } = {}) {
  const d = ctx.conn?.device || {};
  const ua = navigator.userAgent;
  const chromeVer = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '?';
  // Only free text (description, log) can hold personal data; the rest is fixed fields.
  const local = (iso) => { const d = new Date(iso), p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const lines = log.slice(-maxLog).map((e) => `${local(e.t)} ${e.level.toUpperCase().padEnd(5)} ${redact(e.msg)}`);
  return [
    '### What happened',
    redact(what.trim()) || '(please describe what you did and what went wrong)',
    '',
    '### Environment',
    `- Extension: ${version()}`,
    `- Chrome: ${chromeVer} on ${os}`,
    `- NVR: ${d.type || '?'}${d.firmware ? `, firmware ${d.firmware}` : ''}${ctx.cameras.length ? `, ${ctx.cameras.length} cameras` : ''}`,
    `- Tab: ${document.querySelector('.seg-btn.active')?.dataset.view || 'login'}`,
    '',
    `### Recent log (${lines.length} of ${log.length})`,
    '```',
    ...(lines.length ? lines : ['(no errors logged)']),
    '```',
  ].join('\n');
}

// ---------- "Report a problem" dialog ----------

export function initFeedback() {
  document.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openReport(); }));
  $('report-close').addEventListener('click', closeReport);
  $('report-modal').addEventListener('click', (e) => { if (e.target.id === 'report-modal') closeReport(); });
  $('report-what').addEventListener('input', refreshReport);
  $('report-github').addEventListener('click', () => {
    const what = $('report-what').value.trim();
    const title = 'Problem: ' + (redact(what).split('\n')[0].slice(0, 80) || 'something went wrong');
    // Keep the URL within what browsers/GitHub accept: trim the log until it fits.
    let body, n = 60;
    do { body = buildReport(what, { maxLog: n }); n -= 10; } while (encodeURIComponent(body).length > 7000 && n > 0);
    window.open(`https://github.com/${REPO}/issues/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
  });
  $('report-copy').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText($('report-text').value);
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReport(); });
  $('rate-yes').addEventListener('click', () => { window.open(`https://chromewebstore.google.com/detail/${STORE_ID}/reviews`, '_blank', 'noopener'); updateRating({ done: true }); });
  $('rate-later').addEventListener('click', () => updateRating({ snooze: true }));
  $('rate-never').addEventListener('click', () => updateRating({ done: true }));
}

function openReport() {
  $('report-modal').classList.remove('hidden');
  refreshReport();
  $('report-what').focus();
}
function closeReport() { $('report-modal').classList.add('hidden'); }
function refreshReport() { $('report-text').value = buildReport($('report-what').value); }

// ---------- rating request ----------

const today = () => new Date().toISOString().slice(0, 10);

/** Call after each successful connection; shows the rating bar when it's time. */
export async function noteSuccessfulUse() {
  const r = (await store.get('rating')) || { days: [], askAt: RATE_AFTER_DAYS, done: false };
  if (!r.days.includes(today())) { r.days.push(today()); r.days = r.days.slice(-60); await store.set('rating', r); }
  $('rate-bar').classList.toggle('hidden', r.done || r.days.length < r.askAt);
}

async function updateRating({ done, snooze }) {
  const r = (await store.get('rating')) || { days: [], askAt: RATE_AFTER_DAYS, done: false };
  if (done) r.done = true;
  if (snooze) r.askAt = r.days.length + RATE_SNOOZE_DAYS;
  await store.set('rating', r);
  $('rate-bar').classList.add('hidden');
}
