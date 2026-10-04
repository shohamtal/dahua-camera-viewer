// In-browser recording playback: stream a bounded .dav window from the NVR,
// demux Dahua's DHAV container into H.264, and decode with WebCodecs onto a
// canvas. Only the bytes actually watched are fetched — no multi-GB download.
//
// WebCodecs H.264 is fed the well-supported way: an avcC `description` built
// from SPS/PPS, and each frame's VCL NALs as 4-byte length-prefixed data
// (AVCC). AUD/SEI NALs are dropped.
import { downloadClip } from './dahua.js';
import { buildAvcC, toAvcc, readDhav } from './dhav.js';

const hex2 = (n) => n.toString(16).padStart(2, '0');

/**
 * Play [start, end] ("YYYY-MM-DD HH:MM:SS") of a channel onto a canvas.
 * - speed: playback rate. Up to 4× every frame is decoded; from 8× only key
 *   frames are shown (the stream still has to be read, but decode stays cheap).
 *   The clock never runs ahead of the data, so a high value (Max) plays as fast
 *   as the NVR streams.
 * - subtype: 0 main stream, 1 sub stream (much smaller — good for fast speeds).
 * - onTime(ms): recording wall-clock time of the frame on screen.
 * - onEnded({frames}): the stream ran out (end of the window, or the NVR had
 *   nothing there); frames = how many video frames arrived.
 */
export function playRecording(conn, channel, start, end, canvas, {
  fps = 20, speed = 1, subtype = 0, onStatus = () => {}, onTime = () => {}, onEnded = () => {},
} = {}) {
  const ctrl = new AbortController();
  const ctx = canvas.getContext('2d');
  let decoder = null, stopped = false, paused = false, firstDrawn = false, sps = null, pps = null;
  let needKey = true;      // decode resumes only at a key frame (start, after skipping)
  let ended = false, endedFired = false, frames = 0;
  const queue = [];        // {key, data(AVCC), vt: video ms from start, at: wall-clock ms|null}
  const wallByTs = new Map();
  let lastSec = -1, clock = null, lastDecodedVt = 0, lastTick = performance.now();
  const startMs = (() => { const m = start.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0; })();

  function ensureDecoder() {
    if (decoder || !sps || !pps) return;
    const codec = 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]);
    decoder = new VideoDecoder({
      output: (frame) => {
        const at = wallByTs.get(frame.timestamp); wallByTs.delete(frame.timestamp);
        if (stopped) { frame.close(); return; }
        if (canvas.width !== frame.displayWidth) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        if (!firstDrawn) { firstDrawn = true; onStatus(''); }
        const t = at ?? startMs + frame.timestamp / 1000;
        if (Math.floor(t / 1000) !== lastSec) { lastSec = Math.floor(t / 1000); onTime(t); }
      },
      // A decode error closes the decoder: start a new one at the next key frame.
      error: (e) => { console.warn('decode error, resyncing:', e.message); decoder = null; needKey = true; },
    });
    decoder.configure({ codec, description: buildAvcC(sps, pps), optimizeForLatency: true });
  }

  function decode(c) {
    const ts = Math.round(c.vt * 1000);
    if (c.at != null) wallByTs.set(ts, c.at);
    try { decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: ts, data: c.data })); }
    catch { needKey = true; }
    lastDecodedVt = c.vt;
  }

  // Release frames as the playback clock (video ms × speed) passes them.
  const pump = setInterval(() => {
    const now = performance.now(), dt = now - lastTick; lastTick = now;
    if (stopped) return;
    // Fires even with no decoder: the NVR may send nothing for a time with no video.
    if (ended && !queue.length && !endedFired && (!decoder || decoder.decodeQueueSize === 0)) { endedFired = true; onEnded({ frames }); }
    if (!decoder) ensureDecoder();
    if (!decoder) return;
    if (!queue.length) {
      if (clock != null) clock = Math.min(clock, lastDecodedVt + 300); // don't run ahead of the data
      return;
    }
    if (paused) return;
    if (clock == null) clock = queue[0].vt;
    clock += dt * speed;
    const keysOnly = speed >= 8;
    for (let n = 0; queue.length && queue[0].vt <= clock && decoder.decodeQueueSize < 8 && n < 120; n++) {
      const c = queue.shift();
      // Skip deltas in key-frame mode, after a skip, or when we've fallen >1.5 s behind.
      if (!c.key && (keysOnly || needKey || clock - c.vt > 1500)) { needKey = true; continue; }
      needKey = false;
      decode(c);
    }
  }, 25);

  (async () => {
    let res;
    try { res = await downloadClip(conn, channel, start, end, subtype, ctrl.signal); }
    catch (e) { if (e.name !== 'AbortError') onStatus('Load failed: ' + e.message); ended = true; return; }
    if (!res.ok || !res.body) { onStatus('No recording data'); ended = true; return; }
    let vt = 0, prevMs = null;
    try {
      for await (const f of readDhav(res.body)) {
        if (stopped) break;
        if (f.sps && !sps) sps = f.sps;
        if (f.pps && !pps) pps = f.pps;
        ensureDecoder();
        // Pace by the header's ms counter (wraps at 65536); jumps fall back to 1/fps.
        if (prevMs != null) { const d = (f.ms - prevMs + 65536) % 65536; vt += d > 0 && d < 4000 ? d : 1000 / fps; }
        prevMs = f.ms;
        frames++;
        if (decoder) queue.push({ key: f.key, data: toAvcc(f.vcl), vt, at: f.at });
        // Stay at most ~20 s (of video) ahead of the playback clock.
        while (!stopped && queue.length > 60 && queue[queue.length - 1].vt - (clock ?? 0) > 20000) await new Promise((r) => setTimeout(r, 50));
      }
    } catch { /* network error / aborted: treat as the end of the stream */ }
    ended = true;
  })();

  return {
    stop() {
      stopped = true; ctrl.abort(); clearInterval(pump);
      try { decoder && decoder.state !== 'closed' && decoder.close(); } catch {}
    },
    pause() { paused = true; },
    resume() { paused = false; lastTick = performance.now(); },
    setSpeed(s) { speed = s; },
    get paused() { return paused; },
  };
}
