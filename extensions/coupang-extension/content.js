// 쿠팡이츠 파트너 페이지에서 라이더 + 피크 데이터를 수집
// 페이지 DOM 구조에 따라 셀렉터를 수정해야 할 수 있음

(function() {
  let collecting = false;
  const intercepted = { riders: null, peak: null, ts: null };

  // fetch/XHR 응답 가로채기
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (shouldIntercept(url)) {
        const clone = response.clone();
        clone.json().then(data => tryParseResponse(data, url)).catch(() => {});
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
        if (shouldIntercept(url)) {
          const data = JSON.parse(this.responseText);
          tryParseResponse(data, url);
        }
      } catch(e) {}
    });
    return origXHRSend.apply(this, args);
  };

  function shouldIntercept(url) {
    const keywords = ['rider', 'driver', 'delivery', 'peak', 'slot', 'capacity', 'worker', 'staff', 'member', 'schedule'];
    return keywords.some(k => url.toLowerCase().includes(k));
  }

  function tryParseResponse(data, url) {
    // 라이더 데이터 파싱 시도
    let riderArr = findArray(data);
    if (riderArr && riderArr.length > 0 && looksLikeRider(riderArr[0])) {
      const riders = riderArr.map(normalizeRider);
      intercepted.riders = buildRiderPayload(riders, data);
      intercepted.ts = Date.now();
      console.log('[쿠팡 모니터링] 라이더 데이터 캡처:', riders.length, '명');
    }

    // 피크/슬롯 데이터 파싱 시도
    if (url.includes('peak') || url.includes('slot') || url.includes('schedule') || url.includes('time')) {
      const slots = findTimeSlots(data);
      if (slots && slots.length > 0) {
        intercepted.peak = buildPeakPayload(slots, data);
        intercepted.ts = Date.now();
        console.log('[쿠팡 모니터링] 피크 데이터 캡처:', slots.length, '구간');
      }
    }

    if (intercepted.riders || intercepted.peak) {
      sendToServer();
    }
  }

  function findArray(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    for (const key of ['riders', 'data', 'result', 'content', 'list', 'items', 'members', 'workers']) {
      if (Array.isArray(data[key])) return data[key];
    }
    return null;
  }

  function looksLikeRider(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const nameFields = ['name', 'riderName', 'driverName', 'nickName', 'workerName'];
    const statFields = ['completed', 'completedCount', 'deliveryCount', 'accepted', 'acceptedCount'];
    return nameFields.some(f => obj[f] !== undefined) && statFields.some(f => obj[f] !== undefined);
  }

  function normalizeRider(r) {
    const completed = int(r.completed || r.completedCount || r.deliveryCount || r.accepted || r.acceptedCount);
    const rejected = int(r.rejected || r.rejectedCount || r.rejectCount || r.ignored || r.ignoredCount);
    const cancelled = int(r.cancelled || r.cancelledCount || r.cancelCount);
    const total = completed + rejected;
    const rejectRate = total > 0 ? parseFloat(((rejected / total) * 100).toFixed(1)) : 0;

    return {
      name: r.name || r.riderName || r.driverName || r.nickName || r.workerName || '이름없음',
      status: parseStatus(r.status || r.riderStatus || r.state || ''),
      rank: int(r.rank || r.slot || r.slotNumber),
      phone: r.phone || r.phoneNumber || r.mobile || r.tel || '',
      completed,
      rejected,
      cancelled,
      rejectRate,
      lunchPeak: int(r.lunchPeak || r.lunchPeakCount || r.lunch),
      dinnerPeak: int(r.dinnerPeak || r.dinnerPeakCount || r.dinner),
      nonPeak: int(r.nonPeak || r.nonPeakCount || r.offPeak)
    };
  }

  function parseStatus(s) {
    const str = String(s).toLowerCase();
    if (str.includes('배달') || str.includes('delivering') || str.includes('active')) return '배달중';
    if (str.includes('대기') || str.includes('waiting') || str.includes('idle') || str.includes('online')) return '대기중';
    return '오프라인';
  }

  function int(v) { return parseInt(v) || 0; }

  function buildRiderPayload(riders, raw) {
    const online = riders.filter(r => r.status !== '오프라인').length;
    const totalCompleted = riders.reduce((s, r) => s + r.completed, 0);
    const totalRejected = riders.reduce((s, r) => s + r.rejected, 0);
    const totalCancelled = riders.reduce((s, r) => s + r.cancelled, 0);

    return {
      riders,
      capacity: {
        current: int(raw?.capacity?.current ?? raw?.currentCapacity ?? online),
        max: int(raw?.capacity?.max ?? raw?.maxCapacity ?? 10)
      },
      waiting: int(raw?.waiting ?? raw?.waitingCount ?? 0),
      peakType: raw?.peakType || '',
      peakTime: raw?.peakTime || '',
      summary: {
        online,
        completed: totalCompleted,
        rejected: totalRejected,
        cancelled: totalCancelled
      },
      ts: Date.now()
    };
  }

  function findTimeSlots(data) {
    const candidates = ['timeSlots', 'slots', 'schedule', 'times', 'data', 'result'];
    for (const key of candidates) {
      const arr = data?.[key];
      if (Array.isArray(arr) && arr.length > 0 && (arr[0].time || arr[0].slot || arr[0].hour)) {
        return arr;
      }
    }
    if (Array.isArray(data) && data.length > 0 && (data[0].time || data[0].slot || data[0].hour)) {
      return data;
    }
    return null;
  }

  function buildPeakPayload(slots, raw) {
    const timeSlots = slots.map(s => ({
      time: s.time || s.slot || s.hour || '',
      accepted: int(s.accepted || s.acceptedCount || s.completed || s.count),
      workers: int(s.workers || s.workerCount || s.riderCount || s.staff),
      isPeak: !!(s.isPeak || s.peak || s.peakType),
      rating: s.rating || s.rate || '-'
    }));

    return {
      timeSlots,
      dailyRate: parseFloat(raw?.dailyRate ?? raw?.achievementRate ?? 0),
      rejectRate: parseFloat(raw?.rejectRate ?? raw?.rejectionRate ?? 0),
      preAcceptCancel: int(raw?.preAcceptCancel ?? raw?.preCancel ?? 0),
      postAcceptCancel: int(raw?.postAcceptCancel ?? raw?.postCancel ?? 0),
      peakSections: (raw?.peakSections || raw?.sections || []).map(ps => ({
        name: ps.name || ps.label || '',
        rate: parseFloat(ps.rate || ps.achievementRate || 0),
        target: int(ps.target || ps.goal),
        completed: int(ps.completed || ps.achieved),
        remaining: int(ps.remaining || ps.left),
        inProgress: !!(ps.inProgress || ps.active || ps.current)
      })),
      ts: Date.now()
    };
  }

  // DOM 스캔 (API 가로채기 안 될 경우 대비)
  function scanDOM() {
    const riders = [];

    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'))
        .map(el => el.textContent.trim());

      const nameIdx = headers.findIndex(h => h.includes('이름') || h.includes('라이더') || h.includes('성명'));
      if (nameIdx === -1) continue;

      const statusIdx = headers.findIndex(h => h.includes('상태'));
      const completedIdx = headers.findIndex(h => h.includes('완료') || h.includes('수락'));
      const rejectedIdx = headers.findIndex(h => h.includes('거절') || h.includes('무시'));
      const cancelledIdx = headers.findIndex(h => h.includes('취소'));
      const phoneIdx = headers.findIndex(h => h.includes('전화') || h.includes('연락'));

      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length <= nameIdx) continue;
        const name = cells[nameIdx]?.textContent?.trim();
        if (!name) continue;

        const completed = completedIdx >= 0 ? int(cells[completedIdx]?.textContent?.trim()) : 0;
        const rejected = rejectedIdx >= 0 ? int(cells[rejectedIdx]?.textContent?.trim()) : 0;
        const total = completed + rejected;

        riders.push({
          name,
          status: statusIdx >= 0 ? parseStatus(cells[statusIdx]?.textContent?.trim()) : '대기중',
          rank: 0,
          phone: phoneIdx >= 0 ? cells[phoneIdx]?.textContent?.trim() : '',
          completed,
          rejected,
          cancelled: cancelledIdx >= 0 ? int(cells[cancelledIdx]?.textContent?.trim()) : 0,
          rejectRate: total > 0 ? parseFloat(((rejected / total) * 100).toFixed(1)) : 0,
          lunchPeak: 0,
          dinnerPeak: 0,
          nonPeak: 0
        });
      }

      if (riders.length > 0) break;
    }

    return riders;
  }

  function sendToServer() {
    const payload = {};
    if (intercepted.riders) payload.riders = intercepted.riders;
    if (intercepted.peak) payload.peak = intercepted.peak;
    if (!payload.riders && !payload.peak) return;

    chrome.runtime.sendMessage({
      type: 'sendCoupangData',
      ...payload
    }, (response) => {
      if (response?.ok) {
        console.log('[쿠팡 모니터링] 서버 전송 완료');
        showBadge('전송 완료');
      } else {
        console.warn('[쿠팡 모니터링] 서버 전송 실패:', response?.error);
      }
    });
  }

  function collect() {
    if (collecting) return;
    collecting = true;
    try {
      if (intercepted.riders && (Date.now() - (intercepted.ts || 0)) < 120000) {
        sendToServer();
        collecting = false;
        return;
      }
      const riders = scanDOM();
      if (riders.length > 0) {
        intercepted.riders = buildRiderPayload(riders, {});
        sendToServer();
      } else {
        console.log('[쿠팡 모니터링] 라이더 데이터를 찾을 수 없습니다.');
      }
    } finally {
      collecting = false;
    }
  }

  function showBadge(msg) {
    let badge = document.getElementById('__coupang_monitor_badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = '__coupang_monitor_badge';
      badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#C84B31;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:700;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:opacity 0.3s;cursor:pointer;';
      badge.addEventListener('click', collect);
      document.body.appendChild(badge);
    }
    badge.textContent = '🛵 ' + msg;
    badge.style.opacity = '1';
    clearTimeout(badge._timer);
    badge._timer = setTimeout(() => { badge.style.opacity = '0.4'; }, 3000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'collect') {
      collect();
      sendResponse({ ok: true });
    }
  });

  showBadge('모니터링 활성화됨');
  setTimeout(collect, 3000);
  console.log('[쿠팡 모니터링] 익스텐션 로드 완료');
})();
