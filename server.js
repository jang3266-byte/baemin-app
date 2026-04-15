const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3737;

// 저장된 쿠키
let cachedCookie = '';

// 라이더 데이터 (확장 프로그램이 /api/riders로 전송)
let riderData = { data: [], ts: null };

// 쿠팡이츠 데이터
let coupangRiders = { riders: [], capacity: { current: 0, max: 10 }, waiting: 0, summary: {}, peakType: '', peakTime: '', ts: null };
let coupangPeak = { timeSlots: [], dailyRate: 0, ts: null };
const coupangRidersFile = path.join(__dirname, 'coupang-riders.json');
const coupangPeakFile = path.join(__dirname, 'coupang-peak.json');
if (fs.existsSync(coupangPeakFile))   { try { coupangPeak = JSON.parse(fs.readFileSync(coupangPeakFile, 'utf8')); } catch(e){} }
const _todayKST = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }).slice(0, 10);
let coupangRiderDate = null; // 자정 리셋용
// 오늘 데이터면 파일에서 복원 + 날짜 세팅 (오늘 누적 이어받기)
if (fs.existsSync(coupangRidersFile)) {
  try {
    const saved = JSON.parse(fs.readFileSync(coupangRidersFile, 'utf8'));
    const savedDate = saved.ts ? new Date(saved.ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }).slice(0, 10) : null;
    if (savedDate === _todayKST()) {
      coupangRiders = saved;
      coupangRiderDate = savedDate; // 오늘 데이터 → 날짜 세팅하여 머지 이어받기
      console.log(`✅ 쿠팡 라이더 복원: ${saved.riders?.length}명 (오늘 누적)`);
    }
  } catch(e) {}
}

// 오늘 참여한 모든 라이더 누적 (슬롯 이탈한 라이더 → 오프라인으로 유지)
function mergeCoupangRiders(existing, incoming) {
  const today = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  // 날짜가 바뀐 경우에만 리셋 (null이면 처음 실행 → 리셋 안 함, 무조건 머지)
  if (coupangRiderDate !== null && coupangRiderDate !== today) {
    coupangRiderDate = today;
    return incoming.slice();
  }
  coupangRiderDate = today;
  const merged = incoming.map(r => ({ ...r }));
  const mergedNames = new Set(merged.map(r => r.name));
  (existing || []).forEach(r => {
    if (!mergedNames.has(r.name)) {
      const hadActivity = (r.completed || 0) + (r.rejected || 0) + (r.cancelled || 0) > 0;
      if (hadActivity || r.status === '오프라인') {
        merged.push({ ...r, status: '오프라인', rank: null });
        mergedNames.add(r.name);
      }
    }
  });
  return merged;
}
let refreshPending = false;
const riderDataFile = path.join(__dirname, 'rider-data.json');
if (fs.existsSync(riderDataFile)) {
  try {
    riderData = JSON.parse(fs.readFileSync(riderDataFile, 'utf8'));
    console.log(`✅ 저장된 라이더 데이터 로드: ${riderData.data.length}명`);
  } catch (e) {}
}

// Chrome CDP로 Baemin 쿠키 자동 추출
async function getBaeminCookies() {
  try {
    const res = await fetch('http://127.0.0.1:18800/json/version', { timeout: 2000 });
    const info = await res.json();
    const wsUrl = info.webSocketDebuggerUrl;

    const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
    if (!WebSocket) return cachedCookie;

    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => { ws.close(); resolve(cachedCookie); }, 3000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: ['https://deliverycenter.baemin.com'] } }));
      });
      ws.on('message', (data) => {
        clearTimeout(timeout);
        ws.close();
        try {
          const result = JSON.parse(data);
          if (result.result && result.result.cookies) {
            const cookieStr = result.result.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            if (cookieStr) cachedCookie = cookieStr;
          }
        } catch (e) {}
        resolve(cachedCookie);
      });
      ws.on('error', () => { clearTimeout(timeout); resolve(cachedCookie); });
    });
  } catch (e) {
    return cachedCookie;
  }
}

