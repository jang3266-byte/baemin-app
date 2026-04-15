// 클라우드 전용 서버 (Railway)
// PC의 익스텐션이 데이터를 밀어넣고, 모바일이 언제든 읽어감

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3737;

// 메모리에 라이더 데이터 보관
let riderData = { data: [], ts: null };

// 쿠팡이츠 데이터
let coupangRiders = { riders: [], capacity: { current: 0, max: 10 }, waiting: 0, summary: {}, ts: null };
let coupangPeak   = { timeSlots: [], dailyRate: 0, peakSections: [], ts: null };
let coupangRiderDate = null; // 자정 리셋용 날짜 추적

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

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '2mb' }));

// 익스텐션 → 클라우드: 라이더 데이터 수신
app.post('/api/riders', (req, res) => {
  const { data, ts } = req.body;
  if (!data || !Array.isArray(data)) return res.status(400).json({ error: 'invalid' });
  riderData = {
    data: data.map(r => {
      const total = (r.completed || 0) + (r.rejected || 0);
      return { ...r, rejectRate: total > 0 ? parseFloat(((r.rejected / total) * 100).toFixed(1)) : 0 };
    }).sort((a, b) => b.rejectRate - a.rejectRate),
    ts: ts || Date.now()
  };
  console.log(`[${new Date().toISOString()}] riders updated: ${riderData.data.length}`);
  res.json({ ok: true, count: riderData.data.length });
});

// 모바일 → 클라우드: 라이더 데이터 조회
app.get('/api/riders', (req, res) => res.json(riderData));

// 수동 새로고침 (클라우드에선 no-op — PC 익스텐션만 수집 가능)
app.post('/api/request-refresh', (req, res) => res.json({ ok: true }));
app.get('/api/check-refresh', (req, res) => res.json({ pending: false }));

// ── 쿠팡이츠 API ─────────────────────────────────────────────────
app.post('/api/coupang/riders', (req, res) => {
  const d = req.body;
  if (!d || !Array.isArray(d.riders)) return res.status(400).json({ error: 'invalid' });
  const mergedRiders = mergeCoupangRiders(coupangRiders.riders || [], d.riders);
  coupangRiders = { ...d, riders: mergedRiders, ts: d.ts || Date.now() };
  console.log(`[쿠팡 라이더] 활성 ${d.riders.length}명 / 전체(오늘) ${mergedRiders.length}명`);
  res.json({ ok: true, count: mergedRiders.length });
});
app.get('/api/coupang/riders', (req, res) => res.json(coupangRiders));

app.post('/api/coupang/peak', (req, res) => {
  const d = req.body;
  if (!d || !Array.isArray(d.timeSlots)) return res.status(400).json({ error: 'invalid' });
  coupangPeak = { ...d, ts: d.ts || Date.now() };
  console.log(`[쿠팡 피크] 시간대 ${d.timeSlots.length}개`);
  res.json({ ok: true, count: d.timeSlots.length });
});
app.get('/api/coupang/peak', (req, res) => res.json(coupangPeak));

// 정적 파일 (HTML 대시보드)
const noCache = (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
};
app.get('/coupang',        (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'coupang.html')); });
app.get('/coupang-mobile', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'coupang-mobile.html')); });
app.get('/mobile', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'baemin-mobile.html'), 'utf8');
  // 운행중 라이더 이름 파란색 강제 적용
  const css = '.rider-card.running .rider-name { color: #3b82f6 !important; }';
  html = html.replace('</style>', css + '\n  </style>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Cloud server on port ${PORT}`));
// deploy trigger
