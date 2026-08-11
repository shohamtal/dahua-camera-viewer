// Open the viewer in a full tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) chrome.tabs.update(existing[0].id, { active: true });
  else chrome.tabs.create({ url });
});
