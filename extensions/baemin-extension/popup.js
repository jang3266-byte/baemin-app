const serverUrlEl = document.getElementById('serverUrl');
const intervalEl = document.getElementById('interval');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');

chrome.storage.local.get(['serverUrl', 'interval', 'lastSend', 'lastError'], (data) => {
  serverUrlEl.value = data.serverUrl || 'http://localhost:3737';
  intervalEl.value = data.interval || 30;
  if (data.lastError) {
    statusEl.textContent = '오류: ' + data.lastError;
    statusEl.className = 'status err';
  } else if (data.lastSend) {
    const ago = Math.floor((Date.now() - data.lastSend) / 1000);
    statusEl.textContent = `마지막 전송: ${ago}초 전`;
    statusEl.className = 'status ok';
  }
});

saveBtn.addEventListener('click', () => {
  const url = serverUrlEl.value.trim().replace(/\/$/, '');
  const interval = Math.max(10, parseInt(intervalEl.value) || 30);
  if (!url) {
    statusEl.textContent = 'URL을 입력해주세요';
    statusEl.className = 'status err';
    return;
  }
  chrome.storage.local.set({ serverUrl: url, interval }, () => {
    statusEl.textContent = '저장됨! 배민 페이지에서 수집 시작됩니다.';
    statusEl.className = 'status ok';
    chrome.runtime.sendMessage({ type: 'configUpdated' });
  });
});
