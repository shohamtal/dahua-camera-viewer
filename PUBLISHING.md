# Publishing to the Chrome Web Store

The actual submission has to be done by you — it needs a Google account, a **one-time
$5 developer registration fee**, and clicking through Google's dashboard. Nobody can
do that part on your behalf. Everything else (a store-ready package, icons, listing
copy, privacy policy) is already prepared in this repo. Follow the steps below.

## 1. Build the upload package (.zip)

The store wants a zip of the extension files **only** — no repo docs, screenshots,
git, or the store folder. A helper script is included:

```bash
./scripts/package.sh
# → dist/dahua-camera-viewer-<version>.zip
```

It zips: `manifest.json`, `app.html`, `app.js`, `style.css`, `background.js`,
`lib/`, and `icons/`.

## 2. Register as a Chrome Web Store developer (once)

1. Go to the **[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)**.
2. Sign in with the Google account you want to publish under.
3. Pay the **one-time $5** registration fee.
4. Fill in your developer account details (name + a contact email; the email must be
   verified).

## 3. Host the privacy policy (required)

The store requires a **public URL** for the privacy policy because the extension
handles credentials. Easiest options:

- Push this repo to GitHub (see below) and use the raw file URL, e.g.
  `https://github.com/<you>/dahua-camera-viewer/blob/main/PRIVACY.md`, **or**
- Enable GitHub Pages and link `PRIVACY.md`.

## 4. Prepare screenshots (1280×800)

The store needs at least one screenshot at **1280×800** (or 640×400). The originals
in `docs/screenshots/` aren't that exact size, so pad/resize them:

```bash
./scripts/make-store-screenshots.sh
# → store/screenshots/*.png  (1280×800, white-padded)
```

Then upload 1–5 of them.

## 5. Create the item and upload

1. Dashboard → **Add new item** → upload the `.zip` from step 1.
2. Fill the **Store listing** tab from [`store/listing.md`](store/listing.md):
   name, summary, detailed description, category, language.
3. Upload the **128×128 icon** (already in the zip, but the listing also asks for it)
   and the screenshots from step 4.
4. **Privacy practices** tab:
   - Single purpose: see `store/listing.md`.
   - Justify **`storage`** and the **host permissions** (text provided in
     `store/listing.md`).
   - Remote code: **No**.
   - Data usage: credentials are stored **locally only**, not collected/sold.
   - Paste the **privacy policy URL** from step 3.
5. Choose visibility (Public / Unlisted). **Unlisted** is handy if you only want to
   share the link with your neighbours rather than list it publicly.
6. **Submit for review.**

## 6. Review

Reviews typically take a few hours to a few business days. The broad
`host_permissions` may draw a clarification request — the justification in
`store/listing.md` (cameras can be at any IP; only the user-entered host is
contacted) is the answer. Once approved it goes live at your item URL.

## Updating later

Bump `version` in `manifest.json`, re-run `./scripts/package.sh`, and upload the new
zip to the same item → **Submit for review**.

---

### Alternative: skip the store

If you just want to use it yourself or share with a few people, you don't need the
store at all — anyone can **Load unpacked** from a copy of this repo (see the README
"Install from source"). The store is only worth it for one-click install and
auto-updates.
