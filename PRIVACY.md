# Privacy Policy — Dahua Camera Viewer

_Last updated: 2026-10-04_

Dahua Camera Viewer is a Chrome extension that connects **directly** from your
browser to a camera / NVR / DVR device that **you** own and configure.

## What data the extension handles

- **Connection details you enter** — for each device you save: an optional name,
  IP address, HTTP port, username, and password; plus the model and serial number
  the device reports.
- **Video and recording data** returned by your device.

## Where that data goes

- Your connection details are stored **locally**, using Chrome's `storage.local`
  API, inside your own Chrome profile on your own computer, so the extension can
  list your devices and reconnect. The **password** is stored only if you leave
  "Remember on this computer" checked; signing out removes it. Removing a device
  (✕ on the login screen) deletes all of its details and the extension's access to
  its address.
- Passwords the extension generates for new NVR accounts are shown once and never
  stored.
- Those details are used **solely** to authenticate to the device IP address you
  entered.
- Video, snapshots, and recordings are streamed **directly** from your device to
  your browser.

## Problem reports and the error log

- The extension keeps a short **error log** (the last 200 errors) in `storage.local`
  on your computer, so a problem can be reported after it happens. It is never
  sent anywhere by itself.
- **Report a problem** shows you the full report before anything leaves your
  computer. IP addresses, device addresses, serial numbers, usernames, passwords,
  device and camera names, MAC and email addresses are replaced with placeholders.
  The report contains the extension and Chrome version, the NVR model and
  firmware, what you typed, and the recent log.
- It is shared **only if you click** "Open a GitHub issue" (which opens GitHub in
  a new tab, where you can edit it and choose whether to submit it under your own
  GitHub account) or copy it yourself.

## Rating request

After you have used the extension on a few different days, it may ask once
whether you'd like to rate it. Only the count of days used is stored (locally),
to decide when to ask; "Maybe later" and "✕" are remembered the same way.

## What the extension does NOT do

- It does **not** send your credentials, video, or any other data to the developer,
  to any server, or to any third party.
- It has **no analytics, no telemetry, no tracking, and no ads.**
- It makes **no** network requests other than to the device address you provide.
  (Opening a GitHub issue or the store's review page only happens when you click,
  in a normal browser tab.)

## Permissions and why they're needed

- **`storage`** — to remember your saved devices (and, optionally, their
  passwords) on your computer.
- **Host access (optional, per-device)** — a camera can live at any IP address on
  your network (or a remote address you set up), which isn't known ahead of time.
  Host access is declared as an **optional** permission and is **requested at
  runtime for only the specific host you connect to** (e.g. `http://192.168.1.108/*`)
  when you click Connect — not granted broadly at install time. The extension only
  ever contacts the host you enter.

## Your control

Remove all stored data at any time by signing out in the extension, or by removing
the extension from `chrome://extensions`.

## Contact

Questions: open an issue on the project's GitHub repository.
