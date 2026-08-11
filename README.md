# Dahua Camera Viewer (Chrome extension)

A plugin-free, **server-free** viewer for Dahua NVRs / DVRs / IP cameras. It runs
entirely in Chrome and talks to the device directly over your LAN — no ffmpeg, no
Node backend, no cloud.

It exists because the device's own web UI needs the old `webplugin.pkg`
(NPAPI/ActiveX), which modern browsers removed years ago. A Chrome extension is
the one thing that can still reach the device directly, because it can bypass
CORS and perform Digest auth from JavaScript.

## Features
- **Login** — IP, port, username, password (generic; nothing hardcoded). Optionally remembered in the browser.
- **Live grid** — every channel, live, via the device's **MJPEG substream** (frames are decoded natively by the browser; disabled/offline channels show "No signal").
- **Recordings** — pick a camera + date, list clips, and **download** them (streamed straight to disk).

## How it works
- `lib/md5.js` — pure-JS MD5 (Web Crypto has none) for Digest auth.
- `lib/dahua.js` — Digest `fetch`, channel list, MJPEG frame extractor (scans `FFD8…FFD9`), `mediaFileFind`, and `loadfile.cgi` download. Isomorphic: the same file is exercised by `test/node-smoke.mjs`.
- `app.html` / `app.js` / `style.css` — the viewer UI.
- `background.js` — opens the viewer in a tab from the toolbar icon.

## Install (load unpacked)
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's toolbar icon → the viewer opens in a tab. Log in with your device IP + credentials.

## Requirements / limits
- **You must be on the same LAN as the device.** The extension reaches the device's private IP directly; it does nothing for remote access (that still needs Dahua P2P, port-forwarding, or a tunnel).
- **Chrome desktop** (Mac/Windows/Linux). Android Chrome does not support extensions.
- **Live is the MJPEG substream** (e.g. 704×576, ~8 fps) — the main stream is H.264, which browsers can't decode without a plugin/transcoder. For full-res H.264 live + in-browser recording playback, use the companion local-server version.
- **Recording playback** in-browser is not included: `.dav` isn't browser-decodable. Download the clip and open it in **VLC** or Dahua Smart Player. (In-browser playback is a possible phase-2 via WebCodecs.)
- Credentials, if remembered, are stored in `chrome.storage.local` (this profile only), in plaintext — same trust level as saving them in the browser.

## Dev test
```bash
node test/node-smoke.mjs 192.168.0.138 admin <password>
```
Runs the shared client against a real device (Node has no CORS): validates MD5, login, channels, MJPEG frame extraction, recording search, and download streaming.
