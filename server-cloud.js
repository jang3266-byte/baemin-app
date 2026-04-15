// 클라우드 전용 서버 (Railway)
// PC의 익스텐션이 데이터를 밀어넣고, 모바일이 언제든 읽어감

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3737;

// 메모리에 라이더 데이터 보관
let riderData = { data: [], ts: null };

// 쿠팡이츠 데이터
let coupangRiders = { riders: [], capacity: { current: 0, max: 10 }, waiting: 0, summary: {}, ts: null };
let coupangPeak   = { timeSlots: [], dailyRate: 0, peakSections: [], ts: null };

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
  coupangRiders = { ...d, ts: d.ts || Date.now() };
  console.log(`[쿠팡 라이더] ${d.riders.length}명`);
  res.json({ ok: true, count: d.riders.length });
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
app.get('/mobile', (req, res) => res.sendFile(path.join(__dirname, 'baemin-mobile.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Cloud server on port ${PORT}`));
