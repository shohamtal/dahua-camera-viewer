# Chrome Web Store — listing copy

Paste these into the Web Store developer dashboard.

## Name (from manifest.json `name`)
Dahua Camera Viewer – Live, Playback & NVR Admin

## Summary (from manifest.json `description`, ≤132 chars)
Watch Dahua NVR, DVR and IP cameras in Chrome without the old web plugin: live view, recordings, MP4 export, motion events, admin.

## Category
Productivity  (alt: Tools)

## Language
English

## Detailed description

<!-- One line per paragraph: the store keeps line breaks as typed. Plain words, no hype. -->

Watch your Dahua NVR, DVR or IP cameras in Chrome. Live view, recordings and MP4 export work without Dahua's old web plugin and without any server in between.

Source code: https://github.com/shohamtal/dahua-camera-viewer

Dahua's web interface still needs a browser plugin that Chrome dropped years ago, so live video and playback don't work there anymore. This extension uses the NVR's own HTTP API instead and connects to it directly on your network. On a computer it can replace SmartPSS for everyday viewing.

NEW IN 1.2
• Recordings: a calendar shows which days have video, and each day has a 24-hour timeline. Click anywhere on it to play from that time.
• Save up to 20 minutes as an MP4 file. The video is copied as is, so there's no quality loss.
• Faster playback (2x to 8x, or as fast as the NVR can send) and buttons to jump to the next or previous motion event.
• Fixed: on NVRs with several cameras, some cameras showed another camera's recordings, or none at all.

WHAT IT DOES
• Live view: all cameras in a grid. Click one to watch it live or open it full screen. Video only streams when you ask for it.
• Playback: pick a day, scrub the timeline, zoom in to 1 hour or 10 minutes, skip 10 seconds back or forward.
• Export clips as MP4, or download the original .dav files.
• Motion events per camera for the day. Click one to open that moment in the recordings.
• NVR admin: a security check (old firmware, UPnP port forwarding, P2P cloud, unknown admin accounts, who's logged in), accounts that can see only some cameras (useful for family or neighbours), the device log, and stream and clock settings.
• Several NVRs, for example one per building. Save them and switch from the top bar.
• Report a problem: you see the whole report before sending it, with addresses, serial numbers and names removed.
• Dark and light theme.

Works with Dahua NVRs, DVRs and IP cameras that support the Dahua HTTP API and record in H.264.

PRIVACY
Your login and your video only go between your computer and your NVR. No account, no cloud, no tracking, no ads.

HOW TO USE
1. Click the extension icon.
2. Enter the NVR's IP address, port, username and password (the same login you use in the Dahua app).
3. Click Connect.

It works on your home network as is. To watch from outside, use a VPN to your home (recommended) or port forwarding. The project page has a short security guide.

Not affiliated with Dahua. Open source, MIT license.

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
