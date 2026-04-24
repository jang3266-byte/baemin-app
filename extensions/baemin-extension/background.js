chrome.alarms.create('baemin-collect', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'baemin-collect') {
    chrome.tabs.query({ url: ['*://*.baemin.com/*', '*://*.woowahan.com/*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'collect' }).catch(() => {});
      });
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'sendRiders') {
    chrome.storage.local.get(['serverUrl'], (data) => {
      const url = data.serverUrl || 'http://localhost:3737';
      fetch(url + '/api/riders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: msg.riders, ts: Date.now() })
      })
      .then(r => r.json())
      .then(res => {
        chrome.storage.local.set({ lastSend: Date.now(), lastError: null });
        sendResponse({ ok: true, count: res.count });
      })
      .catch(err => {
        chrome.storage.local.set({ lastError: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    });
    return true;
  }

  if (msg.type === 'configUpdated') {
    chrome.storage.local.get(['interval'], (data) => {
      const mins = Math.max(0.17, (data.interval || 30) / 60);
      chrome.alarms.create('baemin-collect', { periodInMinutes: mins });
    });
  }
});
