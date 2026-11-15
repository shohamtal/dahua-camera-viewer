# Changelog

All notable changes to Dahua Camera Viewer. Versions follow `manifest.json`;
a feature release (x.**y**) opens the bundled "What's new" page once after the
update — keep `whats-new.html` in step with the newest feature release.

## 1.2.2 — 2026-11-15

### Security
- Settings read from the NVR could change how the page itself behaves (a hacked
  NVR, or someone on the network altering its answers). Those keys are now ignored.
- A wrong password is now reported as a wrong password, and costs one failed login
  instead of three. If the NVR refuses a saved password, the extension stops
  retrying it on every page open, so it can't lock the account.
- The Security page no longer says "No red flags" when it couldn't read a setting:
  it shows "unknown". The firmware check uses the September 2021 fix date, and
  the green "ok" badge is gone.
- The log CSV can no longer run formulas when opened in a spreadsheet.
- The address box only accepts a host name or IP address (a pasted
  `http://…` link is cleaned up).

### Fixed
- Live video that stopped or froze now reconnects by itself; a camera that stays
  silent goes back to thumbnails.
- Up to 4 cameras play live at once. More than that used up all of Chrome's
  connections to the NVR and stalled everything else.
- Downloading a `.dav` asks where to save first, so it no longer fails on a slow
  NVR, and a failed download doesn't leave a connection or a partial file behind.
- Days when the clocks change (23 or 25 hours) show correctly on the timeline.
- A page left open keeps up: new days appear in the calendar, and playback of
  today continues into video recorded since the page was loaded.
- One empty answer no longer turns off the low-quality stream for fast playback.
- A session on the NVR's own screen is no longer listed as "outside your network";
  Tailscale addresses (100.64.x.x) count as local.
- Clicking the toolbar icon brings the viewer's window to the front.

### Added
- "Use HTTPS" on the login form.
- A hidden tab stops loading thumbnails, and stops live video after a minute.

## 1.2.1 — 2026-10-07

### Fixed
- Live view stuck on "Connecting…" when a camera's sub stream is H.264 (Dahua's
  default). Live view needs the sub stream in MJPEG; the Live tab now says which
  cameras aren't, links admins to Admin › Streams, and gives up after 10 s
  without a frame instead of waiting forever.
- Those silent streams also held connections open, which slowed down the
  snapshot thumbnails.

## 1.2.0 — 2026-10-05

### Fixed
- **Recordings of the wrong camera.** Recording search and playback numbered
  cameras from 0 instead of 1, so camera *N* showed and played camera *N−1*'s
  recordings, and cameras after a disconnected one showed "no recordings".
- Playback stopped at the end of each hourly recording file ("End of recordings
  for this day" on a full day).
- Random playback freezes ("Decoding error") caused by reading the DHAV header
  as video data.
- Clicking a tab while the app was still connecting left it empty.
- A search that finds nothing (HTTP 400 on some firmware) no longer shows as an error.

### Added
- **Recordings:** a calendar marking the days with video; one 24-hour
  timeline per day with recorded spans and motion marks; click/drag to play from
  any moment; zoom 24h / 1h / 10m; keyboard shortcuts.
- **Fast playback:** 2×, 4×, 8× and Max (as fast as the NVR streams).
- **◀ Motion ▶** — jump between motion events; Events tab opens the moment on the timeline.
- **Export MP4:** up to 20 minutes, copied as recorded (no re-encoding), with a
  summary/confirmation, progress and Cancel.
- **Report a problem:** local error log + a redacted report shared only via the
  user's own click (GitHub issue or Copy).
- A one-time, dismissible rating request after 5 days of use.
- A warning when the NVR's clock differs from the computer's.
- "What's new" page after feature updates; opening the app on first install.
- Jumping on the timeline keeps the last frame with a spinner instead of a black screen.

## 1.1.1 — 2026-10-01
- The Admin tab is shown only to admin-group accounts (limited accounts saw
  errors and a misleadingly clean security check).

## 1.1.0 — 2026-09-29
- **Admin tab:** security check (firmware, UPnP, P2P, live sessions), per-person
  accounts, device log, sub-stream and clock settings.
- **Events tab:** motion events per camera on a 24-hour strip.
- **Several NVRs:** saved list and a top-bar switcher.
- Auto-reconnect shows progress; sign-out forgets only the password.

## 1.0.1 — 2026-09-10
- Host access is requested per device at runtime instead of for all sites at install.

## 1.0.0 — 2026-08-11
- First release: live grid (MJPEG sub-stream), recordings search, in-browser
  playback (WebCodecs) and .dav download — no plugin, no server.
