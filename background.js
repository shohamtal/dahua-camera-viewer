// Open the viewer in a full tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) chrome.tabs.update(existing[0].id, { active: true });
  else chrome.tabs.create({ url });
});

// First install: open the viewer. Feature updates (1.1 → 1.2, not 1.2.0 → 1.2.1):
// open the bundled "What's new" page once. Reloading an unpacked copy keeps the
// same version, so development doesn't spawn tabs.
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  else if (reason === 'update' && isFeatureUpdate(previousVersion, chrome.runtime.getManifest().version)) {
    chrome.tabs.create({ url: chrome.runtime.getURL('whats-new.html') });
  }
});

function isFeatureUpdate(prev = '0', cur = '0') {
  const [a1 = 0, b1 = 0] = prev.split('.').map(Number), [a2 = 0, b2 = 0] = cur.split('.').map(Number);
  return a2 > a1 || (a2 === a1 && b2 > b1);
}
