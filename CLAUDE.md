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
| `manifest.json` | MV3 manifest. Host access is **`optional_host_permissions`** (`http/https://*/*`) — requested at runtime for only the host the user connects to (see `app.js` `requestHostPermission`), so there's no broad install-time grant. Only static permission is `storage`. |
| `background.js` | Service worker. Sole job: open `app.html` in a tab when the toolbar icon is clicked. |
| `app.html` | Login screen + app shell (Live/Recordings/Events/Admin tabs, fullscreen modal, Recordings player + timeline). |
| `app.js` | App shell: login/auto-reconnect, saved NVR list + top-bar switcher, tab switching (`showView`), live grid (thumbnails + on-demand streaming), fullscreen, Events tab (per-camera 24h strip + list → opens the moment on the Recordings timeline). |
| `recordings-ui.js` | Recordings tab: calendar that marks days with video, one 24h timeline per day (recorded spans, motion marks, zoom 24h/1h/10m, click/drag to play), 1×–16× speed, next/previous motion, file list + downloads. |
| `admin-ui.js` | Admin tab (Security, Users, Log, Streams, Clock sub-sections) over `lib/admin.js`. Sections load on first open and re-read the device after each change. |
| `style.css` | Dark/light theme, grid, modals, playback controls, event strips, admin tables/forms. |
| `lib/md5.js` | Pure-JS MD5 (Web Crypto has no MD5; Digest auth needs it). |
| `lib/dahua.js` | **Isomorphic** Dahua client (browser + Node): digest fetch, device info, channels, snapshot, MJPEG stream, find recordings / motion events, download clip. |
| `lib/admin.js` | **Isomorphic** NVR admin calls shared by the Admin tab and Node: users, log, exposure/firmware checks, sub-stream config, clock. Read-only test: `test/admin-read.mjs`. |
| `lib/h264play.js` | Recording player: streams a bounded `.dav`, demuxes DHAV → H.264, decodes via WebCodecs to a canvas. Variable speed (key frames only from 8×), main/sub stream, reports the recording's wall-clock time from DHAV headers. |
| `scripts/nvr.mjs` | Node CLI for NVR admin (users, passwords, log, UPnP/P2P exposure) via `userManager.cgi` / `log.cgi` / `configManager.cgi`. Manual: `docs/NVR-CLI.md`. Output contains secrets — never commit it. |
| `test/node-smoke.mjs` | Runs the shared client against a real device from Node (no CORS in Node) to prove the digest/MJPEG/find/motion/download logic. |
| `test/playback-probe.mjs` | Read-only check of playback assumptions on a real NVR: DHAV timestamps vs requested time, whether the sub stream is stored, real streaming speed, what a no-video time returns. |
| `test/admin-read.mjs` | Read-only check of `lib/admin.js` against a real device (`NVR_HOST`/`NVR_USER`/`NVR_PASS` env). Makes no changes. |
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
- **Motion events** come from the recording index, not a separate event log:
  `findFile` with `condition.Flags[0]=Event&condition.Events[0]=VideoMotion`. If the
  firmware rejects/ignores that, `findMotion` filters the full listing by each file's
  `Flags`/`Events`. Back-to-back files (gap ≤ 5 s) are merged into one event. Only
  recordings the NVR flagged for motion show up (motion recording must be enabled).
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
  a new start time, then restarting the decoder — there's no random access inside
  the container. `startLoad` is **time-based**, not file-based, so the timeline
  plays from any moment; the player streams to the end of the contiguous recorded
  span and the UI continues at the next span when it ends (`onEnded`).
