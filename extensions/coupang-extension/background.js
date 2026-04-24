chrome.alarms.create('coupang-collect', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'coupang-collect') {
    chrome.tabs.query({ url: ['*://*.coupangeats.com/*', '*://*.coupang.com/*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'collect' }).catch(() => {});
      });
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'sendCoupangData') {
    chrome.storage.local.get(['serverUrl'], (data) => {
      const url = data.serverUrl || 'http://localhost:3737';
      const promises = [];

      if (msg.riders) {
        promises.push(
          fetch(url + '/api/coupang/riders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.riders)
          }).then(r => r.json())
        );
      }

      if (msg.peak) {
        promises.push(
          fetch(url + '/api/coupang/peak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.peak)
          }).then(r => r.json())
        );
      }

      Promise.all(promises)
        .then(results => {
          chrome.storage.local.set({ lastSend: Date.now(), lastError: null });
          sendResponse({ ok: true, results });
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
      chrome.alarms.create('coupang-collect', { periodInMinutes: mins });
    });
  }
});
