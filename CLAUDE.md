# CLAUDE.md

Guidance for AI assistants (and humans) working in this repo.

## What this is

A **Manifest V3 Chrome extension** that views Dahua NVR/DVR/IP cameras with **no
server and no browser plugin**. All logic runs in the extension's own page
(`app.html`). The extension's `host_permissions` let it bypass CORS and perform
HTTP Digest auth straight from `fetch()` — which is the whole reason a plain web
page (or GitHub Pages) *cannot* do this and an extension can.

There is **no build step and no dependencies**. It's plain ES modules loaded
directly by the browser. Do not add a bundler/framework unless there's a real need.

## File map

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. `host_permissions` = `http/https://*/*` (needed to reach any device IP). Only other permission is `storage`. |
| `background.js` | Service worker. Sole job: open `app.html` in a tab when the toolbar icon is clicked. |
| `app.html` | Login screen + app shell (Live/Recordings tabs, fullscreen modal, playback modal). |
| `app.js` | All UI logic: login, live grid (thumbnails + on-demand streaming), fullscreen, recordings search, playback controls/timeline. |
| `style.css` | Dark/light theme, grid, modals, playback controls. |
| `lib/md5.js` | Pure-JS MD5 (Web Crypto has no MD5; Digest auth needs it). |
| `lib/dahua.js` | **Isomorphic** Dahua client (browser + Node): digest fetch, device info, channels, snapshot, MJPEG stream, find recordings, download clip. |
| `lib/h264play.js` | Recording player: streams a bounded `.dav`, demuxes DHAV → H.264, decodes via WebCodecs to a canvas. |
| `test/node-smoke.mjs` | Runs the shared client against a real device from Node (no CORS in Node) to prove the digest/MJPEG/find/download logic. |
| `icons/` | Extension icons (SVG source + rasterized 16/32/48/128). Regenerate with `rsvg-convert -w N -h N icon.svg -o icon-N.png`. |

## Key technical facts (learned the hard way)

- **Digest auth**: `qop=auth`, MD5. `HA1 = md5(user:realm:pass)`,
  `HA2 = md5(method:uri)`, `response = md5(HA1:nonce:nc:cnonce:qop:HA2)`. First
  request gets a 401 with the challenge, second request carries the `Authorization`.
- **Live video**: only the **substream** is fetchable as MJPEG over HTTP
  (`/cgi-bin/mjpg/video.cgi?channel=N&subtype=1`). The main stream is H.264-only
  and not usable as HTTP MJPEG. So live view is capped at substream resolution
  (typically D1). Parse the `multipart/x-mixed-replace` body by scanning for JPEG
  SOI `FFD8` … EOI `FFD9`.
- **Snapshots**: `/cgi-bin/snapshot.cgi?channel=N` is full-res but **rate-limited** —
  parallel requests fail. Load thumbnails **sequentially** with a small gap.
- **`mediaFileFind.cgi`**: the `condition.Channel` is **0-based** even though the
  UI/channels are 1-based. Off-by-one here = "no recordings".
- **Recording download**: use `loadfile.cgi?action=startLoad&...` — it streams a
  bounded byte window reliably. `RPC_Loadfile` / `RPC2` stalls. ffmpeg `-f dhav`
  reads `.dav` from a *file* but not from a pipe (DHII framing) — irrelevant here
  since we demux in JS, but noted.
- **DHAV demux**: frames start with ASCII `DHAV`; frame length is a `u32LE` at
  offset `+12`; drop the trailing 8-byte footer. Inside is Annex-B H.264.
- **WebCodecs feed**: configure `VideoDecoder` with an **avcC `description`** built
  from SPS(type 7)/PPS(type 8), and feed each frame's **VCL NALs** (type 1 non-IDR,
  5 IDR) as **4-byte length-prefixed (AVCC)**. Drop AUD(9)/SEI(6). Start decoding
  only from the first key frame. Feeding raw Annex-B with a bare codec string gives
  "Decoding error".
- **Seek** in recordings is implemented by **re-requesting** the `.dav` stream from
  a new start time (`startLoad` from `startTime + offset`), then restarting the
  decoder — there's no random access inside the container.

## Conventions

- Keep `lib/dahua.js` isomorphic (must run under Node for the smoke test) — use only
  `fetch`/`AbortController`/`TextDecoder`, no DOM.
- No secrets in the repo. The login is generic; never hardcode an IP/serial/password.
  The only example IP is a generic `192.168.1.108`.
- Test after changes to the client with:
  `node test/node-smoke.mjs <ip> <user> <pass>` (needs a reachable device).
- Icons: edit `icons/icon.svg`, then re-rasterize the four PNGs.

## Things intentionally NOT done

- No cloud/P2P built in (browsers can't speak Dahua P2P — see README remote-access).
- No transcoding server. Everything is native browser decode.
- No audio (recordings are decoded video-only).
