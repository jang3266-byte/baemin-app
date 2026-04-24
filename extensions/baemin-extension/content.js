// 배민커넥트 라이더 관리 페이지에서 라이더 데이터를 수집
// 페이지 DOM 구조에 따라 셀렉터를 수정해야 할 수 있음

(function() {
  let collecting = false;

  // fetch/XHR 응답 가로채기 — API에서 라이더 데이터를 직접 캡처
  const interceptedData = { riders: null, ts: null };

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('rider') || url.includes('driver') || url.includes('delivery')) {
        const clone = response.clone();
        clone.json().then(data => {
          tryParseApiResponse(data, url);
        }).catch(() => {});
      }
    } catch(e) {}
    return response;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptUrl = url;
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const url = this._interceptUrl || '';
        if (url.includes('rider') || url.includes('driver') || url.includes('delivery')) {
          const data = JSON.parse(this.responseText);
          tryParseApiResponse(data, url);
        }
      } catch(e) {}
    });
    return origXHRSend.apply(this, args);
  };

  function tryParseApiResponse(data, url) {
    // API 응답에서 라이더 배열을 찾아 파싱
    let riders = null;
    if (Array.isArray(data)) {
      riders = data;
    } else if (data?.data && Array.isArray(data.data)) {
      riders = data.data;
    } else if (data?.result && Array.isArray(data.result)) {
      riders = data.result;
    } else if (data?.riders && Array.isArray(data.riders)) {
      riders = data.riders;
    } else if (data?.content && Array.isArray(data.content)) {
      riders = data.content;
    }

    if (riders && riders.length > 0 && hasRiderFields(riders[0])) {
      interceptedData.riders = riders.map(normalizeRider);
      interceptedData.ts = Date.now();
      console.log('[배민 모니터링] API에서 라이더 데이터 캡처:', riders.length, '명');
      sendToServer(interceptedData.riders);
    }
  }

  function hasRiderFields(obj) {
    // 라이더 객체인지 판별: 이름 + 완료/거절 관련 필드가 있으면 라이더 데이터
    const nameFields = ['name', 'riderName', 'driverName', 'nickName', 'rider_name'];
    const statFields = ['completed', 'completedCount', 'deliveryCount', 'complete_count',
                        'rejected', 'rejectedCount', 'rejectCount', 'reject_count'];
    const hasName = nameFields.some(f => obj[f] !== undefined);
    const hasStat = statFields.some(f => obj[f] !== undefined);
    return hasName && hasStat;
  }

  function normalizeRider(r) {
    return {
      name: r.name || r.riderName || r.driverName || r.nickName || r.rider_name || '이름없음',
      status: parseStatus(r.status || r.riderStatus || r.state || ''),
      completed: parseInt(r.completed || r.completedCount || r.deliveryCount || r.complete_count || 0),
      rejected: parseInt(r.rejected || r.rejectedCount || r.rejectCount || r.reject_count || 0),
      dispatchCancel: parseInt(r.dispatchCancel || r.dispatchCancelCount || r.dispatch_cancel || 0),
      riderCancel: parseInt(r.riderCancel || r.riderCancelCount || r.rider_cancel || 0),
      phone: r.phone || r.phoneNumber || r.mobile || r.tel || '',
      morning: parseInt(r.morning || r.morningCount || 0),
      afternoon: parseInt(r.afternoon || r.afternoonCount || 0),
      evening: parseInt(r.evening || r.eveningCount || 0),
      midnight: parseInt(r.midnight || r.midnightCount || r.nightCount || 0)
    };
  }

  function parseStatus(s) {
    const str = String(s).toLowerCase();
    if (str.includes('운행') || str.includes('active') || str.includes('online') || str.includes('working')) return '운행중';
    if (str.includes('대기') || str.includes('idle') || str.includes('wait')) return '대기중';
    return '미운행';
  }

  // DOM 스캔 방식 (API 가로채기가 안 될 경우 대비)
  function scanDOM() {
    const riders = [];

    // 테이블 기반 스캔
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'))
        .map(el => el.textContent.trim());

      const nameIdx = headers.findIndex(h => h.includes('이름') || h.includes('라이더') || h.includes('성명'));
      if (nameIdx === -1) continue;

      const statusIdx = headers.findIndex(h => h.includes('상태') || h.includes('운행'));
      const completedIdx = headers.findIndex(h => h.includes('완료') || h.includes('배달'));
      const rejectedIdx = headers.findIndex(h => h.includes('거절'));
      const dispatchIdx = headers.findIndex(h => h.includes('배차취소') || h.includes('배차'));
      const riderCancelIdx = headers.findIndex(h => h.includes('라이더취소') || h.includes('취소'));
      const phoneIdx = headers.findIndex(h => h.includes('전화') || h.includes('연락처') || h.includes('핸드폰'));

      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length <= nameIdx) continue;
        const name = cells[nameIdx]?.textContent?.trim();
        if (!name) continue;

        riders.push({
          name,
          status: statusIdx >= 0 ? parseStatus(cells[statusIdx]?.textContent?.trim()) : '미확인',
          completed: completedIdx >= 0 ? parseInt(cells[completedIdx]?.textContent?.trim()) || 0 : 0,
          rejected: rejectedIdx >= 0 ? parseInt(cells[rejectedIdx]?.textContent?.trim()) || 0 : 0,
          dispatchCancel: dispatchIdx >= 0 ? parseInt(cells[dispatchIdx]?.textContent?.trim()) || 0 : 0,
          riderCancel: riderCancelIdx >= 0 ? parseInt(cells[riderCancelIdx]?.textContent?.trim()) || 0 : 0,
          phone: phoneIdx >= 0 ? cells[phoneIdx]?.textContent?.trim() : '',
          morning: 0,
          afternoon: 0,
          evening: 0,
          midnight: 0
        });
      }

      if (riders.length > 0) break;
    }

    // 카드/리스트 기반 스캔 (테이블이 없을 경우)
    if (riders.length === 0) {
      const cards = document.querySelectorAll('[class*="rider"], [class*="driver"], [class*="member"], [class*="card"], [class*="item"], [class*="list-row"]');
      for (const card of cards) {
        const text = card.textContent;
        const nameEl = card.querySelector('[class*="name"], [class*="title"], strong, b, h3, h4');
        if (!nameEl) continue;
        const name = nameEl.textContent.trim();
        if (!name || name.length > 20) continue;

        const nums = text.match(/\d+/g)?.map(Number) || [];
        if (nums.length < 2) continue;

        riders.push({
          name,
          status: text.includes('운행중') ? '운행중' : '미운행',
          completed: nums[0] || 0,
          rejected: nums[1] || 0,
          dispatchCancel: nums[2] || 0,
          riderCancel: nums[3] || 0,
          phone: (text.match(/01[0-9]-?\d{3,4}-?\d{4}/) || [''])[0],
          morning: 0, afternoon: 0, evening: 0, midnight: 0
        });
      }
    }

    return riders;
  }

  function sendToServer(riders) {
    if (!riders || riders.length === 0) return;
    chrome.runtime.sendMessage({
      type: 'sendRiders',
      riders: riders
    }, (response) => {
      if (response?.ok) {
        console.log('[배민 모니터링] 서버 전송 완료:', response.count, '명');
        showBadge('전송 완료: ' + response.count + '명');
      } else {
        console.warn('[배민 모니터링] 서버 전송 실패:', response?.error);
      }
    });
  }

  function collect() {
    if (collecting) return;
    collecting = true;
    try {
      // 가로챈 API 데이터가 있으면 우선 사용
      if (interceptedData.riders && interceptedData.riders.length > 0) {
        const age = Date.now() - (interceptedData.ts || 0);
        if (age < 120000) { // 2분 이내 데이터
          sendToServer(interceptedData.riders);
          collecting = false;
          return;
        }
      }
      // 없으면 DOM 스캔
      const riders = scanDOM();
      if (riders.length > 0) {
        sendToServer(riders);
      } else {
        console.log('[배민 모니터링] 라이더 데이터를 찾을 수 없습니다. 페이지를 확인해주세요.');
      }
    } finally {
      collecting = false;
    }
  }

  // 플로팅 상태 배지
  function showBadge(msg) {
    let badge = document.getElementById('__baemin_monitor_badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = '__baemin_monitor_badge';
      badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#00c4ae;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:700;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:opacity 0.3s;cursor:pointer;';
      badge.addEventListener('click', collect);
      document.body.appendChild(badge);
    }
    badge.textContent = '🛵 ' + msg;
    badge.style.opacity = '1';
    clearTimeout(badge._timer);
    badge._timer = setTimeout(() => { badge.style.opacity = '0.4'; }, 3000);
  }

  // 메시지 수신 (background에서 주기적으로 collect 요청)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'collect') {
      collect();
      sendResponse({ ok: true });
    }
  });

  // 초기 실행
  showBadge('모니터링 활성화됨');
  setTimeout(collect, 3000);
  console.log('[배민 모니터링] 익스텐션 로드 완료');
})();