- **DHAV header**: `+4` frame type (`0xFD` I, `0xFC` P), `+16` packed local
  date-time (sec 6 bits, min 6, hour 5, day 5, month 4, year−2000 6 — as in
  ffmpeg's dhav demuxer), `+20` u16 millisecond counter. The player paces by the
  ms counter and reports the date-time, so the playhead is right across gaps.
- **Fast playback** decodes every frame up to 4×, key frames only from 8×, and
  switches to the **sub stream** (`subtype=1`) from 4×. Not every NVR stores the
  sub stream: zero frames back → fall back to the main stream (`sdBroken`).
- **Days with video**: no dedicated API — one `findFile` over the last 35 days
  (paged by 100), bucketed by day. A time inside a gap is snapped to the next
  recorded span before requesting (unverified what an NVR streams for a gap —
  check with `test/playback-probe.mjs`).

## NVR admin (Admin tab + CLI)

- **Changing another user's password** isn't possible over CGI without their old
  password, so `admin-ui.js` (and the CLI) **delete and recreate** the account with
  the same group/authorities/memo. If the recreate fails the account is gone — the
  UI says so.
- **The built-in `admin` password can't be changed over CGI** on NVR4108 fw 3.215
  (`modifyPassword` → 400, `modifyUser` → "OK" but ignored). The UI points to the
  NVR's web UI instead of offering it.
- **Permissions** are `Monitor_NN` (live) / `Replay_NN` (playback), 2-digit
  1-based channels. When editing a user's cameras, keep their other authorities —
  `modifyUser` replaces the whole list. Some firmware force-adds group defaults
  (e.g. `AuthManuCtr`).
- **Writes answer `OK`**; anything else is an error (`admin-ui.js` `ok()`).
  P2P is `T2UServer[0].Enable`, UPnP is `UPnP.Enable`, sub-stream keys are
  `Encode[ch-1].ExtraFormat[0].Video.*` (`subStreamKey`).
- **The log is a ring buffer** (~1024 entries) and every session adds a
  login/logout, so reading it pushes history out. Detail values can contain bare
  LFs — `parseLines` treats non-`key=` lines as continuations.
- **The Admin tab is shown only to admin-group accounts** (`isAdminAccount`: own
  `getUserInfo` group, else whether `getUserInfoAll` is allowed). The NVR enforces
  permissions itself; hiding the tab avoids error pages and a falsely clean
  Security check (unreadable config reads as "UPnP/P2P off").
- **Device data is untrusted.** Rogue accounts on a hacked NVR have attacker-chosen
  names and memos: render device strings with `textContent` / `el()`, never
  `innerHTML`.

## Multiple NVRs

`chrome.storage.local` holds `devices` (one entry per `host:port`: name, user,
optional password, last device info) and `lastId`. The old single `conn` key is
migrated on first load. Switching NVRs sets `lastId` and **reloads the page**, so
every view, stream and admin section starts clean — `conn` is a single global.
Forgetting an NVR also drops its host permission.

## Conventions

- Keep `lib/dahua.js` and `lib/admin.js` isomorphic (must run under Node for the
  tests and the CLI) — use only `fetch`/`AbortController`/`TextDecoder`/
  `crypto.getRandomValues`, no DOM. UI code goes in `app.js` / `admin-ui.js`.
- No secrets in the repo. The login is generic; never hardcode an IP/serial/password.
  The only example IP is a generic `192.168.1.108`.
- Test after changes to the client with:
  `node test/node-smoke.mjs <ip> <user> <pass>` and
  `NVR_HOST=<ip> NVR_PASS=… node test/admin-read.mjs` and
  `NVR_HOST=<ip> NVR_PASS=… node test/playback-probe.mjs` (need a reachable device).
- Anything in the Admin tab that writes to the NVR must `confirm()` first when it
  is destructive (delete, password reset, turning P2P off / UPnP on).
- Icons: edit `icons/icon.svg`, then re-rasterize the four PNGs.

## Things intentionally NOT done

- No cloud/P2P built in (browsers can't speak Dahua P2P — see README remote-access).
- No transcoding server. Everything is native browser decode.
- No audio (recordings are decoded video-only).
- No combined multi-NVR view: one NVR is connected at a time (switching reloads).
- No thumbnails for motion events / timeline yet (each would be one short `startLoad`
  + key-frame decode — planned once the timeline is proven on real NVRs).
- No client-side motion analysis of recordings: it would mean downloading the whole
  day's video. Use the NVR's own motion marks instead.
