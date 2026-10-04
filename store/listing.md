# Chrome Web Store — listing copy

Paste these into the Web Store developer dashboard.

## Name
Dahua Camera Viewer

## Summary (≤132 chars)
Plugin-free viewer for Dahua NVR/DVR/IP cameras — live view + recordings, directly over your network. No plugin, no server.

## Category
Productivity  (alt: Tools)

## Language
English

## Detailed description

<!-- One line per paragraph: the store keeps line breaks as typed. -->

View your Dahua NVR, DVR, or IP cameras straight from Chrome — live view, recordings playback and MP4 export, with no NPAPI/ActiveX "webplugin" and no server.

Project's repository: https://github.com/shohamtal/dahua-camera-viewer

Dahua's built-in web interface still relies on the old "webplugin" that modern browsers removed years ago, so live video and playback no longer work there. This extension talks to your NVR directly using its standard HTTP API, so everything runs in your browser on your own network — a lightweight alternative to SmartPSS on the desktop.

NEW IN 1.2
• Recordings rebuilt: a calendar that marks the days with video, and one 24-hour timeline per day — click anywhere to play from that moment.
• Export MP4: save up to 20 minutes as an .mp4 that plays on any phone or computer (full quality, no re-encoding).
• Fast playback (2×–8× and Max) and jumps between motion events.
• Fixed: on NVRs with several cameras, recordings now always belong to the right camera.

FEATURES
• Live view: a grid of all channels as snapshot thumbnails — click a camera to stream it live, or open it fullscreen. Nothing streams until you ask.
• Playback: pick a day on the calendar, scrub the 24-hour timeline, zoom in to the minute, skip ±10 s, play up to 8× or as fast as the NVR sends. Only the part you watch is streamed.
• Export MP4 clips (up to 20 minutes) or download the original .dav files.
• Motion events: every motion alert of the day per camera — click one to jump straight into that recording.
• NVR admin and security check: outdated firmware, UPnP port forwards, P2P cloud, who's logged in right now, unknown admin accounts; limited per-person accounts (for neighbours, family, a guard), device log, stream and clock settings.
• Several NVRs (e.g. one per building): save them all and switch from the top bar.
• Report a problem in one click — you see the report first, with addresses, serials and names hidden.
• Works with Dahua NVRs, DVRs and IP cameras that support the standard Dahua HTTP-CGI API (H.264).
• Dark / light theme.
• 100% local: your credentials and video never leave your computer and your device. No accounts, no cloud, no tracking, no ads.

HOW TO USE
1. Click the toolbar icon to open the viewer.
2. Enter your device's IP address, port, username, and password (the same ones you use in the Dahua app).
3. Connect.

Works on your home network out of the box. For remote viewing, use a VPN into your home (recommended) or port forwarding — see the project page for a security guide.

Not affiliated with or endorsed by Dahua. Open source (MIT).

## Single purpose (dashboard field)
View and manage a user-owned Dahua-compatible camera/NVR/DVR (live video,
recordings, motion events, and the device's own accounts/settings) by connecting
to it directly over the local network.

## Permission justifications (dashboard fields)

storage:
Used to remember the user's saved devices (name, IP, port, username, and — only if
they tick "Remember" — the password) locally on their own computer so they can
reconnect and switch between devices without re-entering them. Nothing is
transmitted off-device.

host permissions (optional_host_permissions http/https ://*/*):
Cameras/NVRs can be at any IP address on the user's network (or a remote address the
user configures), which is not known in advance, so specific hosts cannot be listed
in the manifest. Host access is declared as OPTIONAL and requested at runtime via
chrome.permissions.request() for ONLY the single host the user types in, on the
Connect click (user gesture). The extension contacts only that user-provided host
and no other server. activeTab does not apply: the extension has no content scripts
and never interacts with web-page tabs; it fetches from the device from its own
extension page.

Remote code: No. All code is bundled in the package; nothing is fetched/eval'd.

Data usage disclosures (Privacy tab):
- Does the extension collect user data? Personally identifiable info (credentials)
  is stored locally only; it is NOT collected by the developer or sent anywhere.
- Not sold to third parties. Not used for anything unrelated to the single purpose.
  Not used for creditworthiness/lending.
- Privacy policy URL: (see PUBLISHING.md — link to the hosted PRIVACY.md)

## Assets checklist
- Icon: 128×128 (icons/icon-128.png) ✅ in package
- Screenshots: 1280×800 or 640×400 PNG/JPG (at least 1, up to 5).
  Source images are in ../docs/screenshots/ — resize/pad to 1280×800 before upload
  (see PUBLISHING.md).
- Small promo tile 440×280 (optional).
