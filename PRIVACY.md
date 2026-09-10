# Privacy Policy — Dahua Camera Viewer

_Last updated: 2026-09-10_

Dahua Camera Viewer is a Chrome extension that connects **directly** from your
browser to a camera / NVR / DVR device that **you** own and configure.

## What data the extension handles

- **Connection details you enter** — device IP address, HTTP port, username, and
  password.
- **Video and recording data** returned by your device.

## Where that data goes

- Your connection details are stored **locally**, using Chrome's `storage.local`
  API, inside your own Chrome profile on your own computer. This is only done if you
  leave "Remember on this computer" checked.
- Those details are used **solely** to authenticate to the device IP address you
  entered.
- Video, snapshots, and recordings are streamed **directly** from your device to
  your browser.

## What the extension does NOT do

- It does **not** send your credentials, video, or any other data to the developer,
  to any server, or to any third party.
- It has **no analytics, no telemetry, no tracking, and no ads.**
- It makes **no** network requests other than to the device address you provide.

## Permissions and why they're needed

- **`storage`** — to optionally remember your device connection details on your
  computer.
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