// CORS 허용 (배민센터 페이지에서 localhost로 전송 허용)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 쿠키 수동 저장 API
app.use(express.json());

// 확장 프로그램이 라이더 데이터 전송
app.post('/api/riders', (req, res) => {
  const { data, ts } = req.body;
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'invalid data' });
  }
  riderData = {
    data: data.map(r => {
      const total = (r.completed || 0) + (r.rejected || 0);
      return {
        ...r,
        rejectRate: total > 0 ? parseFloat(((r.rejected / total) * 100).toFixed(1)) : 0
      };
    }).sort((a, b) => b.rejectRate - a.rejectRate),
    ts: ts || Date.now()
  };
  fs.writeFile(riderDataFile, JSON.stringify(riderData), () => {});
  console.log(`[라이더 데이터] ${riderData.data.length}명 저장됨`);
  res.json({ ok: true, count: riderData.data.length });
});

// 라이더 데이터 조회 (모바일 대시보드 폴링용)
app.get('/api/riders', (req, res) => {
  res.json(riderData);
});

// ── 쿠팡이츠 API ─────────────────────────────────────────────────
app.post('/api/coupang/riders', (req, res) => {
  const d = req.body;
  if (!d || !Array.isArray(d.riders)) return res.status(400).json({ error: 'invalid' });
  const mergedRiders = mergeCoupangRiders(coupangRiders.riders || [], d.riders);
  coupangRiders = { ...d, riders: mergedRiders, ts: d.ts || Date.now() };
  fs.writeFile(coupangRidersFile, JSON.stringify(coupangRiders), () => {});
  console.log(`[쿠팡 라이더] 활성 ${d.riders.length}명 / 전체(오늘) ${mergedRiders.length}명`);
  res.json({ ok: true, count: mergedRiders.length });
});

app.get('/api/coupang/riders', (req, res) => res.json(coupangRiders));

app.post('/api/coupang/peak', (req, res) => {
  const d = req.body;
  if (!d || !Array.isArray(d.timeSlots)) return res.status(400).json({ error: 'invalid' });
  coupangPeak = { ...d, ts: d.ts || Date.now() };
  fs.writeFile(coupangPeakFile, JSON.stringify(coupangPeak), () => {});
  console.log(`[쿠팡 피크] 시간대 ${d.timeSlots.length}개 저장`);
  res.json({ ok: true, count: d.timeSlots.length });
});

app.get('/api/coupang/peak', (req, res) => res.json(coupangPeak));

// 쿠팡 대시보드 HTML
app.get('/coupang', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'coupang.html'));
});

app.get('/coupang-mobile', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'coupang-mobile.html'));
});

// 앱 → 서버: "지금 당장 배민 API 새로고침 해줘" 요청
app.post('/api/request-refresh', (req, res) => {
  refreshPending = true;
  console.log('[서버] 수동 새로고침 요청 받음');
  res.json({ ok: true });
});

// 익스텐션 → 서버: 새로고침 요청 있는지 확인 (1분마다 폴링)
app.get('/api/check-refresh', (req, res) => {
  const pending = refreshPending;
  if (pending) refreshPending = false;
  res.json({ pending });
});
app.post('/save-cookie', (req, res) => {
  if (req.body.cookie) {
    cachedCookie = req.body.cookie;
    fs.writeFileSync(path.join(__dirname, 'cookie.txt'), cachedCookie, 'utf8');
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'no cookie' });
  }
});

