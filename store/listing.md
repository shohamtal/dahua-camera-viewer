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

View your Dahua NVR, DVR, or IP cameras straight from Chrome — no NPAPI/ActiveX
plugin and no server required.

Dahua's built-in web interface still relies on the old "webplugin" that modern
browsers removed years ago, so live video no longer works there. This extension
talks to your device directly using its standard HTTP API, so everything runs in
your browser on your own network.

FEATURES
• Live grid of all channels as snapshot thumbnails — click a camera to start its
  live stream, or open it fullscreen. Nothing streams until you ask.
• Recordings with a real timeline: play in the browser, scrub, and skip forward/
  back — only the part you watch is streamed, so no giant downloads just to find a
  moment. You can also download the raw clip.
• Works with any device that supports the standard Dahua HTTP-CGI API.
• Dark / light theme.
• 100% local: your credentials and video never leave your computer and your device.
  No accounts, no cloud, no tracking, no ads.

HOW TO USE
1. Click the toolbar icon to open the viewer.
2. Enter your device's IP address, port, username, and password (the same ones you
   use in the Dahua app).
3. Connect.

Works on your home network out of the box. For remote viewing, use a VPN into your
home (recommended) or port forwarding — see the project page for a security guide.

Not affiliated with or endorsed by Dahua. Open source (MIT).

## Single purpose (dashboard field)
View live video and recordings from a user-owned Dahua-compatible camera/NVR/DVR by
connecting to it directly over the local network.

## Permission justifications (dashboard fields)

storage:
Used to optionally remember the user's device connection details (IP, port,
username, password) locally on their own computer so they don't re-enter them each
time. Nothing is transmitted off-device.

host permissions (http/https ://*/*):
Cameras/NVRs can be at any IP address on the user's network (or a remote address the
user configures), which is not known in advance. The extension must contact the
host the user types in. It only ever contacts that user-provided host and no other
server.

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