// Baemin API 프록시
app.get('/api/baemin', async (req, res) => {
  // 저장된 쿠키 파일 로드
  if (!cachedCookie) {
    const cookieFile = path.join(__dirname, 'cookie.txt');
    if (fs.existsSync(cookieFile)) {
      cachedCookie = fs.readFileSync(cookieFile, 'utf8').trim();
    }
  }

  // Chrome CDP로 쿠키 자동 추출 시도
  const cookie = await getBaeminCookies();

  const page = req.query.page || 0;
  const size = req.query.size || 100;
  const url = `https://deliverycenter.baemin.com/api/delivery/history?page=${page}&size=${size}&orderName=name&orderBy=asc&name=&userId=&phoneNumber=&riderStatus=`;

  try {
    const response = await fetch(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://deliverycenter.baemin.com/',
        'Accept': 'application/json',
      }
    });

    if (response.status === 401 || response.status === 403) {
      return res.status(401).json({ error: 'login_required', message: '배민 센터에 로그인이 필요해요' });
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PC의 로컬 IP 가져오기
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// HTML 서빙 (캐시 금지)
const noCache = (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

app.get('/', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/mobile', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'baemin-mobile.html'));
});

app.get('/raw-index', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Jarvis → Claude-code 에이전트 브릿지 (Cloudflare 터널을 통해 Jarvis가 호출)
// Jarvis의 web_fetch는 localhost 차단 → 외부 URL(터널)로만 접근 가능
const { exec } = require('child_process');
function runClaudeAgent(message, agentId, res) {
  // Escape message for shell: use temp file to avoid shell injection issues
  const fs2 = require('fs');
  const tmpFile = require('os').tmpdir() + '/claude-msg-' + Date.now() + '.txt';
  fs2.writeFileSync(tmpFile, message, 'utf8');
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, '');
  const cmd = `openclaw agent --agent "${safeAgent}" --message-file "${tmpFile}" --json`;
  // Fallback: use --message with escaped content
  const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const cmdFallback = `openclaw agent --agent "${safeAgent}" --message "${safeMsg}" --json`;
  console.log(`[claude-bridge] asking ${safeAgent}: ${message.substring(0, 80)}`);
  exec(cmdFallback, { timeout: 120000, env: { ...process.env } }, (err, stdout) => {
    fs2.unlink(tmpFile, () => {});
    if (err) {
      console.error('[claude-bridge] Error:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
    try {
      const result = JSON.parse(stdout.trim());
      const text = result?.result?.payloads?.[0]?.text || result?.summary || 'No response';
      res.json({ ok: true, text });
    } catch {
      res.json({ ok: true, text: stdout.trim() });
    }
  });
}

// GET with ?message= (percent-encoded)
app.get('/api/ask-claude', (req, res) => {
  const message = req.query.message;
  const agentId = req.query.agentId || 'claude-code';
  if (!message) return res.status(400).json({ error: 'message required' });
  runClaudeAgent(message, agentId, res);
});

// POST with JSON body {"message":"...","agentId":"claude-code"}
app.post('/api/ask-claude', (req, res) => {
  const { message, agentId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  runClaudeAgent(message, agentId || 'claude-code', res);
});

// 터널 URL 제공 API
app.get('/tunnel-url', (req, res) => {
  const urlFile = path.join('C:\\Users\\jang3\\.openclaw', 'tunnel-url.txt');
  if (fs.existsSync(urlFile)) {
    const url = fs.readFileSync(urlFile, 'utf8').trim();
    res.json({ url });
  } else {
    res.json({ url: null });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const urlFile = path.join('C:\\Users\\jang3\\.openclaw', 'tunnel-url.txt');
  let tunnelUrl = '';
  if (fs.existsSync(urlFile)) tunnelUrl = fs.readFileSync(urlFile, 'utf8').trim();

  console.log(`\n✅ 배민 거절률 앱 실행 중!`);
  console.log(`\n💻 PC: http://localhost:${PORT}`);
  console.log(`📱 폰(같은 WiFi): http://${ip}:${PORT}`);
  if (tunnelUrl) console.log(`🌐 외부(어디서든): ${tunnelUrl}`);
  console.log(`\n자동 시작: start-node.ps1 실행 시 함께 켜짐`);
});
