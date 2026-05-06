const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// .env 로더 — 비밀값(텔레그램 토큰, chat_id, ngrok URL 등) 하드코딩 방지
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, '');
    }
  } catch (e) { console.warn('[env] load fail:', e.message); }
})();
function requireEnv(k) {
  const v = process.env[k];
  if (!v) { console.error(`[env] FATAL: ${k} not set — check .env`); process.exit(1); }
  return v;
}

const app = express();
app.disable('etag');  // 모바일(iOS Safari)이 304로 옛 페이지 받는 거 방지
const PORT = 3737;

// ── WebSocket: 확장 프로그램 실시간 push (2026-04-23) ─────────────
// 새로고침 버튼 클릭 시 HTTP 폴링 대신 WebSocket으로 즉시 확장에게 신호
// 확장은 /ws-extension 에 접속 → 서버가 "scrape" 메시지 보내면 즉시 스크래핑
const wsClients = new Set(); // 연결된 확장 프로그램들
function broadcastToExtensions(payload) {
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); sent++; } catch (e) {}
    }
  }
  return sent;
}

// ── 개인 링크(토큰) 시스템 ───────────────────────────────────────
// 각 라이더에게 고유 URL-safe 토큰 발급 → /me/:token 으로 본인 현황만 조회
const tokensFile = path.join(__dirname, 'rider-tokens.json');
let riderTokens = {};    // name(normalized) -> token
let tokenToName = {};    // token -> name(normalized)

// 라이더 이름 정규화 — 같은 이름이면 같은 사람으로 취급
// "01_강형석4669", "강형석4669", "강형석" → "강형석"
// 한글 이름 + (앞 prefix 숫자_) + (뒤 4자리 등 숫자) 형식 정리
function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // 한글 이름 부분만 추출 (가장 긴 한글 시퀀스)
  const m = s.match(/[가-힣]{2,}/);
  if (m) return m[0];
  // 한글 없으면(외국인 등): prefix 숫자_ 와 suffix 숫자만 제거
  s = s.replace(/^[\d_\s]+/, '').replace(/[\d_\s]+$/, '');
  s = s.trim();
  // 숫자만 남거나 비어있으면 잘못된 이름 (슬롯번호 등) — 빈 string 반환해서 알림/저장 거절
  if (!s || /^\d+$/.test(s)) return '';
  return s;
}

// 옛 토큰 → 정규화 이름 매핑 (이미 발송된 SMS 링크 호환용)
const aliasesFile = path.join(__dirname, 'rider-token-aliases.json');

try {
  if (fs.existsSync(tokensFile)) {
    const rawTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8')) || {};
    // 마이그레이션: 같은 base name 끼리 묶고 토큰 1개로 통합
    const groups = {}; // base -> [{ raw, token }, ...]
    for (const [raw, token] of Object.entries(rawTokens)) {
      const base = normalizeName(raw);
      if (!base) continue;
      groups[base] = groups[base] || [];
      groups[base].push({ raw, token });
    }
    let merged = 0;
    for (const [base, list] of Object.entries(groups)) {
      list.sort((a, b) => a.raw.length - b.raw.length);
      const keep = list[0].token;
      riderTokens[base] = keep;
      tokenToName[keep] = base;
      // 다른 토큰도 같은 base 로 매핑(기존 라이더가 옛 토큰으로 접속해도 동작)
      for (const item of list) {
        tokenToName[item.token] = base;
        if (item.raw !== base) merged++;
      }
    }
    if (merged > 0) {
      console.log(`[tokens] 마이그레이션: ${Object.keys(rawTokens).length}개 → ${Object.keys(riderTokens).length}개 (${merged}개 별칭 통합)`);
      saveTokens();
    } else {
      console.log(`[tokens] 로드: ${Object.keys(riderTokens).length}명`);
    }
  }
  // 별도 alias 파일도 로드 (외부 스크립트 마이그레이션 후 옛 토큰 호환)
  if (fs.existsSync(aliasesFile)) {
    const aliases = JSON.parse(fs.readFileSync(aliasesFile, 'utf8')) || {};
    let added = 0;
    for (const [token, name] of Object.entries(aliases)) {
      if (!tokenToName[token]) { tokenToName[token] = name; added++; }
    }
    if (added > 0) console.log(`[tokens] 옛 토큰 ${added}개 alias 로드`);
  }
} catch(e) { console.error('[tokens] load fail:', e.message); }

function saveTokens() {
  try { fs.writeFileSync(tokensFile, JSON.stringify(riderTokens, null, 2)); } catch(e) {}
}
function ensureToken(rawName) {
  const name = normalizeName(rawName);
  if (!name) return null;
  if (!riderTokens[name]) {
    const t = crypto.randomBytes(9).toString('base64url'); // ~12자
    riderTokens[name] = t;
    tokenToName[t] = name;
    saveTokens();
  }
  return riderTokens[name];
}
const ADMIN_KEY = 'jangsj_admin_2026'; // /admin/links?key=... 접근 제한
// 개인 링크 배포용 고정 외부 URL (ngrok). 관리자 페이지를 localhost 로 열어도
// 복사되는 링크는 항상 폰에서 열리는 ngrok 주소로 찍히도록.
const PUBLIC_URL = requireEnv('PUBLIC_URL');

// ── 주간 정산서 저장소 ─────────────────────────────────────────────
// 구조: settlements/{week}/{name}.png  +  settlements/{week}/_meta.json
// week ID 예: "2026-04-3" (YYYY-MM-N주)
const settlementsDir = path.join(__dirname, 'settlements');
if (!fs.existsSync(settlementsDir)) fs.mkdirSync(settlementsDir, { recursive: true });
function listSettlementWeeks() {
  try {
    return fs.readdirSync(settlementsDir)
      .filter(d => /^\d{4}-\d{2}-\d+$/.test(d))
      .sort().reverse(); // 최신순
  } catch(e) { return []; }
}
function readSettlementMeta(week) {
  const p = path.join(settlementsDir, week, '_meta.json');
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { week, riders: {} }; }
  catch(e) { return { week, riders: {} }; }
}
function writeSettlementMeta(week, meta) {
  const dir = path.join(settlementsDir, week);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify(meta, null, 2));
}

// 수동 입력된 라이더 전화번호 (브랜치 데이터에 없는 배플/쿠플 라이더용)
// 파일: settlements/phones.json  = { "김종한": "010-xxxx-xxxx", ... }
const phonesFile = path.join(settlementsDir, 'phones.json');
function readSettlementPhones() {
  try { return fs.existsSync(phonesFile) ? JSON.parse(fs.readFileSync(phonesFile, 'utf8')) : {}; }
  catch(e) { return {}; }
}
function writeSettlementPhones(map) {
  try { fs.writeFileSync(phonesFile, JSON.stringify(map, null, 2)); } catch(e) {}
}

// ── 텔레그램 봇 구성 ──────────────────────────────────────────────
// 두 봇 병렬 운영 (2026-04-18):
//  - monitor 봇 @jang_baemin_bot: 라이더 컨텍스트 주입된 Claude + 키워드 즉답. polling 은 기존 주석 상태 존중.
//  - chat    봇 @jangsj_claude_bot: 순수 Claude 대화. 라이더 데이터/키워드 없음.
// 자동 위험 알림(sendTelegram)은 monitor 토큰으로 발송.
// 텔레그램 알림 전용 (폴링 없음 - 젠스파크 클로가 채팅 담당)
const TG_TOKEN = requireEnv('TG_ALERT_BOT_TOKEN'); // @jang_baemin_bot — 자동 알림 전용
const TG_CHAT_ID = requireEnv('TG_CHAT_ID');

async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) {
    console.error('[텔레그램] 전송 실패:', e.message);
  }
}

// ── 위험 라이더 알림 추적 (중복 방지) ────────────────────────────
// 하루 1번만 발송. 자정에 자동 리셋. 파일에 저장하여 서버 재시작에도 유지.
const dangerAlertedFile = path.join(__dirname, 'danger-alerted.json');
function todayStr() { return new Date().toISOString().slice(0, 10); }
function loadDangerAlerted() {
  try {
    const data = JSON.parse(fs.readFileSync(dangerAlertedFile, 'utf8'));
    if (data.date !== todayStr()) return { date: todayStr(), keys: new Set() }; // 날짜 바뀌면 reset
    return { date: data.date, keys: new Set(data.keys || []) };
  } catch { return { date: todayStr(), keys: new Set() }; }
}
function saveDangerAlerted(state) {
  fs.writeFile(dangerAlertedFile, JSON.stringify({ date: state.date, keys: [...state.keys] }), () => {});
}
let dangerAlerted = loadDangerAlerted();

// 1시간마다 날짜 체크 → 자정 넘으면 리셋
setInterval(() => {
  if (todayStr() !== dangerAlerted.date) {
    dangerAlerted = { date: todayStr(), keys: new Set() };
    saveDangerAlerted(dangerAlerted);
    console.log('[알림 리셋] 새 날짜:', dangerAlerted.date);
  }
}, 60 * 60 * 1000);

// 위험 알림 발송 헬퍼: 그날 처음이면 발송, 두 번째 이후는 무시
function sendDangerOnce(key, msg) {
  if (dangerAlerted.keys.has(key)) return false; // 오늘 이미 알림 보냄
  dangerAlerted.keys.add(key);
  saveDangerAlerted(dangerAlerted);
  sendTelegram(msg);
  return true;
}

// ── 텔레그램 채팅 봇 (2026-04-18 복구) ───────────────────────────
// chat 봇 @jangsj_claude_bot: 순수 Claude 대화 전용 (라이더 데이터 주입 X)
const TG_BOTS = [
  { name: 'jangsj_claude_bot', token: requireEnv('TG_CHAT_BOT_TOKEN'), mode: 'chat', polling: true },
];
const tgOffsets = new Map();

// ── 로컬 AI 백업 (Ollama) ─────────────────────────────────────
// Claude CLI 인증 실패/타임아웃 시 자동으로 이쪽으로 전환
// 설치된 모델 자동 감지 (exaone3.5 > qwen2.5-coder > gemma3 > 첫번째)
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
let OLLAMA_MODEL = 'exaone3.5:7.8b'; // 기본값
(async () => {
  try {
    const res = await fetch(OLLAMA_TAGS_URL);
    const j = await res.json();
    const names = (j.models || []).map(m => m.name);
    if (names.length === 0) { console.log('[Ollama] 설치된 모델 없음 — 백업 비활성'); return; }
    const priority = ['exaone3.5:7.8b', 'exaone3.5', 'qwen2.5-coder:7b', 'qwen2.5-coder', 'gemma3:4b', 'gemma3'];
    OLLAMA_MODEL = priority.find(p => names.some(n => n.startsWith(p))) || names[0];
    console.log(`[Ollama] 백업 AI 모델: ${OLLAMA_MODEL}`);
  } catch (e) { console.log('[Ollama] 연결 실패:', e.message); }
})();

async function askExaone(userText, history = []) {
  let historyBlock = '';
  if (history.length > 0) {
    const lines = history.map(h => {
      const role = h.role === 'user' ? '사용자' : 'AI';
      return `${role}: ${h.text}`;
    }).join('\n');
    historyBlock = `\n\n[이전 대화]\n${lines}\n`;
  }
  const prompt = `당신은 Telegram 으로 편하게 대화하는 한국어 AI 입니다. 자연스럽고 친근하게 답하세요. Telegram 은 HTML 일부(<b>, <i>)만 지원하니 마크다운(**별표**, \`백틱\`, ### 제목) 사용 금지.${historyBlock}

[이번 사용자 메시지]
${userText}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const text = (j.response || '').trim();
    if (!text) return null;
    return text.length > 3800 ? text.slice(0, 3800) + '\n… (생략)' : text;
  } catch (e) {
    clearTimeout(timer);
    console.error('[EXAONE] 호출 실패:', e.message);
    return null;
  }
}

// ── 텔레그램 대화 기억 (chat_id 별 최근 N턴 보관) ───────────────
const CHAT_HISTORY_PATH = path.join(__dirname, 'chat-history.json');
const CHAT_HISTORY_MAX_TURNS = 6; // user 3 + claude 3 = 6개 메시지 유지
function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, 'utf8'));
    }
  } catch(e) { console.warn('[history] 로드 실패:', e.message); }
  return {};
}
function saveChatHistory(h) {
  try {
    fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(h, null, 2));
  } catch(e) { console.warn('[history] 저장 실패:', e.message); }
}
function appendHistory(chatId, role, text) {
  const h = loadChatHistory();
  const key = String(chatId);
  if (!h[key]) h[key] = [];
  h[key].push({ role, text: text.slice(0, 2000), at: Date.now() });
  // 최대 N턴만 유지 (오래된 것부터 삭제)
  if (h[key].length > CHAT_HISTORY_MAX_TURNS) {
    h[key] = h[key].slice(-CHAT_HISTORY_MAX_TURNS);
  }
  saveChatHistory(h);
}
function getHistoryFor(chatId) {
  const h = loadChatHistory();
  return h[String(chatId)] || [];
}
function clearHistoryFor(chatId) {
  const h = loadChatHistory();
  delete h[String(chatId)];
  saveChatHistory(h);
}

// Claude Code OAuth client_id (공개 값)
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';

function getCredentialsPath() {
  return path.join(process.env.USERPROFILE || process.env.HOME || 'C:/Users/user', '.claude', '.credentials.json');
}

// refresh token 으로 새 access token 받기 → credentials.json 직접 업데이트
async function refreshClaudeToken() {
  try {
    const credPath = getCredentialsPath();
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const oldTok = cred.claudeAiOauth;
    if (!oldTok || !oldTok.refreshToken) {
      console.warn('[claude] refresh_token 없음 — 재로그인 필요');
      return null;
    }

    const res = await fetch(CLAUDE_OAUTH_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oldTok.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    });
    const j = await res.json();
    if (!j.access_token) {
      console.warn('[claude] refresh 실패:', JSON.stringify(j).substring(0, 200));
      return null;
    }

    // credentials.json 업데이트
    cred.claudeAiOauth = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || oldTok.refreshToken,
      expiresAt: Date.now() + (j.expires_in || 28800) * 1000,
      scopes: oldTok.scopes,
      subscriptionType: oldTok.subscriptionType,
      rateLimitTier: oldTok.rateLimitTier,
    };
    fs.writeFileSync(credPath, JSON.stringify(cred, null, 2));
    console.log(`[claude] ✅ OAuth 토큰 자동 갱신 완료 (만료: ${new Date(cred.claudeAiOauth.expiresAt).toLocaleString('ko-KR')})`);
    return j.access_token;
  } catch (e) {
    console.warn('[claude] refresh 오류:', e.message);
    return null;
  }
}

// credentials.json 에서 OAuth accessToken 읽기 (필요시 자동 refresh)
async function loadClaudeOAuthToken() {
  try {
    const credPath = getCredentialsPath();
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const tok = cred.claudeAiOauth;
    if (!tok || !tok.accessToken) return null;
    // 만료 5분 전까지 유효하면 그대로 반환
    if (tok.expiresAt && tok.expiresAt > Date.now() + 5 * 60 * 1000) {
      return tok.accessToken;
    }
    // 만료 임박/만료 → 자동 refresh
    console.log('[claude] 토큰 만료 임박 → 자동 refresh 시도');
    return await refreshClaudeToken();
  } catch (e) {
    console.warn('[claude] credentials.json 로드 실패:', e.message);
    return null;
  }
}

// long-lived token 사용 중이므로 자동 refresh 로직 불필요 (claude-token.txt 에서 읽음)

// setup-token 으로 발급받은 long-lived 토큰 (PM2 환경에서도 동작)
const LONG_LIVED_TOKEN_PATH = 'C:/Users/user/.openclaw/claude-token.txt';
function loadLongLivedToken() {
  try {
    if (fs.existsSync(LONG_LIVED_TOKEN_PATH)) {
      return fs.readFileSync(LONG_LIVED_TOKEN_PATH, 'utf8').trim();
    }
  } catch(e) {}
  return null;
}

async function askClaudeRaw(userText, history = []) {
  return new Promise((resolve) => {
    // 이전 대화 요약 (있을 경우)
    let historyBlock = '';
    if (history.length > 0) {
      const lines = history.map(h => {
        const role = h.role === 'user' ? '사용자' : 'Claude';
        return `${role}: ${h.text}`;
      }).join('\n');
      historyBlock = `\n\n[이전 대화 (오래된→최근)]\n${lines}\n`;
    }

    const prompt = `당신은 Telegram 으로 편하게 대화하는 Claude 입니다. 한국어로 자연스럽고 친근하게 답하세요. Telegram 은 HTML 일부(<b>, <i>, <code>, <pre>)만 지원하고 마크다운은 렌더링되지 않으므로 **별표**, \`백틱\` 사용 금지. 질문/대화/코드 도움 무엇이든 답해도 됩니다.${historyBlock ? ' 이전 대화 맥락을 자연스럽게 이어가세요.' : ''}${historyBlock}

[이번 사용자 메시지]
${userText}`;

    // Long-lived 토큰을 CLAUDE_CODE_OAUTH_TOKEN env 로 주입 (PM2 에서도 안정)
    // ⚠️ minimal env 사용 — process.env 그대로 spread하면 한글 cwd/path 등이 spawn resolver를 깨뜨림 (ENOENT)
    const longToken = loadLongLivedToken();
    const minimalEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: longToken || '',
      USERPROFILE: 'C:\\Users\\user',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\user',
      APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
      TEMP: 'C:\\Users\\user\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\user\\AppData\\Local\\Temp',
      SystemRoot: 'C:\\Windows',
      SYSTEMDRIVE: 'C:',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs;C:\\Users\\user\\AppData\\Roaming\\npm',
    };

    let stdout = '';
    let stderr = '';
    let child;
    // ⚠️ Claude 데스크톱 앱 샌드박스 함정 — 'C:\Users\user\AppData\Roaming\npm' 은 가상 경로.
    // watchdog로 띄운 server.js는 샌드박스 밖이라 가상 경로 못 봄. 실제 경로로 직접 호출.
    const claudeExe = 'C:\\Users\\user\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    try {
      child = spawn(claudeExe,
        ['-p', '--permission-mode', 'bypassPermissions'], {
        windowsHide: true,
        cwd: 'C:\\Users\\user',
        stdio: ['pipe', 'pipe', 'pipe'], env: minimalEnv
      });
    } catch (e) {
      console.error('[claude] spawn 동기 오류:', e.message);
      resolve({ ok: false, reason: 'spawn_error' });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch(e) {}
      resolve({ ok: false, reason: 'timeout' });
    }, 180000); // 3분 (웹검색 + 응답 생성 여유)
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      const bad = /authentication_error|Failed to authenticate|API Error:\s*\d{3}|Invalid authentication|rate_limit_error|"type"\s*:\s*"error"/i.test(text) || code !== 0;
      if (!text || bad) {
        console.error('[claude] 이상 응답. code=', code, '| stdout=', text.slice(0, 200), '| stderr=', stderr.slice(0, 200));
        const authFail = /authentication_error|Failed to authenticate|401|Invalid authentication/i.test(text);
        resolve({ ok: false, reason: authFail ? 'auth' : 'unknown', detail: text.slice(0, 200) });
        return;
      }
      resolve({ ok: true, text: text.length > 3900 ? text.slice(0, 3900) + '\n… (생략)' : text });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      console.error('[claude] spawn async 오류:', e.message);
      resolve({ ok: false, reason: 'spawn_async', detail: e.message });
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch(e) {}
  });
}

// 메인 함수: Claude 시도 → 실패 시 EXAONE 자동 전환
async function askClaude(userText, history = []) {
  const r = await askClaudeRaw(userText, history);
  if (r.ok) return r.text;

  // Claude 실패 → 로컬 Ollama 모델 시도
  const modelLabel = OLLAMA_MODEL.split(':')[0].toUpperCase();
  console.log(`[AI] Claude 실패(${r.reason}) → ${modelLabel} 전환`);
  const localText = await askExaone(userText, history);
  if (localText) {
    const note = r.reason === 'auth'
      ? `\n\n<i>(⚠ Claude 인증 만료로 로컬 ${modelLabel} 이 답변 중. PC 에서 <code>claude /login</code> 실행하면 Claude 로 복귀됩니다.)</i>`
      : `\n\n<i>(Claude 호출 실패로 로컬 ${modelLabel} 이 답변했어요)</i>`;
    return `🇰🇷 <b>[${modelLabel}]</b> ` + localText + note;
  }

  // 둘 다 실패
  if (r.reason === 'auth') {
    return '🤖 Claude 인증 만료 + 로컬 AI 도 응답 없음.\nPC 에서 <code>claude /login</code> 실행하거나 Ollama 가 켜져 있는지 확인해주세요.';
  }
  return '🤖 Claude 와 로컬 AI 둘 다 응답이 없습니다. 잠시 후 다시 시도해 주세요.';
}

async function sendTelegramTo(chatId, msg, token) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) {}
}

async function processOneBot(bot) {
  try {
    const offset = tgOffsets.get(bot.token) || 0;
    const res = await fetch(`https://api.telegram.org/bot${bot.token}/getUpdates?offset=${offset}&timeout=0`);
    const json = await res.json();
    if (!json.ok || !json.result.length) return;
    for (const update of json.result) {
      tgOffsets.set(bot.token, update.update_id + 1);
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id;
      if (String(chatId) !== String(TG_CHAT_ID)) {
        console.log(`[텔레그램:${bot.name}] 미허가 chat_id: ${chatId}`);
        continue;
      }
      console.log(`[텔레그램:${bot.name}] "${msg.text.slice(0, 60)}"`);

      // 특수 명령 처리
      const cmd = msg.text.trim().toLowerCase();
      if (cmd === '/clear' || cmd === '/초기화' || cmd === '/reset') {
        clearHistoryFor(chatId);
        await sendTelegramTo(chatId, '🧹 대화 기억 초기화 완료! 이제 새로 시작합니다.', bot.token);
        continue;
      }
      if (cmd === '/history' || cmd === '/기억') {
        const hist = getHistoryFor(chatId);
        if (!hist.length) {
          await sendTelegramTo(chatId, '📭 아직 저장된 대화가 없어요.', bot.token);
        } else {
          const lines = hist.map((h, i) => `${i+1}. <b>${h.role === 'user' ? '나' : 'Claude'}</b>: ${h.text.slice(0, 80)}${h.text.length > 80 ? '…' : ''}`).join('\n');
          await sendTelegramTo(chatId, `📜 <b>최근 대화 (${hist.length}개)</b>\n\n${lines}`, bot.token);
        }
        continue;
      }

      await sendTelegramTo(chatId, '🤔 생각중…', bot.token);
      const history = getHistoryFor(chatId);
      const reply = await askClaude(msg.text, history);
      await sendTelegramTo(chatId, reply, bot.token);

      // 대화 기록 저장 (HTML 태그 제거해서 저장)
      const cleanReply = reply.replace(/<[^>]+>/g, '').replace(/🇰🇷\s*\[[^\]]+\]\s*/, '').trim();
      appendHistory(chatId, 'user', msg.text);
      appendHistory(chatId, 'claude', cleanReply);
    }
  } catch(e) {
    console.error(`[텔레그램:${bot.name}] 폴링 오류:`, e.message);
  }
}

async function processTelegramMessages() {
  const active = TG_BOTS.filter(b => b.polling);
  if (!active.length) return;
  await Promise.all(active.map(processOneBot));
}

setInterval(processTelegramMessages, 5000);

// ── 지사(branch) 별 데이터 저장소 (2026-04-20 다지사 지원) ────────────
// 기본 지사명은 "본사". 확장이 POST 시 query ?branch=지사B 또는 body.branch 로 지정.
// 파일 경로: branches/{branch}/rider-data.json | coupang-riders.json | coupang-peak.json
const DEFAULT_BRANCH = '휘핏';
const baeminByBranch   = {};   // branch -> { data, ts }
const coupangByBranch  = {};   // branch -> { riders, capacity, waiting, summary, peakType, peakTime, ts }
const coupangPeakByBranch = {};// branch -> { timeSlots, dailyRate, ts, ... }
const coupangRiderDateByBranch = {}; // branch -> KST date string
const branchesRoot = path.join(__dirname, 'branches');
if (!fs.existsSync(branchesRoot)) fs.mkdirSync(branchesRoot, { recursive: true });

const _todayKST = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }).slice(0, 10);
// 근무일(shift-day) 경계: 매일 새벽 03:00 KST.
// 즉 "오늘 근무일" = 03:00 ~ 다음날 02:59 까지를 한 덩어리로 본다.
// 00:00~02:59 구간은 "어제 근무일" 에 속함 → 라이더별 건수·거절률이 어제 값으로 유지됨.
const _shiftDayKST = () => {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', hour12: false });
  // sv-SE 로 'YYYY-MM-DD HH:MM:SS' 포맷 → 파싱해서 -3h 당겨 shift-day 로 변환
  const [y, mo, da] = s.slice(0, 10).split('-').map(n => +n);
  const hh = +s.slice(11, 13);
  const d = new Date(Date.UTC(y, mo - 1, da, hh));
  d.setUTCHours(d.getUTCHours() - 3);
  return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
};
// 쿠팡 파트너 페이지가 자정에 0으로 리셋되는 구간 (00:00~02:59 KST).
// 이 창에서 extension 이 POST 하는 리셋 값(0)으로 서버 스냅샷을 덮어쓰지 않음 → 03:00 전까지 어제 수치 유지.
const isCoupangResetWindow = () => {
  const hh = +new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', hour12: false }).slice(11, 13);
  return hh < 3;
};
const calcRejectRate = r => {
  const total = (r.rejected||0) + (r.cancelled||0) + (r.completed||0);
  return total > 0 ? parseFloat(((r.rejected||0) + (r.cancelled||0)) / total * 100).toFixed(1) * 1 : 0;
};

// 지사명 alias: '본사'는 '휘핏'으로 통합 (구 extension 대응)
const BRANCH_ALIAS = { '본사': '휘핏' };
function normalizeBranch(b) {
  const t = String(b || '').trim();
  return BRANCH_ALIAS[t] || t || DEFAULT_BRANCH;
}
function getBranch(req) {
  const raw = (req && (req.query?.branch || (req.body && req.body.branch))) || DEFAULT_BRANCH;
  return normalizeBranch(raw);
}
function branchDir(b) {
  const d = path.join(branchesRoot, b);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function fileB(b, name) { return path.join(branchDir(b), name); }

// 단일→멀티 마이그레이션: 루트의 기존 json 파일들을 "본사" 브랜치로 이동
(function migrateSingleToMulti() {
  const legacy = [
    { root: path.join(__dirname, 'rider-data.json'),    target: fileB(DEFAULT_BRANCH, 'rider-data.json') },
    { root: path.join(__dirname, 'coupang-riders.json'), target: fileB(DEFAULT_BRANCH, 'coupang-riders.json') },
    { root: path.join(__dirname, 'coupang-peak.json'),   target: fileB(DEFAULT_BRANCH, 'coupang-peak.json') },
  ];
  for (const { root, target } of legacy) {
    if (fs.existsSync(root) && !fs.existsSync(target)) {
      try { fs.copyFileSync(root, target); console.log(`[migration] ${path.basename(root)} → ${DEFAULT_BRANCH}/`); } catch(e) {}
    }
  }
})();

// 각 브랜치 디렉토리에서 초기 로드
function loadBranch(b) {
  // baemin
  const rd = fileB(b, 'rider-data.json');
  baeminByBranch[b] = fs.existsSync(rd)
    ? (() => { try { return JSON.parse(fs.readFileSync(rd, 'utf8')); } catch(e) { return { data: [], ts: null }; } })()
    : { data: [], ts: null };
  // coupang riders (현재 "근무일(03:00~다음날 02:59)" 데이터만 복원)
  const cr = fileB(b, 'coupang-riders.json');
  let coup = { riders: [], capacity: { current: 0, max: 10 }, waiting: 0, summary: {}, peakType: '', peakTime: '', ts: null };
  if (fs.existsSync(cr)) {
    try {
      const saved = JSON.parse(fs.readFileSync(cr, 'utf8'));
      // 저장된 ts 를 shift-day 로 변환해서 현재 shift-day 와 같은지 비교
      let savedShiftDay = null;
      if (saved.ts) {
        const d = new Date(saved.ts);
        d.setTime(d.getTime() - 3 * 3600 * 1000); // -3h 당겨서 shift-day 계산
        savedShiftDay = d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
      }
      if (savedShiftDay && savedShiftDay === _shiftDayKST()) {
        saved.riders = (saved.riders || []).map(r => ({ ...r, rejectRate: calcRejectRate(r) }));
        coup = saved;
        coupangRiderDateByBranch[b] = savedShiftDay;
      }
    } catch(e) {}
  }
  coupangByBranch[b] = coup;
  // coupang peak
  const cp = fileB(b, 'coupang-peak.json');
  coupangPeakByBranch[b] = fs.existsSync(cp)
    ? (() => { try { return JSON.parse(fs.readFileSync(cp, 'utf8')); } catch(e) { return { timeSlots: [], dailyRate: 0, ts: null }; } })()
    : { timeSlots: [], dailyRate: 0, ts: null };
  console.log(`✅ [${b}] 데이터 로드: 배민 ${baeminByBranch[b].data.length}명 / 쿠팡 ${coup.riders?.length||0}명`);
}

// 지사 목록 (branches/ 폴더의 서브디렉토리) — alias 된 구 폴더명(본사 등)은 제외
function listBranches() {
  try {
    const arr = fs.readdirSync(branchesRoot)
      .filter(n => fs.statSync(path.join(branchesRoot, n)).isDirectory())
      .filter(n => !Object.prototype.hasOwnProperty.call(BRANCH_ALIAS, n)); // 구 별칭 폴더 숨김
    if (!arr.includes(DEFAULT_BRANCH)) arr.unshift(DEFAULT_BRANCH);
    return arr;
  } catch(e) { return [DEFAULT_BRANCH]; }
}
// 서버 시작 시 모든 지사 로드
for (const b of listBranches()) loadBranch(b);

// 쿠팡 페이지에 보이는 라이더만 표시 (타업체 이동한 라이더 자동 제거) — 브랜치 인식
// 근무일(shift-day) 경계는 03:00 KST 기준. 00:00~02:59 는 어제 근무일로 취급.
function mergeCoupangRiders(existing, incoming, branch) {
  const today = _shiftDayKST();
  if (coupangRiderDateByBranch[branch] && coupangRiderDateByBranch[branch] !== today) {
    coupangRiderDateByBranch[branch] = today;
    return incoming.slice();
  }
  coupangRiderDateByBranch[branch] = today;
  return incoming.slice();
}
let refreshPending = false;

// 기존 단일 변수 레퍼런스 유지용 별칭 (본사 데이터 뷰) — 레거시 코드 부분 호환
Object.defineProperty(global, 'riderData',    { get: () => baeminByBranch[DEFAULT_BRANCH], set: v => baeminByBranch[DEFAULT_BRANCH] = v, configurable: true });
Object.defineProperty(global, 'coupangRiders',{ get: () => coupangByBranch[DEFAULT_BRANCH], set: v => coupangByBranch[DEFAULT_BRANCH] = v, configurable: true });
Object.defineProperty(global, 'coupangPeak',  { get: () => coupangPeakByBranch[DEFAULT_BRANCH], set: v => coupangPeakByBranch[DEFAULT_BRANCH] = v, configurable: true });

// Baemin 인증 쿠키 캐시 — /save-cookie 로 받거나 cookie.txt 에서 로드
let cachedCookie = '';

// ── 쿠팡 partner.coupangeats.com 인증 쿠키 캐시 (휘핏/덕송 분리) ─────────────────
// chrome 확장 DOM scrape 방식 → 직접 API 호출 방식 마이그레이션용 골격.
// Akamai 차단/봇 감지 회피 위해 chrome 확장이 page 안 띄워도 background fetch 가능하도록.
const cachedCoupangCookies = { '휘핏': '', '덕송': '' };

// 휘핏 chrome (default profile) cookie 추출 — port 9221 가정
// 덕송 chrome (--user-data-dir=C:\chrome-deoksong) cookie 추출 — port 9222 가정
// chrome 시작 옵션에 --remote-debugging-port=<n> 추가 필요
async function getCoupangCookies(branch, cdpPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { timeout: 2000 });
    const info = await res.json();
    const wsUrl = info.webSocketDebuggerUrl;
    const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
    if (!WebSocket) return cachedCoupangCookies[branch];
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => { ws.close(); resolve(cachedCoupangCookies[branch]); }, 3000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies',
          params: { urls: ['https://partner.coupangeats.com'] } }));
      });
      ws.on('message', (data) => {
        clearTimeout(timeout);
        ws.close();
        try {
          const result = JSON.parse(data);
          if (result.result && result.result.cookies) {
            const cookieStr = result.result.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            if (cookieStr) cachedCoupangCookies[branch] = cookieStr;
          }
        } catch (e) {}
        resolve(cachedCoupangCookies[branch]);
      });
      ws.on('error', () => { clearTimeout(timeout); resolve(cachedCoupangCookies[branch]); });
    });
  } catch (e) {
    return cachedCoupangCookies[branch];
  }
}

// 쿠팡 partner API 직접 호출 — endpoint 확정되면 채워넣을 placeholder
// ⚠️ Akamai 봇 감지 가능성 — chrome 같은 fingerprint 흉내내기 어려움. 실패 시 chrome 확장 scrape 방식으로 fallback 필요.
// 사용자가 chrome devtools network 탭에서 캡처한 endpoint URL을 여기 채울 것:
//   - rider-performance: GET https://partner.coupangeats.com/api/v?/... (TBD)
//   - peak-dashboard:    GET https://partner.coupangeats.com/api/v?/... (TBD)
const COUPANG_CDP_PORTS = { '휘핏': 9221, '덕송': 9222 };
async function fetchCoupangDirect(branch, path) {
  const port = COUPANG_CDP_PORTS[branch];
  const cookie = await getCoupangCookies(branch, port);
  if (!cookie) throw new Error(`no cookie for ${branch} (CDP port ${port} not reachable?)`);
  const r = await fetch(`https://partner.coupangeats.com${path}`, {
    headers: {
      'cookie': cookie,
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'referer': 'https://partner.coupangeats.com/page/rider-performance',
      'x-requested-with': 'XMLHttpRequest',
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
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

// 확장 프로그램이 라이더 데이터 전송 (?branch= 또는 body.branch 지정 가능)
app.post('/api/riders', (req, res) => {
  const b = getBranch(req);
  const { data, ts } = req.body;
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'invalid data' });
  }
  const newData = {
    data: data.map(r => {
      const total = (r.completed || 0) + (r.rejected || 0);
      return {
        ...r,
        name: normalizeName(r.name) || r.name,  // 이름 뒤 숫자 등 제거 (같은 이름=같은 사람)
        rejectRate: total > 0 ? parseFloat(((r.rejected / total) * 100).toFixed(1)) : 0
      };
    }).sort((a, b) => b.rejectRate - a.rejectRate),
    ts: ts || Date.now(),
    branch: b,
  };
  baeminByBranch[b] = newData;
  fs.writeFile(fileB(b, 'rider-data.json'), JSON.stringify(newData), () => {});
  console.log(`[라이더 데이터:${b}] ${newData.data.length}명 저장됨`);
  // 신규 라이더 개인 토큰 자동 발급
  newData.data.forEach(r => ensureToken(r.name));
  // 거절률 위험 라이더 텔레그램 알림 (배민) — 하루 1회만
  newData.data.forEach(r => {
    // 이름이 빈 string 또는 숫자만 있는 경우 (슬롯번호 등 잘못된 데이터) 알림 skip
    if (!r.name || /^\d+$/.test(String(r.name).trim())) return;
    if (r.rejectRate >= 20) {
      const key = `baemin_${b}_${r.name}_${dangerAlerted.date}`;
      sendDangerOnce(key, `🚨 <b>[배민·${b}] 거절률 위험</b>\n라이더: ${r.name}\n거절률: ${r.rejectRate}%\n완료: ${r.completed}건 / 거절: ${r.rejected}건`);
    }
  });
  res.json({ ok: true, count: newData.data.length, branch: b });
});

// 라이더 데이터 조회 (모바일 대시보드 폴링용)
app.get('/api/riders', (req, res) => {
  const b = getBranch(req);
  res.json(baeminByBranch[b] || { data: [], ts: null, branch: b });
});

// ── 쿠팡이츠 API ─────────────────────────────────────────────────
app.post('/api/coupang/riders', (req, res) => {
  const b = getBranch(req);
  const d = req.body;
  if (!d || !Array.isArray(d.riders)) return res.status(400).json({ error: 'invalid' });
  // 새벽 0~3시 리셋 창: 쿠팡 페이지가 자정에 0으로 리셋됐으므로 덮어쓰지 않고 어제 스냅샷 유지
  // (단 ts 는 갱신해서 모니터링 페이지 신선도 표시가 stale 로 보이지 않게)
  if (isCoupangResetWindow() && (coupangByBranch[b]?.riders?.length || 0) > 0) {
    coupangByBranch[b].ts = d.ts || Date.now();
    return res.json({ ok: true, frozen: true, count: coupangByBranch[b].riders.length, branch: b });
  }
  // 들어오는 라이더 이름 normalize (같은 이름=같은 사람)
  d.riders = d.riders.map(r => ({ ...r, name: normalizeName(r.name) || r.name }));
  const current = coupangByBranch[b] || { riders: [] };
  const mergedRiders = mergeCoupangRiders(current.riders || [], d.riders, b)
    .map(r => ({ ...r, rejectRate: calcRejectRate(r) })); // 거절률 재계산 (거절+취소 포함)
  coupangByBranch[b] = { ...d, riders: mergedRiders, ts: d.ts || Date.now(), branch: b };
  fs.writeFile(fileB(b, 'coupang-riders.json'), JSON.stringify(coupangByBranch[b]), () => {});
  console.log(`[쿠팡 라이더:${b}] 활성 ${d.riders.length}명 / 전체(오늘) ${mergedRiders.length}명`);
  // 신규 라이더 개인 토큰 자동 발급
  mergedRiders.forEach(r => ensureToken(r.name));
  // 거절률 위험 라이더 텔레그램 알림 (쿠팡) — 하루 1회만
  mergedRiders.forEach(r => {
    // 이름이 빈 string 또는 숫자만 있는 경우 (슬롯번호 등 잘못된 데이터) 알림 skip
    if (!r.name || /^\d+$/.test(String(r.name).trim())) return;
    if (r.rejectRate >= 10) {
      const key = `coupang_${b}_${r.name}_${dangerAlerted.date}`;
      sendDangerOnce(key, `🚨 <b>[쿠팡·${b}] 거절률 위험</b>\n라이더: ${r.name}\n거절률: ${r.rejectRate}%\n완료: ${r.completed||0}건 / 거절: ${r.rejected||0}건 / 취소: ${r.cancelled||0}건`);
    }
  });
  res.json({ ok: true, count: mergedRiders.length, branch: b });
});

app.get('/api/coupang/riders', (req, res) => {
  const b = getBranch(req);
  const cr = coupangByBranch[b] || { riders: [], ts: null };
  // GET 시마다 거절률 재계산 (취소 포함 최신 공식 보장)
  const result = { ...cr, riders: (cr.riders || []).map(r => ({ ...r, rejectRate: calcRejectRate(r) })), branch: b };
  res.json(result);
});

// 모든 매장 라이더 통합 — 라이더 매장 이동 (휘핏↔덕송) 대응용
// 거절률 문자 보내기 등에서 사용. 같은 이름이면 가장 최근 ts 매장 우선.
app.get('/api/coupang/all-riders', (req, res) => {
  const all = [];
  Object.keys(coupangByBranch || {}).forEach(b => {
    const cr = coupangByBranch[b];
    if (!cr || !Array.isArray(cr.riders)) return;
    const ts = cr.ts || 0;
    cr.riders.forEach(r => {
      all.push({ ...r, rejectRate: calcRejectRate(r), _branch: b, _branchTs: ts });
    });
  });
  // 같은 이름이면 ts 최신 매장만 남김
  const byName = {};
  all.forEach(r => {
    const cur = byName[r.name];
    if (!cur || (r._branchTs > cur._branchTs)) byName[r.name] = r;
  });
  const merged = Object.values(byName);
  noCache(res);
  res.json({ riders: merged, ts: Date.now(), count: merged.length });
});

app.post('/api/coupang/peak', (req, res) => {
  const b = getBranch(req);
  const d = req.body;
  if (!d || !Array.isArray(d.timeSlots)) return res.status(400).json({ error: 'invalid' });
  // 새벽 0~3시 리셋 창: 거절률(rejectRate)/당일 건수는 어제 스냅샷 유지
  // (쿠팡 페이지가 00:00 에 리셋하므로 그대로 저장하면 어제 % 가 0 으로 바뀜)
  // ts 는 갱신해서 모니터링 페이지 신선도 표시가 stale 로 보이지 않게
  if (isCoupangResetWindow() && coupangPeakByBranch[b]?.ts) {
    coupangPeakByBranch[b].ts = d.ts || Date.now();
    return res.json({ ok: true, frozen: true, branch: b });
  }
  coupangPeakByBranch[b] = { ...d, ts: d.ts || Date.now(), branch: b };
  fs.writeFile(fileB(b, 'coupang-peak.json'), JSON.stringify(coupangPeakByBranch[b]), () => {});
  console.log(`[쿠팡 피크:${b}] 시간대 ${d.timeSlots.length}개 저장`);
  res.json({ ok: true, count: d.timeSlots.length, branch: b });
});

app.get('/api/coupang/peak', (req, res) => {
  const b = getBranch(req);
  res.json(coupangPeakByBranch[b] || { timeSlots: [], dailyRate: 0, ts: null, branch: b });
});

// 지사 목록 API (대시보드 드롭다운용)
app.get('/api/branches', (req, res) => {
  res.json({ branches: listBranches(), default: DEFAULT_BRANCH });
});

// 디버그 스냅샷 API (쿠팡 확장이 페이지 텍스트/DOM 구조를 올려주는 일회성 진단용)
app.post('/api/coupang/debug', (req, res) => {
  try {
    const b = getBranch(req);
    const payload = JSON.stringify(req.body, null, 2);
    fs.writeFileSync(fileB(b, 'debug-scrape.json'), payload);
    console.log(`[쿠팡 debug:${b}] ${payload.length} 바이트 저장`);
    res.json({ ok: true, bytes: payload.length, branch: b });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── 세션 만료 알림 (확장이 로그인 페이지 감지 시 호출) ────────────
// POST/GET /api/session-alert?branch=X&platform=baemin|coupang
// 중복 알림 방지: 같은 지사·플랫폼 조합 30분 쿨다운
const sessionAlertCooldown = new Map();
function handleSessionAlert(req, res) {
  const b = getBranch(req);
  const platform = (req.query.platform || req.body?.platform || '').toString();
  if (!['baemin','coupang'].includes(platform)) return res.status(400).json({ error: 'invalid platform' });
  const key = `${b}_${platform}`;
  const now = Date.now();
  const last = sessionAlertCooldown.get(key) || 0;
  if (now - last < 30 * 60 * 1000) { // 30분 쿨다운
    return res.json({ ok: true, throttled: true, secondsLeft: Math.round((30*60*1000 - (now - last)) / 1000) });
  }
  sessionAlertCooldown.set(key, now);
  const platLabel = platform === 'coupang' ? '쿠팡' : '배민';
  const link = platform === 'coupang' ? 'https://partner.coupangeats.com/page/rider-performance' : 'https://deliverycenter.baemin.com/';
  sendTelegram(`🚪 <b>[${platLabel}·${b}] 로그아웃 감지</b>\n\n세션이 만료됐습니다. 다시 로그인해 주세요.\n${link}`);
  console.log(`[세션 만료 알림] ${platLabel}·${b} → 텔레그램 발송`);
  res.json({ ok: true, alerted: true });
}
app.post('/api/session-alert', handleSessionAlert);
app.get('/api/session-alert',  handleSessionAlert);

// ── 개인 링크 API ────────────────────────────────────────────────
// /me/:token — 개인 현황 페이지 HTML
app.get('/me/:token', (req, res) => {
  if (!tokenToName[req.params.token]) {
    return res.status(404).send('<h1>404</h1><p>유효하지 않은 링크입니다.</p>');
  }
  noCache(res);
  res.sendFile(path.join(__dirname, 'me.html'), {
    etag: false,
    lastModified: false,
    cacheControl: false,
  });
});

// /api/me/:token — 해당 라이더 데이터만 반환 (브라우저 ETag 캐시 방지)
app.get('/api/me/:token', (req, res) => {
  const name = tokenToName[req.params.token];
  if (!name) return res.status(404).json({ error: 'not found' });

  // 배민 — 라이더가 휘핏/덕송 양쪽 모두 있을 수 있음 (한 배민 계정이 두 매장 라이더 다 보여주는 케이스).
  // 가장 fresh한 ts의 데이터 선택 (옛 stale 데이터가 fresh 데이터를 덮어쓰는 버그 방지)
  let baemin = null, baeminBranch = null, baeminTs = null;
  let bestTs = 0;
  for (const b of listBranches()) {
    const found = (baeminByBranch[b]?.data || []).find(r => r.name === name);
    if (found) {
      const ts = baeminByBranch[b]?.ts || 0;
      if (ts > bestTs) {
        baemin = found;
        baeminBranch = b;
        baeminTs = ts || null;
        bestTs = ts;
      }
    }
  }

  // 쿠팡 — 모든 지사 순회해서 라이더가 속한 각 지사 정보 수집 (본사/덕송 둘 다 있으면 둘 다 반환)
  const coupangBranches = [];
  for (const b of listBranches()) {
    const found = (coupangByBranch[b]?.riders || [])
      .map(r => ({ ...r, rejectRate: calcRejectRate(r) }))
      .find(r => r.name === name);
    if (found) {
      coupangBranches.push({
        branch: b,
        rider: found,
        ts: coupangByBranch[b]?.ts || null,
      });
    }
  }

  // 매장 전체 피크타임/시간대 합계 — 라이더 본인 페이지에서 매장 전체 진행도 표시용
  // 쿠팡: 매장별 peakSections (휘핏/덕송 둘 다) + 매장 평균 거절률
  const coupangBranchPeaks = {};
  for (const b of (Object.keys(coupangPeakByBranch || {}))) {
    const peak = coupangPeakByBranch[b];
    if (peak && Array.isArray(peak.peakSections)) {
      coupangBranchPeaks[b] = {
        peakSections: peak.peakSections,
        ts: peak.ts || null,
      };
    }
  }
  // 쿠팡 매장 평균 거절률 — 쿠팡 사이트가 직접 push 한 값(coupangPeakByBranch[b].rejectRate) 사용
  // ⚠️ 자체 계산 금지 (summary.rejected 등 부분 데이터 기반 계산은 부정확)
  // 사용자 명시 (2026-04-26): "니가 계산하지 말고 데이터를 긁어와"
  const coupangBranchSummaries = {};
  for (const b of Object.keys(coupangByBranch || {})) {
    const peak = coupangPeakByBranch[b];
    const s = coupangByBranch[b]?.summary || {};
    const authoritativeRate = peak && typeof peak.rejectRate === 'number' ? peak.rejectRate : null;
    coupangBranchSummaries[b] = {
      avgRejectRate: authoritativeRate,  // null 이면 데이터 아직 없음 → 클라가 안 보여줌
      completed: s.completed || 0,
      rejected: s.rejected || 0,
      cancelled: s.cancelled || 0,
      totalRejected: peak?.totalRejected || null,  // 사이트 합계 거절+취소
      preAcceptCancel: peak?.preAcceptCancel || null,
      postAcceptCancel: peak?.postAcceptCancel || null,
      dailyRate: peak?.dailyRate || null,           // 사이트 일일 운영률 (%)
      riderCount: (coupangByBranch[b]?.riders || []).length,
    };
  }
  // 배민: 매장 전체 라이더의 시간대별(아침점심/오후논피크/저녁피크/심야논피크) 합계 + 평균 거절률
  const baeminBranchSums = {};
  for (const b of Object.keys(baeminByBranch || {})) {
    const arr = baeminByBranch[b]?.data || [];
    if (arr.length === 0) continue;
    const sum = { morning: 0, afternoon: 0, evening: 0, midnight: 0, riderCount: arr.length, completed: 0, rejected: 0, dispatchCancel: 0 };
    arr.forEach(r => {
      sum.morning   += (r.morning   || 0);
      sum.afternoon += (r.afternoon || 0);
      sum.evening   += (r.evening   || 0);
      sum.midnight  += (r.midnight  || 0);
      sum.completed += (r.completed || 0);
      sum.rejected  += (r.rejected  || 0);
      sum.dispatchCancel += (r.dispatchCancel || 0);
    });
    const denom = sum.completed + sum.rejected + sum.dispatchCancel;
    sum.avgRejectRate = denom > 0 ? parseFloat(((sum.rejected / denom) * 100).toFixed(1)) : 0;
    baeminBranchSums[b] = { ...sum, ts: baeminByBranch[b]?.ts || null };
  }

  noCache(res);
  res.json({
    name,
    baemin,
    baeminBranch,
    baeminTs,
    baeminBranchSums,           // ← 매장 전체 시간대별 합계 + avgRejectRate
    coupangBranches,
    coupangBranchPeaks,         // ← 매장별 피크타임 진행도
    coupangBranchSummaries,     // ← 추가: 쿠팡 매장 평균 거절률
    ts: Date.now(),
  });
});

// ── 주간 정산서 API ─────────────────────────────────────────────
// 업로드: POST /admin/settlement-upload?key=...&week=YYYY-MM-N&name=홍길동&payout=860440&type=쿠플
//   Content-Type: image/png, body: raw PNG bytes
app.post('/admin/settlement-upload', express.raw({ type: 'image/png', limit: '8mb' }), (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(404).json({ error: 'not found' });
  const week = (req.query.week || '').trim();
  const name = (req.query.name || '').trim();
  if (!/^\d{4}-\d{2}-\d+$/.test(week)) return res.status(400).json({ error: 'invalid week format (YYYY-MM-N)' });
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty PNG body' });
  const payout = parseInt(req.query.payout) || 0;
  const type = (req.query.type || '').trim(); // "쿠플" or "배플"
  const dir = path.join(settlementsDir, week);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 파일명은 안전하게 (경로 분리자 제거)
  const safeName = name.replace(/[\\/:]/g, '_');
  fs.writeFileSync(path.join(dir, safeName + '.png'), req.body);
  // 메타 갱신
  const meta = readSettlementMeta(week);
  meta.riders[safeName] = { payout, type, size: req.body.length, uploadedAt: new Date().toISOString() };
  meta.updatedAt = new Date().toISOString();
  writeSettlementMeta(week, meta);
  // 토큰 없으면 발급 (나중에 라이더가 링크 접근 가능하게)
  ensureToken(safeName);
  res.json({ ok: true, week, name: safeName, size: req.body.length });
});

// 수동 전화번호 입력/삭제: POST /admin/settlement-phone?key=...&name=홍길동&phone=010-xxxx-xxxx
//                          DELETE /admin/settlement-phone?key=...&name=홍길동
app.post('/admin/settlement-phone', express.json(), (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(404).json({ error: 'not found' });
  const name  = String(req.query.name || req.body?.name || '').trim();
  const phone = String(req.query.phone || req.body?.phone || '').trim();
  if (!name)  return res.status(400).json({ error: 'name required' });
  if (!phone) return res.status(400).json({ error: 'phone required' });
  // 숫자만 추출해서 010xxxxxxxx 형식인지 느슨히 검증
  const d = phone.replace(/\D/g, '');
  if (!/^0\d{9,10}$/.test(d)) return res.status(400).json({ error: 'invalid phone (010-xxxx-xxxx 형식 필요)' });
  const map = readSettlementPhones();
  // 예쁜 포맷으로 저장
  const pretty = d.length === 11
    ? `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`
    : `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  map[name] = pretty;
  writeSettlementPhones(map);
  res.json({ ok: true, name, phone: pretty });
});
app.delete('/admin/settlement-phone', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(404).json({ error: 'not found' });
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const map = readSettlementPhones();
  delete map[name];
  writeSettlementPhones(map);
  res.json({ ok: true });
});

// 조회: GET /settlement/:token            → 최신 주차 본인 PNG
//      GET /settlement/:token/:week       → 특정 주차 본인 PNG
//      GET /settlement/:token/:week/meta  → 메타데이터 JSON (금액 등)
// 가장 구체적인 라우트 먼저 (Express 는 순서대로 매칭)
app.get('/settlement/:token/:week/meta', (req, res) => {
  const name = tokenToName[req.params.token];
  if (!name) return res.status(404).json({ error: 'not found' });
  const meta = readSettlementMeta(req.params.week);
  const r = meta.riders?.[name];
  if (!r) return res.status(404).json({ error: 'no settlement for this rider in that week' });
  noCache(res);
  res.json({ name, week: req.params.week, ...r });
});
function sendSettlementPng(req, res, week) {
  const name = tokenToName[req.params.token];
  if (!name) return res.status(404).send('<h1>404</h1><p>유효하지 않은 링크입니다.</p>');
  if (!week) return res.status(404).send('<h1>정산서 없음</h1><p>아직 업로드된 주차가 없습니다.</p>');
  // 1차: 정규화 이름 PNG 직접 매칭 (예: "박상명.png")
  let p = path.join(settlementsDir, week, name + '.png');
  // ★ 2026-04-30: 2차 fallback — 풀네임 PNG 자동 매칭
  //   쿠플 단독 라이더는 풀네임(예: "강형석4669.png")으로만 업로드돼서 정규화이름 매칭 안 됨.
  //   파일 시스템에서 풀네임의 숫자/공백 제거 결과가 토큰 정규화 이름과 같은 PNG 검색.
  if (!fs.existsSync(p)) {
    try {
      const wkDir = path.join(settlementsDir, week);
      const files = fs.readdirSync(wkDir).filter(f => /\.png$/i.test(f));
      const match = files.find(f => f.replace(/\.png$/i, '').replace(/[0-9\s]/g, '').trim() === name);
      if (match) p = path.join(wkDir, match);
    } catch (e) {}
  }
  if (!fs.existsSync(p)) return res.status(404).send(`<h1>정산서 없음</h1><p>${name}님의 ${week} 정산서가 없습니다.</p>`);
  noCache(res);
  res.sendFile(p);
}
app.get('/settlement/:token/:week', (req, res) => sendSettlementPng(req, res, req.params.week));
app.get('/settlement/:token',       (req, res) => sendSettlementPng(req, res, listSettlementWeeks()[0]));

// 관리자: 주차 목록 + 메타
app.get('/admin/settlement-weeks', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(404).json({ error: 'not found' });
  const weeks = listSettlementWeeks().map(w => ({ week: w, ...readSettlementMeta(w) }));
  noCache(res);
  res.json(weeks);
});

// SMS 형식 진단 페이지 — 갤럭시에서 어떤 sms: URL 형식이 동작하는지 빠르게 테스트
app.get('/sms-test', (req, res) => {
  const phone = (req.query.phone || '01063544669').replace(/\D/g, '');
  const body  = req.query.body || '테스트 메시지입니다 (한글 포함)';
  const intl  = phone.startsWith('010') ? '+82' + phone.slice(1) : phone;
  const enc   = encodeURIComponent(body);
  const variants = [
    { label: 'sms:폰번호?body=...',           href: `sms:${phone}?body=${enc}` },
    { label: 'smsto:폰번호?body=...',         href: `smsto:${phone}?body=${enc}` },
    { label: 'sms:+82형식?body=...',          href: `sms:${intl}?body=${enc}` },
    { label: 'smsto:+82형식?body=...',        href: `smsto:${intl}?body=${enc}` },
    { label: 'sms:폰번호&body=... (iOS형식)', href: `sms:${phone}&body=${enc}` },
    { label: 'sms:폰번호 (본문 없음)',         href: `sms:${phone}` },
    { label: 'smsto:폰번호 (본문 없음)',       href: `smsto:${phone}` },
    { label: 'tel:폰번호 (전화 — sms 비교용)', href: `tel:${phone}` },
  ];
  noCache(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS 형식 테스트</title>
<style>
  body{font-family:-apple-system,sans-serif;padding:20px;background:#f5f5f5}
  h1{font-size:16px}
  .meta{font-size:12px;color:#666;margin-bottom:14px}
  a.btn{display:block;padding:14px;background:#16a34a;color:#fff;border-radius:8px;margin-bottom:10px;text-decoration:none;font-size:13px;font-weight:700}
  a.btn:active{background:#15803d}
  a.btn .url{display:block;font-size:10px;font-weight:400;font-family:monospace;color:#dcfce7;margin-top:4px;word-break:break-all}
  form{background:#fff;padding:12px;border-radius:8px;margin-bottom:14px}
  input{width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-bottom:8px;box-sizing:border-box}
  button{padding:8px 14px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:13px;font-weight:700}
</style></head><body>
<h1>📱 SMS URL 형식 테스트</h1>
<div class="meta">8가지 형식 중 어떤 게 갤럭시에서 그 사람 폰번호 자동입력 + 본문 자동입력으로 열리는지 하나씩 눌러서 확인하세요. 동작하는 형식 알려주시면 그걸로 메인 발송앱 적용합니다.</div>
<form method="get" action="/sms-test">
  <input type="tel" name="phone" placeholder="테스트 폰번호 (예: 01012345678)" value="${phone}">
  <input type="text" name="body" placeholder="테스트 본문" value="${body}">
  <button type="submit">📋 다시 생성</button>
</form>
${variants.map((v,i) => `
  <a class="btn" href="${v.href}">${i+1}. ${v.label}<span class="url">${v.href}</span></a>
`).join('')}
</body></html>`);
});

// 관리자 페이지: 주차 선택 + 라이더별 Web Share 전송 버튼
app.get('/admin/settlement', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(404).send('Not found');
  const weeks = listSettlementWeeks();
  const selectedWeek = (req.query.week || weeks[0] || '').trim();
  const meta = selectedWeek ? readSettlementMeta(selectedWeek) : { week: '', riders: {} };
  // 라이더별 phone 룩업 — **모든 브랜치 통합 + 레거시 루트 JSON** + 수동 저장 fallback
  const allBaemin = [], allCoupang = [];
  for (const b of Object.keys(baeminByBranch))  allBaemin.push(...(baeminByBranch[b].data || []));
  for (const b of Object.keys(coupangByBranch)) allCoupang.push(...(coupangByBranch[b].riders || []));
  // 레거시 루트 파일 (과거 라이더 복구용 — 지금은 안 뛰지만 전화번호 남아있을 수 있음)
  try {
    const legacyB = path.join(__dirname, 'rider-data.json');
    if (fs.existsSync(legacyB)) {
      const j = JSON.parse(fs.readFileSync(legacyB, 'utf8'));
      allBaemin.push(...(j.data || []));
    }
  } catch(e) {}
  try {
    const legacyC = path.join(__dirname, 'coupang-riders.json');
    if (fs.existsSync(legacyC)) {
      const j = JSON.parse(fs.readFileSync(legacyC, 'utf8'));
      allCoupang.push(...(j.riders || []));
    }
  } catch(e) {}
  // 같은 이름이 여러 소스에 있을 때, phone 이 있는 것을 우선 (나중 push 가 우선하도록 뒤쪽에 더해진 것도 유지)
  const baeminMap  = new Map();
  for (const r of allBaemin)  if (r?.name) { const ex = baeminMap.get(r.name);  if (!ex || (!ex.phone && r.phone)) baeminMap.set(r.name, r); }
  const coupangMap = new Map();
  for (const r of allCoupang) if (r?.name) { const ex = coupangMap.get(r.name); if (!ex || (!ex.phone && r.phone)) coupangMap.set(r.name, r); }
  const manualPhones = readSettlementPhones();
  const riderRows = Object.keys(meta.riders || {}).sort().map(name => {
    const info = meta.riders[name];
    // 이름 뒤 4자리 라이선스 ID 떼고도 매칭 (쿠플은 "강형석4669" 형식, 원본은 "강형석")
    const baseName = name.replace(/\d{4}$/, '');
    const cleanName = baseName;  // SMS 본문 표시용 (숫자 떼낸 이름)
    const rawPhone = manualPhones[name]
      || manualPhones[baseName]
      || (baeminMap.get(name)?.phone)
      || (coupangMap.get(name)?.phone)
      || (baeminMap.get(baseName)?.phone)
      || (coupangMap.get(baseName)?.phone)
      || '';
    const phone = rawPhone.replace(/\D/g, '');
    // 국제 형식: 010xxxxxxxx → +8210xxxxxxxx (안드로이드 메시지 앱이 더 안정적으로 인식)
    const phoneIntl = phone.startsWith('010') ? '+82' + phone.slice(1) : phone;
    const phoneDisplay = rawPhone || '-';
    const imgUrl = `${PUBLIC_URL}/settlement/${ensureToken(name)}/${selectedWeek}`;
    // SMS 본문 — 원래 다행 포맷
    const weekLabel = selectedWeek.replace(/^(\d{4})-(\d{2})-(\d+)$/, '$1년 $2월 $3주차');
    const payoutText = info.payout ? `\n실지급액: ${Number(info.payout).toLocaleString()}원` : '';
    const smsBody = `${cleanName}님 ${weekLabel} ${info.type || ''} 정산서입니다.${payoutText}\n\n정산서 보기:\n${imgUrl}\n\n확인 후 문의사항 있으시면 연락 주세요.`;
    // smsto:+82xxxxxxxxxx 형식 — 안드로이드 메시지 앱이 가장 안정적으로 수신자 자동입력
    const smsHref = phone
      ? `smsto:${phoneIntl}?body=${encodeURIComponent(smsBody)}`
      : `smsto:?body=${encodeURIComponent(smsBody)}`;
    return { name, cleanName, phone, phoneDisplay, payout: info.payout, type: info.type, imgUrl, smsHref, smsBody };
  });

  // 라이더 데이터를 JSON으로 클라이언트에 한 번 넘겨서 JS에서 필터·정렬
  const ridersJson = JSON.stringify(riderRows.map(r => ({
    n: r.name,           // 원본 (toekn 매칭용)
    cn: r.cleanName,     // 표시용 이름
    ph: r.phone,
    phD: r.phoneDisplay,
    p: r.payout || 0,
    t: r.type || '',
    img: r.imgUrl,
    sms: r.smsHref,
    body: r.smsBody,
  })));
  const weekLabel = selectedWeek.replace(/^(\d{4})-(\d{2})-(\d+)$/, '$1년 $2월 $3주차');

  noCache(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>📤 정산서 전송 (${selectedWeek})</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', sans-serif; background: #f1f5f9; color: #0f172a; padding-bottom: 120px; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; color: #e2e8f0; }
    .card { background: #1e293b !important; box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important; }
    .sub { color: #94a3b8 !important; }
    .top { background: rgba(15,23,42,0.95) !important; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
    input, select { background: #1e293b !important; color: #e2e8f0 !important; border-color: #334155 !important; }
    .chip { background: #1e293b !important; color: #94a3b8 !important; border-color: #334155 !important; }
    .chip.active { background: #0ea5e9 !important; color: #fff !important; border-color: #0ea5e9 !important; }
  }

  /* 스티키 상단 */
  .top { position: sticky; top: 0; z-index: 50; background: rgba(255,255,255,0.95); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(0,0,0,0.06); padding: 12px 14px 10px; padding-top: calc(12px + env(safe-area-inset-top, 0)); }
  .title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .title h1 { font-size: 17px; margin: 0; font-weight: 800; }
  .title .week-badge { font-size: 11px; font-weight: 700; color: #fff; background: #0ea5e9; padding: 3px 8px; border-radius: 100px; }

  .progress-bar { position: relative; height: 8px; background: #e2e8f0; border-radius: 100px; overflow: hidden; margin-bottom: 8px; }
  @media (prefers-color-scheme: dark) { .progress-bar { background: #334155; } }
  .progress-fill { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #10b981, #06b6d4); transition: width 0.4s ease; border-radius: 100px; width: 0%; }
  .progress-text { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; margin-bottom: 8px; }
  .progress-text b { color: #059669; font-weight: 800; }

  /* 주차 + 리셋 줄 */
  .toolbar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  select { padding: 6px 8px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; background: #fff; font-weight: 600; }
  .reset-btn { margin-left: auto; background: #ef4444; color: #fff; border: 0; padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; }

  /* 검색 */
  .search-row { display: flex; gap: 6px; margin-bottom: 8px; }
  .search-input { flex: 1; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; background: #fff; }
  .search-input:focus { outline: none; border-color: #0ea5e9; }
  .sort-select { padding: 10px 8px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 13px; background: #fff; font-weight: 600; }

  /* 필터 칩 */
  .chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; margin: 0 -14px; padding-left: 14px; padding-right: 14px; scrollbar-width: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { flex-shrink: 0; padding: 6px 12px; border-radius: 100px; background: #fff; border: 1px solid #cbd5e1; font-size: 12px; font-weight: 700; color: #475569; cursor: pointer; white-space: nowrap; }
  .chip.active { background: #0f172a; color: #fff; border-color: #0f172a; }
  .chip .badge { display: inline-block; margin-left: 4px; background: rgba(255,255,255,0.25); padding: 1px 6px; border-radius: 100px; font-size: 10px; }
  .chip:not(.active) .badge { background: #e2e8f0; color: #475569; }

  /* 카드 리스트 */
  #list { padding: 12px 14px 40px; display: flex; flex-direction: column; gap: 8px; }
  .card { background: #fff; border-radius: 14px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; transition: opacity 0.2s, transform 0.1s; }
  .card.sent { opacity: 0.55; }
  .card.sent .info .name { text-decoration: line-through; }
  .card .info { min-width: 0; }
  .card .name { font-size: 16px; font-weight: 800; margin-bottom: 3px; display: flex; align-items: center; gap: 6px; }
  .type-badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 100px; }
  .type-배플 { background: #fef3c7; color: #92400e; }
  .type-쿠플 { background: #dbeafe; color: #1e40af; }
  .sub { font-size: 12px; color: #64748b; }
  .sub a { color: #0ea5e9; text-decoration: none; font-weight: 600; }
  .payout { font-size: 14px; color: #059669; font-weight: 800; margin-top: 2px; }
  .no-phone { color: #ef4444; font-weight: 700; }

  /* 버튼 그룹 */
  .actions { display: flex; flex-direction: column; gap: 5px; }
  .act { padding: 9px 12px; border-radius: 10px; font-size: 13px; font-weight: 800; text-decoration: none; text-align: center; display: block; border: 0; cursor: pointer; white-space: nowrap; min-width: 92px; }
  .act:active { transform: scale(0.96); }
  .act.view { background: #3b82f6; color: #fff; }
  .act.img  { background: #a855f7; color: #fff; }
  .act.sms  { background: #10b981; color: #fff; }
  .act.nophone { background: #f59e0b; color: #fff; }
  .act.sent-done { background: #94a3b8; color: #fff; font-size: 10px; padding: 8px 10px; }

  /* 빈 상태 */
  .empty { padding: 60px 20px; text-align: center; color: #94a3b8; }
  .empty .ico { font-size: 48px; opacity: 0.5; margin-bottom: 12px; }

  /* FAB: 맨 위로 */
  .fab { position: fixed; bottom: 24px; right: 20px; width: 48px; height: 48px; border-radius: 50%; background: #0f172a; color: #fff; border: 0; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); z-index: 100; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
  .fab.show { opacity: 1; pointer-events: auto; }

  /* 토스트 */
  .toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%) translateY(20px); background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 100px; font-size: 13px; font-weight: 700; box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; pointer-events: none; transition: all 0.3s; z-index: 100; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head><body>

<div class="top">
  <div class="title">
    <h1>📤 주간 정산서 전송</h1>
    ${selectedWeek ? `<span class="week-badge">${weekLabel}</span>` : ''}
  </div>

  <div class="progress-text">
    <span><b id="sent-count">0</b> / ${riderRows.length} 명 발송 완료</span>
    <span id="remain-count" style="color:#ef4444;font-weight:700"></span>
  </div>
  <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>

  <form class="toolbar" method="get" action="/admin/settlement">
    <input type="hidden" name="key" value="${ADMIN_KEY}">
    <select name="week" onchange="this.form.submit()">
      ${weeks.length === 0 ? '<option value="">(없음)</option>' : ''}
      ${weeks.map(w => `<option value="${w}" ${w === selectedWeek ? 'selected' : ''}>${w}</option>`).join('')}
    </select>
    <button type="button" class="reset-btn" onclick="resetAllSent()">↺ 초기화</button>
  </form>

  <div class="search-row">
    <input type="search" id="search" class="search-input" placeholder="🔍 이름 검색" autocomplete="off" inputmode="search">
    <select class="sort-select" id="sort">
      <option value="name">이름↑</option>
      <option value="payout-desc">금액↓</option>
      <option value="payout-asc">금액↑</option>
      <option value="unsent-first">미발송먼저</option>
    </select>
  </div>

  <div class="chips" id="chips">
    <div class="chip active" data-filter="all">전체 <span class="badge" id="cnt-all">0</span></div>
    <div class="chip" data-filter="unsent">미발송 <span class="badge" id="cnt-unsent">0</span></div>
    <div class="chip" data-filter="sent">발송완료 <span class="badge" id="cnt-sent">0</span></div>
    <div class="chip" data-filter="쿠플">쿠플 <span class="badge" id="cnt-쿠플">0</span></div>
    <div class="chip" data-filter="배플">배플 <span class="badge" id="cnt-배플">0</span></div>
    <div class="chip" data-filter="nophone">📵 번호없음 <span class="badge" id="cnt-nophone">0</span></div>
  </div>
</div>

<div id="list"></div>

${riderRows.length === 0 ? `<div class="empty"><div class="ico">📭</div>${weeks.length === 0 ? '업로드된 정산서가 없습니다.<br>터미널에서 <code>node upload-settlements.js</code> 실행하세요.' : '이 주차에 라이더가 없습니다.'}</div>` : ''}

<button class="fab" id="fab" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>
<div class="toast" id="toast"></div>

<script>
const WEEK = ${JSON.stringify(selectedWeek)};
const RIDERS = ${ridersJson};
const ADMIN_KEY = ${JSON.stringify(ADMIN_KEY)};
const SENT_KEY = 'settlement_sent_v1';

// ── localStorage 발송 상태 ──────────────────────────────────
function loadSent() { try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch(e) { return {}; } }
function saveSent(m) { try { localStorage.setItem(SENT_KEY, JSON.stringify(m)); } catch(e) {} }
function sentKey(r) { return WEEK + '_' + r.n; }
function isSent(r) { return !!loadSent()[sentKey(r)]; }
function markSent(r) { const m = loadSent(); m[sentKey(r)] = new Date().toISOString(); saveSent(m); }
function unmarkSent(r) { const m = loadSent(); delete m[sentKey(r)]; saveSent(m); }

// ── 렌더 ────────────────────────────────────────────────────
let currentFilter = 'all';
let currentSort = 'name';
let currentSearch = '';

function filterRiders() {
  const sent = loadSent();
  return RIDERS.filter(r => {
    const s = !!sent[sentKey(r)];
    if (currentFilter === 'sent' && !s) return false;
    if (currentFilter === 'unsent' && s) return false;
    if (currentFilter === '쿠플' && r.t !== '쿠플') return false;
    if (currentFilter === '배플' && r.t !== '배플') return false;
    if (currentFilter === 'nophone' && r.ph) return false;
    if (currentSearch && !r.cn.toLowerCase().includes(currentSearch.toLowerCase())) return false;
    return true;
  }).sort((a, b) => {
    if (currentSort === 'name') return a.cn.localeCompare(b.cn, 'ko');
    if (currentSort === 'payout-desc') return b.p - a.p;
    if (currentSort === 'payout-asc') return a.p - b.p;
    if (currentSort === 'unsent-first') {
      const sa = !!sent[sentKey(a)], sb = !!sent[sentKey(b)];
      if (sa !== sb) return sa ? 1 : -1;
      return a.cn.localeCompare(b.cn, 'ko');
    }
    return 0;
  });
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderList() {
  const sent = loadSent();
  const rows = filterRiders();
  const list = document.getElementById('list');
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty"><div class="ico">🔎</div>조건에 맞는 라이더 없음</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const s = !!sent[sentKey(r)];
    const sentTime = s ? new Date(sent[sentKey(r)]).toLocaleString('ko-KR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
    const typeBadge = r.t ? '<span class="type-badge type-'+r.t+'">'+r.t+'</span>' : '';
    const phoneHtml = r.ph
      ? '<a href="tel:'+r.ph+'" onclick="event.stopPropagation();copyPhone(\\''+r.ph+'\\');return false" title="탭하면 번호 복사">'+r.phD+'</a>'
      : '<span class="no-phone">📵 번호 없음</span>';

    let sendBtn;
    if (s) {
      sendBtn = '<button class="act sent-done" onclick="undoSent(\\''+esc(r.n)+'\\')" title="길게 눌러 취소">✓ 보냈음<br>'+sentTime+'</button>';
    } else if (r.ph) {
      sendBtn = '<a class="act sms" href="'+r.sms+'" onclick="onSmsClick(\\''+esc(r.n)+'\\')">💬 문자</a>';
    } else {
      sendBtn = '<button class="act nophone" onclick="askAndSend(\\''+esc(r.n)+'\\')">⚠️ 번호입력</button>';
    }

    return '<div class="card'+(s?' sent':'')+'" id="card-'+esc(r.n)+'">'
      + '<div class="info">'
        + '<div class="name">'+esc(r.cn)+typeBadge+'</div>'
        + '<div class="sub">📞 '+phoneHtml+'</div>'
        + (r.p ? '<div class="payout">'+r.p.toLocaleString()+'원</div>' : '')
      + '</div>'
      + '<div class="actions">'
        + '<a class="act view" href="'+r.img+'" target="_blank">👁️ 보기</a>'
        + '<button class="act img" onclick="shareImg(\\''+esc(r.n)+'\\')">📷 이미지</button>'
        + sendBtn
      + '</div>'
    + '</div>';
  }).join('');
}

function updateCounts() {
  const sent = loadSent();
  const total = RIDERS.length;
  const sentN = RIDERS.filter(r => sent[sentKey(r)]).length;
  document.getElementById('sent-count').textContent = sentN;
  document.getElementById('remain-count').textContent = sentN === total ? '🎉 전부 발송 완료!' : ('남은 ' + (total - sentN) + '명');
  document.getElementById('progress-fill').style.width = total ? (sentN/total*100)+'%' : '0%';

  // 칩 카운트
  const cnt = {
    all: total,
    unsent: RIDERS.filter(r => !sent[sentKey(r)]).length,
    sent: sentN,
    '쿠플': RIDERS.filter(r => r.t === '쿠플').length,
    '배플': RIDERS.filter(r => r.t === '배플').length,
    nophone: RIDERS.filter(r => !r.ph).length,
  };
  Object.keys(cnt).forEach(k => { const el = document.getElementById('cnt-'+k); if (el) el.textContent = cnt[k]; });
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._to);
  toast._to = setTimeout(() => t.classList.remove('show'), 2000);
}

function findRider(n) { return RIDERS.find(r => r.n === n); }

function onSmsClick(n) {
  const r = findRider(n); if (!r) return;
  try { navigator.clipboard && navigator.clipboard.writeText(r.body); } catch(e) {}
  markSent(r);
  setTimeout(() => { renderList(); updateCounts(); }, 100);
}

function undoSent(n) {
  const r = findRider(n); if (!r) return;
  if (!confirm(r.cn + ' 발송 표시를 취소할까요?')) return;
  unmarkSent(r);
  renderList(); updateCounts();
  toast('↺ ' + r.cn + ' 취소됨');
}

async function askAndSend(n) {
  const r = findRider(n); if (!r) return;
  const ask = prompt(r.cn + ' 폰번호 입력 (예: 01012345678)\\n\\n※ 한 번 입력하면 앱에 즉시 반영되고 서버에도 영구 저장되어 다음 주부터 자동 인식됩니다.', '');
  if (!ask) return;
  const phone = ask.replace(/\\D/g, '');
  if (!/^\\d{10,11}$/.test(phone)) { alert('폰번호 형식 오류'); return; }
  const intl = phone.startsWith('010') ? '+82' + phone.slice(1) : phone;
  const pretty = phone.length === 11
    ? phone.slice(0,3)+'-'+phone.slice(3,7)+'-'+phone.slice(7)
    : phone.slice(0,3)+'-'+phone.slice(3,6)+'-'+phone.slice(6);
  // ★ 앱 메모리(RIDERS 배열)에 즉시 반영 — 새로고침 없이 카드가 "번호없음" → 정상 전송으로 바뀜
  r.ph  = phone;
  r.phD = pretty;
  r.sms = 'smsto:' + intl + '?body=' + encodeURIComponent(r.body);
  // 서버에 영구 저장 (다음 주차부터 자동 인식)
  let saved = false;
  try {
    const qs = new URLSearchParams({ key: ADMIN_KEY, name: r.n, phone });
    const resp = await fetch('/admin/settlement-phone?' + qs.toString(), { method: 'POST' });
    saved = resp.ok;
  } catch(e) {}
  toast(saved ? '📞 ' + r.cn + ' 저장됨 (' + pretty + ')' : '⚠️ 서버 저장 실패 (앱에는 반영)');
  try { navigator.clipboard && navigator.clipboard.writeText(r.body); } catch(e) {}
  markSent(r);
  // UI 리렌더 — 이 라이더 카드가 이제 일반 💬 문자 버튼으로 바뀌고, "번호없음" 칩 카운트도 감소
  renderList(); updateCounts();
  // 문자앱 열기
  setTimeout(() => { window.location.href = r.sms; }, 150);
}

async function shareImg(n) {
  const r = findRider(n); if (!r) return;
  try {
    const blob = await fetch(r.img).then(x => { if(!x.ok) throw new Error('PNG 로드 실패'); return x.blob(); });
    const file = new File([blob], r.cn + '_정산서.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: r.cn + '님 정산서', text: r.body });
      markSent(r);
      renderList(); updateCounts();
      toast('📷 ' + r.cn + ' 공유됨');
    } else {
      try { await navigator.clipboard.writeText(r.body); } catch(e) {}
      window.open(r.img, '_blank');
      toast('PC는 새 탭으로 열었음');
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast('❌ ' + e.message);
  }
}

function copyPhone(p) {
  try { navigator.clipboard.writeText(p); toast('📋 ' + p + ' 복사됨'); } catch(e) {}
}

function resetAllSent() {
  if (!confirm('이 주차의 모든 발송 표시를 초기화할까요?')) return;
  const m = loadSent();
  RIDERS.forEach(r => delete m[sentKey(r)]);
  saveSent(m);
  renderList(); updateCounts();
  toast('↺ 모두 초기화됨');
}

// ── 이벤트 바인딩 ────────────────────────────────────────────
document.getElementById('search').addEventListener('input', e => {
  currentSearch = e.target.value.trim();
  renderList();
});
document.getElementById('sort').addEventListener('change', e => {
  currentSort = e.target.value;
  renderList();
});
document.getElementById('chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  currentFilter = chip.getAttribute('data-filter');
  renderList();
});

// FAB 스크롤 표시
window.addEventListener('scroll', () => {
  document.getElementById('fab').classList.toggle('show', window.scrollY > 400);
}, { passive: true });

// 초기 렌더
renderList();
updateCounts();
</script>

<script>
// ── 보낸 라이더 표시 (브라우저 localStorage 에 저장) ─────────────────
const SENT_KEY = 'settlement_sent_v1';
function loadSent() {
  try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch(e) { return {}; }
}
function saveSent(map) {
  try { localStorage.setItem(SENT_KEY, JSON.stringify(map)); } catch(e) {}
}
function markSent(btn) {
  const key = btn.getAttribute('data-sent-key');
  if (!key) return;
  const map = loadSent();
  map[key] = new Date().toISOString();
  saveSent(map);
  applySentStyle(btn, map[key]);
  updateSentCounter();
}
function applySentStyle(btn, ts) {
  btn.style.background = '#94a3b8';
  btn.style.opacity = '0.85';
  const time = ts ? new Date(ts).toLocaleString('ko-KR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
  btn.textContent = '✓ 보냈음 ' + time;
  btn.style.fontSize = '11px';
  // 부모 row 도 살짝 표시
  const row = btn.closest('.row');
  if (row) row.style.opacity = '0.6';
}
function updateSentCounter() {
  const sent = loadSent();
  const all = document.querySelectorAll('.sms-btn');
  let count = 0;
  all.forEach(b => { if (sent[b.getAttribute('data-sent-key')]) count++; });
  const el = document.getElementById('sent-counter');
  if (el) el.textContent = '✓ ' + count + ' / ' + all.length + ' 명 발송됨';
}
function resetAllSent() {
  if (!confirm('모든 라이더의 발송 표시를 초기화할까요? (실제 발송된 문자는 안 지워집니다)')) return;
  saveSent({});
  document.querySelectorAll('.sms-btn').forEach(b => {
    b.style.background = ''; b.style.opacity = ''; b.style.fontSize = '';
    b.textContent = b.tagName === 'A' ? '💬 문자' : '⚠️ 번호입력';
    if (b.tagName === 'BUTTON') b.style.background = '#f59e0b';
    const row = b.closest('.row');
    if (row) row.style.opacity = '';
  });
  updateSentCounter();
}
window.addEventListener('DOMContentLoaded', () => {
  const sent = loadSent();
  document.querySelectorAll('.sms-btn').forEach(b => {
    const ts = sent[b.getAttribute('data-sent-key')];
    if (ts) applySentStyle(b, ts);
  });
  updateSentCounter();
});

function askPhoneAndSend(cleanName, body, btn) {
  const ask = prompt(cleanName + ' 폰번호 입력 (예: 01012345678)', '');
  if (!ask) return;
  const phone = ask.replace(/\\D/g,'');
  if (!/^\\d{10,11}$/.test(phone)) { alert('폰번호 형식 오류'); return; }
  try { navigator.clipboard && navigator.clipboard.writeText(body); } catch(e) {}
  const intl = phone.startsWith('010') ? '+82' + phone.slice(1) : phone;
  if (btn) markSent(btn);
  window.location.href = 'smsto:' + intl + '?body=' + encodeURIComponent(body);
}

async function shareImg(btn, name, url, payout, type) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⏳ 이미지 로드중…';
  try {
    const cleanName = name.replace(/\\d{4}$/, '');  // 라이선스 4자리 제거
    const blob = await fetch(url).then(r => { if(!r.ok) throw new Error('PNG 로드 실패'); return r.blob(); });
    const file = new File([blob], cleanName + '_정산서.png', { type: 'image/png' });
    const weekLabel = '${selectedWeek}'.replace(/^(\\d{4})-(\\d{2})-(\\d+)$/, '$1년 $2월 $3주차');
    const payoutText = payout ? '\\n실지급액: ' + Number(payout).toLocaleString() + '원' : '';
    const message = cleanName + '님 ' + weekLabel + ' ' + (type||'') + ' 정산서입니다.' + payoutText + '\\n\\n확인 후 문의사항 있으시면 연락 주세요.';
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: cleanName + '님 정산서', text: message });
      btn.textContent = '✓ 공유됨'; btn.style.background = '#059669';
    } else {
      // PC 등 Web Share 미지원: PNG 새 탭 + 텍스트 클립보드
      try { await navigator.clipboard.writeText(message); } catch(e) {}
      window.open(url, '_blank');
      btn.textContent = 'PC는 미지원'; btn.style.background = '#dc2626';
      alert('이 기기는 이미지 첨부 공유를 지원하지 않습니다.\\n폰(iOS Safari / Android Chrome)에서 열어주세요.');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      btn.textContent = '취소됨'; btn.style.background = '#94a3b8';
    } else {
      console.error(e);
      btn.textContent = '✗ 실패'; btn.style.background = '#dc2626';
      alert('오류: ' + e.message);
    }
  }
  setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.disabled = false; }, 2500);
}

function sendSms(btn, name, phone, url, payout, type) {
  const cleanName = name.replace(/\\d{4}$/, '');  // 라이선스 4자리 제거
  const payoutText = payout ? Number(payout).toLocaleString() + '원' : '';
  // 본문 매우 짧게 (긴 본문이 일부 SMS 앱에서 무시됨)
  const msg = cleanName + '님 정산서: ' + url + (payoutText ? ' (실지급 ' + payoutText + ')' : '');
  // 폰번호 없으면 직접 입력받기
  if (!phone) {
    const ask = prompt(cleanName + ' 폰번호 (예: 01012345678)', '');
    if (ask === null) {
      btn.textContent = '취소됨'; btn.style.background = '#94a3b8';
      setTimeout(() => { btn.textContent = '📤 전송'; btn.style.background = ''; }, 1500);
      return;
    }
    const cleaned = ask.replace(/\\D/g,'');
    if (/^\\d{10,11}$/.test(cleaned)) phone = cleaned;
  }
  // 클립보드 복사
  try { navigator.clipboard && navigator.clipboard.writeText(msg); } catch(e) {}
  // iOS 13+ 는 & 구분자, 그 외는 ? — UA 기반 분기
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const sep = isIOS ? '&' : '?';
  const href = phone
    ? 'sms:' + phone + sep + 'body=' + encodeURIComponent(msg)
    : 'sms:' + sep + 'body=' + encodeURIComponent(msg);
  // <a> 클릭 (iOS Safari 호환성 최고)
  const a = document.createElement('a');
  a.href = href;
  a.target = '_self';
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
  btn.textContent = '✓ 문자앱 열림 (안열리면 본문은 클립보드에 복사됨)'; btn.style.background = '#059669';
  btn.style.fontSize = '10px';
  setTimeout(() => { btn.textContent = '💬 문자'; btn.style.background = ''; btn.style.fontSize = ''; }, 4000);
}
</script>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────
// /admin/sms — ⭐ 통합 SMS 발송 페이지 (2026-04-30 신규)
//   - 라이더 정규화 이름 기준 한 행 (쿠플+배플 통합)
//   - 한 토큰당 한 PNG (이미 merge-dual-settlements.js로 합쳐짐)
//   - 큰 버튼 + 데스크톱 가로폭 활용
//   - SMS 한 번이면 끝 (이중 발송 방지)
// ─────────────────────────────────────────────────────────────────────
app.get('/admin/sms', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(404).send('Not found');
  const weeks = listSettlementWeeks();
  const selectedWeek = (req.query.week || weeks[0] || '').trim();
  const meta = selectedWeek ? readSettlementMeta(selectedWeek) : { week: '', riders: {} };

  // 폰 매핑 (기존 admin/settlement 와 동일 로직)
  const allBaemin = [], allCoupang = [];
  for (const b of Object.keys(baeminByBranch))  allBaemin.push(...(baeminByBranch[b].data || []));
  for (const b of Object.keys(coupangByBranch)) allCoupang.push(...(coupangByBranch[b].riders || []));
  try { const lp = path.join(__dirname,'rider-data.json'); if (fs.existsSync(lp)) allBaemin.push(...(JSON.parse(fs.readFileSync(lp,'utf8')).data || [])); } catch(e){}
  try { const lp = path.join(__dirname,'coupang-riders.json'); if (fs.existsSync(lp)) allCoupang.push(...(JSON.parse(fs.readFileSync(lp,'utf8')).riders || [])); } catch(e){}
  const baeminMap = new Map(), coupangMap = new Map();
  for (const r of allBaemin)  if (r?.name) { const ex = baeminMap.get(r.name);  if (!ex || (!ex.phone && r.phone)) baeminMap.set(r.name, r); }
  for (const r of allCoupang) if (r?.name) { const ex = coupangMap.get(r.name); if (!ex || (!ex.phone && r.phone)) coupangMap.set(r.name, r); }
  const manualPhones = readSettlementPhones();

  // 정규화 이름 기준 그룹화
  const normName = n => String(n||'').replace(/[0-9\s]/g,'').trim();
  const grouped = {};  // normName → { display, types, total, entries[] }
  for (const [origName, info] of Object.entries(meta.riders || {})) {
    const nm = normName(origName);
    if (!nm) continue;
    if (!grouped[nm]) grouped[nm] = { norm: nm, types: new Set(), total: 0, entries: [] };
    grouped[nm].types.add(info.type || '?');
    grouped[nm].total += Number(info.payout) || 0;
    grouped[nm].entries.push({ origName, ...info });
  }

  // 라이더 행 만들기 (정렬: 가나다순)
  const weekLabel = selectedWeek.replace(/^(\d{4})-(\d{2})-(\d+)$/, '$1년 $2월 $3주차');
  const riders = Object.values(grouped).sort((a,b) => a.norm.localeCompare(b.norm)).map(g => {
    const types = [...g.types];
    const typeLabel = types.length === 1 ? types[0] : types.sort().join('+');
    // 폰 룩업 — 정규화 이름 또는 entries의 원본 이름들로
    let phone = manualPhones[g.norm] || baeminMap.get(g.norm)?.phone || coupangMap.get(g.norm)?.phone || '';
    if (!phone) for (const e of g.entries) {
      phone = manualPhones[e.origName] || baeminMap.get(e.origName)?.phone || coupangMap.get(e.origName)?.phone || '';
      if (phone) break;
    }
    const phoneClean = phone.replace(/\D/g, '');
    const phoneIntl = phoneClean.startsWith('010') ? '+82' + phoneClean.slice(1) : phoneClean;
    const phoneDisplay = phone || '-';
    const token = ensureToken(g.norm);
    const url = `${PUBLIC_URL}/settlement/${token}/${selectedWeek}`;
    const smsBody = `${g.norm}님 ${weekLabel} 정산서입니다.\n분류: ${typeLabel}\n실지급액: ${g.total.toLocaleString()}원\n\n정산서 보기:\n${url}\n\n확인 후 문의사항 있으시면 연락 주세요.`;
    const smsHref = phoneClean
      ? `smsto:${phoneIntl}?body=${encodeURIComponent(smsBody)}`
      : `smsto:?body=${encodeURIComponent(smsBody)}`;
    return { norm: g.norm, types: typeLabel, total: g.total, phone: phoneClean, phoneDisplay, url, smsHref };
  });

  const ridersJson = JSON.stringify(riders);
  const totalCount = riders.length;
  const totalSum = riders.reduce((s, r) => s + r.total, 0);
  const dualCount = riders.filter(r => r.types.includes('+')).length;

  noCache(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>📤 통합 정산서 발송 (${selectedWeek})</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo',sans-serif;background:#f1f5f9;color:#0f172a}
  body{padding:0 0 200px;font-size:15px}
  @media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0} .card{background:#1e293b!important} .row{background:#1e293b!important;border-color:#334155!important} .stat{background:#1e293b!important}}
  .top{position:sticky;top:0;z-index:50;background:#1e3a8a;color:white;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
  .top h1{font-size:18px;font-weight:700}
  .top .week{font-size:13px;opacity:.85}
  .stats{display:flex;gap:10px;padding:14px 20px;flex-wrap:wrap;background:#fff;border-bottom:1px solid #e2e8f0}
  .stat{flex:1;min-width:140px;padding:14px 16px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0}
  .stat .l{font-size:12px;color:#64748b;font-weight:600;letter-spacing:.3px}
  .stat .v{font-size:22px;font-weight:800;color:#0f172a;margin-top:4px}
  .stat .v.green{color:#16a34a} .stat .v.amber{color:#ea580c}
  .ctrl{padding:14px 20px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .ctrl input{flex:1;min-width:180px;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;outline:none}
  .ctrl input:focus{border-color:#1e3a8a}
  .ctrl button{padding:10px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;background:#e2e8f0;color:#0f172a}
  .ctrl button.danger{background:#fee2e2;color:#b91c1c}
  .list{padding:14px 20px;display:grid;grid-template-columns:1fr;gap:8px}
  @media(min-width:900px){.list{grid-template-columns:1fr 1fr}}
  .row{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;display:flex;align-items:center;gap:14px;position:relative;transition:all .3s ease}
  /* 발송 완료된 행 — 흐리되 버튼은 명확히 보이게 */
  .row.sent{background:#f1f5f9;border-color:#cbd5e1}
  .row.sent .info{opacity:.55;filter:grayscale(0.8)}
  .row.sent::after{content:'✅ 발송 완료';position:absolute;top:8px;right:12px;background:#16a34a;color:white;padding:5px 14px;border-radius:6px;font-size:13px;font-weight:700;letter-spacing:.3px;z-index:2}
  .row.just-sent{animation:flash 1s ease}
  @keyframes flash{0%{background:#dcfce7;transform:scale(1.02)}100%{background:#f1f5f9;transform:scale(1)}}
  .info{flex:1;min-width:0}
  .info .nm{font-size:17px;font-weight:700;color:#0f172a}
  .info .meta{font-size:13px;color:#64748b;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap}
  .info .meta .tag{background:#dbeafe;color:#1e40af;padding:1px 8px;border-radius:4px;font-weight:600}
  .info .meta .tag.dual{background:#fef3c7;color:#92400e}
  .info .meta .ph{font-family:monospace}
  .info .pay{font-size:18px;font-weight:800;color:#0369a1;margin-top:4px}
  .row.sent .info .pay{color:#16a34a}
  .btns{display:flex;flex-direction:column;gap:6px;flex-shrink:0}
  /* 미발송: 큰 파란 버튼 */
  .btn-sms{background:linear-gradient(135deg,#1e3a8a,#3b82f6);color:white;border:none;border-radius:10px;padding:18px 28px;font-size:17px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;min-width:130px;justify-content:center;transition:all .3s ease;box-shadow:0 4px 12px rgba(30,58,138,.3)}
  .btn-sms:hover{background:linear-gradient(135deg,#1e40af,#60a5fa);transform:translateY(-1px)}
  /* ✅ 발송 후: 명확한 초록 그라데이션, 그림자 다른 색, 살짝 작아짐 */
  .btn-sms.sent{background:linear-gradient(135deg,#15803d,#22c55e);box-shadow:0 4px 12px rgba(22,163,74,.4);font-size:15px;padding:14px 22px}
  .btn-sms.sent:hover{background:linear-gradient(135deg,#166534,#16a34a)}
  .btn-sms.disabled{background:#cbd5e1;cursor:not-allowed;color:#64748b;box-shadow:none}
  .btn-link{background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 12px;border-radius:8px;font-size:13px;cursor:pointer;text-decoration:none;text-align:center}
  .btn-link:hover{background:#e2e8f0}
  /* ★★ 모바일 + 작은 태블릿: 풀너비 + 큰 버튼 (1024px 미만 모두 적용) */
  @media (max-width: 1024px) {
    .row { flex-direction: column; align-items: stretch; gap: 14px; padding: 18px }
    .info { text-align: left }
    .info .nm { font-size: 22px; font-weight: 800 }
    .info .pay { font-size: 26px; margin-top: 8px }
    .info .meta { font-size: 15px; margin-top: 8px }
    .info .meta .tag { padding: 4px 10px; font-size: 14px }
    .btns { width: 100%; flex-direction: column; gap: 10px }
    .btn-sms { padding: 26px; font-size: 22px; width: 100%; min-width: 0; min-height: 76px; border-radius: 14px }
    .btn-link { padding: 16px; font-size: 16px; width: 100%; min-height: 50px }
    .list { grid-template-columns: 1fr !important; padding: 14px }
    .stats { padding: 12px; gap: 8px }
    .stat { padding: 14px; min-width: 110px }
    .stat .l { font-size: 13px }
    .stat .v { font-size: 22px }
    .ctrl { padding: 12px }
    .ctrl button { padding: 14px 16px; font-size: 15px; min-height: 48px }
    .ctrl input { padding: 14px 16px; font-size: 16px; min-height: 48px }
    .top h1 { font-size: 20px }
  }
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:white;padding:14px 22px;border-radius:10px;font-size:14px;z-index:100;opacity:0;transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}
</style></head>
<body>
<div class="top">
  <div><h1>📤 통합 정산서 발송</h1><div class="week">${weekLabel} (${selectedWeek}) — 한 라이더 한 번 발송으로 끝</div></div>
</div>
<div class="stats">
  <div class="stat"><div class="l">전체</div><div class="v" id="cTotal">${totalCount}</div></div>
  <div class="stat"><div class="l">발송 완료</div><div class="v green" id="cSent">0</div></div>
  <div class="stat"><div class="l">대기</div><div class="v amber" id="cWait">${totalCount}</div></div>
  <div class="stat"><div class="l">이중정산자</div><div class="v">${dualCount}</div></div>
  <div class="stat"><div class="l">총 지급액</div><div class="v">${totalSum.toLocaleString()}</div></div>
</div>
<div class="ctrl">
  <input id="search" placeholder="이름 검색…">
  <button onclick="filter('all')">전체</button>
  <button onclick="filter('wait')">대기만</button>
  <button onclick="filter('sent')">완료만</button>
  <button onclick="filter('dual')">이중정산자</button>
  <button class="danger" onclick="resetSent()">발송기록 초기화</button>
</div>
<div class="list" id="list"></div>
<div class="toast" id="toast"></div>
<script>
const RIDERS = ${ridersJson};
const WEEK = ${JSON.stringify(selectedWeek)};
const SENT_KEY = 'sms-sent-' + WEEK;
let MODE = 'all';
let SEARCH = '';

function loadSent(){ try{return JSON.parse(localStorage.getItem(SENT_KEY)||'{}')}catch(e){return{}} }
function saveSent(m){ try{localStorage.setItem(SENT_KEY, JSON.stringify(m))}catch(e){} }
function resetSent(){ if(confirm('발송기록 초기화?')){ localStorage.removeItem(SENT_KEY); render() } }

function filter(m){ MODE=m; render() }
document.getElementById('search').addEventListener('input', e=>{ SEARCH=e.target.value.trim(); render() });

function esc(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

function render(){
  const list = document.getElementById('list');
  const sentMap = loadSent();
  let filtered = RIDERS.filter(r=>{
    if(SEARCH && !r.norm.includes(SEARCH)) return false;
    if(MODE==='wait' && sentMap[r.norm]) return false;
    if(MODE==='sent' && !sentMap[r.norm]) return false;
    if(MODE==='dual' && !r.types.includes('+')) return false;
    return true;
  });
  // 자동 정렬: 미발송 위, 발송 완료 아래 (같은 그룹 내에서는 가나다순 유지)
  filtered.sort((a,b) => {
    const aSent = sentMap[a.norm] ? 1 : 0;
    const bSent = sentMap[b.norm] ? 1 : 0;
    return aSent - bSent || a.norm.localeCompare(b.norm);
  });
  list.innerHTML = filtered.map(r=>{
    const sent = !!sentMap[r.norm];
    const dual = r.types.includes('+');
    const tagCls = dual ? 'tag dual' : 'tag';
    return \`<div class="row \${sent?'sent':''}">
      <div class="info">
        <div class="nm">\${esc(r.norm)}</div>
        <div class="meta">
          <span class="\${tagCls}">\${esc(r.types)}</span>
          <span class="ph">\${esc(r.phoneDisplay)}</span>
        </div>
        <div class="pay">\${r.total.toLocaleString()}원</div>
      </div>
      <div class="btns">
        \${ r.phone
            ? \`<button class="btn-sms \${sent?'sent':''}" data-norm="\${esc(r.norm)}" data-href="\${esc(r.smsHref)}" onclick="window.sendSms(this)">\${ sent?'✅ 다시 보내기':'📱 문자 발송'}</button>\`
            : \`<button class="btn-sms disabled" disabled>📞 번호없음</button>\`
        }
        <a class="btn-link" href="\${esc(r.url)}" target="_blank">정산서 미리보기</a>
        \${ sent ? \`<button class="btn-link" onclick="unmarkSent(\${JSON.stringify(r.norm)})">발송취소</button>\` : '' }
      </div>
    </div>\`;
  }).join('') || '<div style="padding:40px;text-align:center;color:#94a3b8">조건에 맞는 라이더가 없습니다</div>';

  const sentCount = RIDERS.filter(r=>sentMap[r.norm]).length;
  document.getElementById('cSent').textContent = sentCount;
  document.getElementById('cWait').textContent = RIDERS.length - sentCount;
}

function toast(m){ const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200) }
// ★ button onclick 통합 핸들러 — anchor href의 smsto: 동작이 onclick보다 먼저 실행되는 문제 회피
window.sendSms = function(btn) {
  const norm = btn.dataset.norm;
  const href = btn.dataset.href;
  // 1. 즉시 sent 표시 + render (DOM 업데이트)
  const m = loadSent();
  m[norm] = new Date().toISOString();
  saveSent(m);
  render();
  toast('✅ '+norm+' 발송 완료');
  // 2. 다음 미발송 라이더로 스크롤
  const next = RIDERS.find(x => !m[x.norm] && (MODE!=='dual' || x.types.includes('+')));
  if (next) {
    const target = [...document.querySelectorAll('.row .nm')].find(n=>n.textContent===next.norm);
    if (target) target.closest('.row').scrollIntoView({behavior:'smooth', block:'center'});
  }
  // 3. UI 업데이트가 완료된 후 SMS 앱 트리거 (200ms 후)
  setTimeout(() => { window.location.href = href; }, 200);
};
window.markSent = window.sendSms;  // 호환성 (기존 호출 사이트가 있을 경우)

// SMS 앱 다녀온 후 페이지 복귀 시 자동 갱신 (localStorage 변동 반영)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});
window.addEventListener('pageshow', () => render());
window.unmarkSent = norm => { const m=loadSent(); delete m[norm]; saveSent(m); render(); toast('↩ '+norm+' 표시 취소') };

render();
</script>
</body></html>`);
});

// /admin/add — 수동으로 라이더 토큰 사전 발급 (key 필요)
//   GET  ?key=...&name=홍길동
//   POST JSON { name: "홍길동" } (key 는 쿼리 or body)
function handleAdminAdd(req, res) {
  const key = req.query.key || (req.body && req.body.key);
  if (key !== ADMIN_KEY) return res.status(404).json({ error: 'not found' });
  const name = (req.query.name || (req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const existed = !!riderTokens[name];
  const token = ensureToken(name);
  res.json({ ok: true, name, token, url: `${PUBLIC_URL}/me/${token}`, existed });
}
app.get('/admin/add',  handleAdminAdd);
app.post('/admin/add', handleAdminAdd);

// /admin/links — 관리자용, 라이더별 개인 링크 목록 (key 필요)
app.get('/admin/links', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(404).send('Not found');
  }

  // 모든 매장의 활성 라이더 토큰 보장 + 매장 정보 매핑
  const branches = Object.keys(coupangByBranch || {});
  branches.forEach(b => (coupangByBranch[b]?.riders || []).forEach(r => ensureToken(r.name)));
  Object.keys(baeminByBranch || {}).forEach(b => (baeminByBranch[b]?.data || []).forEach(r => ensureToken(r.name)));

  // 라이더별 정보 통합: 매장(휘핏/덕송), 플랫폼(배민/쿠팡), 전화번호
  const info = {};
  branches.forEach(b => {
    (coupangByBranch[b]?.riders || []).forEach(r => {
      info[r.name] = info[r.name] || { branches: new Set(), platforms: new Set(), phone: '' };
      info[r.name].branches.add(b);
      info[r.name].platforms.add('쿠팡');
      if (r.phone && !info[r.name].phone) info[r.name].phone = r.phone;
    });
  });
  Object.keys(baeminByBranch || {}).forEach(b => {
    (baeminByBranch[b]?.data || []).forEach(r => {
      info[r.name] = info[r.name] || { branches: new Set(), platforms: new Set(), phone: '' };
      info[r.name].branches.add(b);
      info[r.name].platforms.add('배민');
      if (r.phone && !info[r.name].phone) info[r.name].phone = r.phone;
    });
  });

  // 정산서 메타 (최신 주차)
  const latestWeek = listSettlementWeeks()[0] || null;
  const settlementMeta = latestWeek ? readSettlementMeta(latestWeek) : { riders: {} };
  // settlement 전화번호 (수동 등록용 phones.json) — 라이더 데이터에 phone 없을 때 fallback
  const settlementPhones = readSettlementPhones();

  const rows = Object.keys(riderTokens).sort().map(name => {
    const i = info[name] || { branches: new Set(), platforms: new Set(), phone: '' };
    const token = riderTokens[name];
    const url = `${PUBLIC_URL}/me/${token}`;
    const settlementUrl = `${PUBLIC_URL}/settlement/${token}`;
    // 전화번호: 활성 라이더 데이터 우선, 없으면 정산서 phones.json
    const rawPhone = i.phone || settlementPhones[name] || '';
    const phone = rawPhone.replace(/\D/g, '');
    const branchList = Array.from(i.branches);
    const platformList = Array.from(i.platforms);
    // 정산서 정보
    const s = settlementMeta.riders?.[name];
    const settlement = s ? {
      week: latestWeek,
      payout: s.payout || 0,
      type: s.type || '',  // '쿠플' / '배플' 등
    } : null;
    return {
      name, url, settlementUrl, token, phone,
      branches: branchList,
      platforms: platformList,
      branchKey: branchList.join(',') || '미상',
      hasBaemin: platformList.includes('배민'),
      hasCoupang: platformList.includes('쿠팡'),
      hasPhone: !!phone,
      hasSettlement: !!settlement,
      settlement,
    };
  });

  // 매장 통계 (필터 카운트용)
  const stat = { all: rows.length, 휘핏: 0, 덕송: 0, 미상: 0, noPhone: 0, settlement: 0 };
  rows.forEach(r => {
    if (!r.hasPhone) stat.noPhone++;
    if (r.hasSettlement) stat.settlement++;
    if (r.branches.length === 0) stat.미상++;
    else r.branches.forEach(b => { stat[b] = (stat[b] || 0) + 1; });
  });

  // JSON으로 클라이언트에 데이터 전달 (filter/search/일괄발송 모두 클라이언트에서 처리)
  const ridersJson = JSON.stringify(rows).replace(/</g, '\\u003c');

  noCache(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>라이더 개인 링크 (${rows.length}명)</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  :root{--blue:#2563eb;--green:#16a34a;--red:#dc2626;--amber:#f59e0b;--bg:#f3f4f6;--card:#fff;--border:#e5e7eb;--text:#111827;--muted:#6b7280}
  body{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding-bottom:120px}
  /* sticky 상단바 */
  .topbar{position:sticky;top:0;z-index:50;background:#fff;border-bottom:1px solid var(--border);padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,0.04)}
  .topbar-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
  .topbar-row:last-child{margin-bottom:0}
  .search{flex:1;position:relative}
  .search input{width:100%;padding:11px 14px 11px 38px;border:1px solid var(--border);border-radius:10px;font-size:15px;background:#f9fafb}
  .search input:focus{outline:none;border-color:var(--blue);background:#fff}
  .search::before{content:'🔍';position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:14px;opacity:.6}
  .clear-btn{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:28px;height:28px;border:0;background:transparent;font-size:18px;color:#999;cursor:pointer;border-radius:50%;display:none}
  .clear-btn.show{display:block}
  .clear-btn:active{background:#eee}
  .filters{display:flex;gap:6px;flex-wrap:wrap}
  .chip{padding:6px 12px;border:1px solid var(--border);border-radius:999px;font-size:12px;font-weight:600;background:#fff;color:#555;cursor:pointer;white-space:nowrap}
  .chip.active{background:var(--blue);color:#fff;border-color:var(--blue)}
  .chip .cnt{margin-left:4px;font-size:11px;opacity:.85}
  .stats{display:flex;gap:12px;font-size:11px;color:var(--muted);margin-left:auto}
  .stats b{color:var(--blue)}
  /* 카드 그리드 */
  .grid{padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
  .card{background:var(--card);border-radius:12px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border:1px solid var(--border);transition:opacity .2s}
  .card.sent{opacity:.55;background:#f9fafb}
  .card.sent .name::before{content:'✓ ';color:var(--green);font-weight:900}
  .card .head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px}
  .card .name{font-size:16px;font-weight:700;color:var(--text)}
  .card .phone{font-size:12px;color:var(--muted);margin-top:2px;font-feature-settings:'tnum'}
  .card .no-phone{color:var(--red);font-weight:600}
  .badges{display:flex;gap:4px;flex-wrap:wrap}
  .badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;letter-spacing:.3px}
  .b-휘핏{background:#dbeafe;color:#1d4ed8}
  .b-덕송{background:#fce7f3;color:#be185d}
  .b-미상{background:#f3f4f6;color:#9ca3af}
  .b-배민{background:#fef3c7;color:#92400e}
  .b-쿠팡{background:#fee2e2;color:#991b1b}
  .url{font-family:ui-monospace,monospace;font-size:10px;color:#94a3b8;word-break:break-all;margin:4px 0 8px;line-height:1.3}
  .settlement-info{margin:6px 0;padding:7px 10px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;font-size:12px;font-weight:600;color:#166534}
  .settlement-info.no-settle{background:#fef2f2;border-left-color:#dc2626;color:#991b1b}
  .settlement-info.hint{background:#fafaf9;border-left-color:#a3a3a3;color:#6b7280;font-weight:500;font-size:11px;padding:4px 8px}
  .actions{display:flex;gap:6px}
  .btn{flex:1;padding:11px 10px;border:0;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}
  .btn-sms{background:var(--green);color:#fff}
  .btn-sms:active{background:#15803d}
  .btn-sms:disabled{background:#d1d5db;color:#6b7280}
  .btn-url{background:#f3f4f6;color:#374151;border:1px solid var(--border)}
  .btn-url:active{background:#e5e7eb}
  .btn-toggle{flex:0 0 38px;background:transparent;border:1px solid var(--border);color:#9ca3af;font-size:14px;padding:11px 0}
  .btn-toggle.sent{color:var(--green);border-color:var(--green);background:#f0fdf4}
  /* 메시지 템플릿 (접기/펼치기) */
  .panel{margin:12px;background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .panel-head{padding:12px 14px;font-size:13px;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:pointer;background:#fafbfc}
  .panel-head .arrow{transition:transform .2s}
  .panel.open .panel-head .arrow{transform:rotate(90deg)}
  .panel-body{display:none;padding:12px 14px;border-top:1px solid var(--border)}
  .panel.open .panel-body{display:block}
  .tpl-tabs{display:flex;gap:6px;margin-bottom:10px}
  .tpl-tab{flex:1;padding:7px;font-size:12px;font-weight:600;background:#f3f4f6;border:1px solid var(--border);border-radius:8px;cursor:pointer}
  .tpl-tab.active{background:var(--blue);color:#fff;border-color:var(--blue)}
  textarea{width:100%;min-height:120px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;line-height:1.5;resize:vertical}
  .tpl-hint{margin-top:8px;font-size:11px;color:var(--muted);line-height:1.5}
  .tpl-hint code{background:#f3f4f6;padding:2px 5px;border-radius:4px;font-size:11px}
  /* 신규 라이더 등록 */
  .add-row{display:flex;gap:8px;margin-top:8px}
  .add-row input{flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px}
  .add-row button{padding:10px 16px;background:var(--green);color:#fff;border:0;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer}
  /* 하단 progress bar */
  .progress{position:fixed;bottom:0;left:0;right:0;background:#1f2937;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 -2px 8px rgba(0,0,0,0.2);font-size:12px;z-index:100}
  .progress .num{font-weight:800;font-size:18px;color:#10b981}
  .progress button{background:transparent;color:#fff;border:1px solid #4b5563;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer}
  .progress button:active{background:#374151}
  /* 토스트 */
  .toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:200;opacity:0;pointer-events:none;transition:opacity .25s;max-width:90vw}
  .toast.show{opacity:1}
  .empty{text-align:center;padding:40px 20px;color:var(--muted);grid-column:1/-1}
  /* 좁은 화면 (폰) */
  @media (max-width:480px){
    .grid{grid-template-columns:1fr;gap:8px;padding:8px}
    .stats{font-size:10px;gap:8px}
    .chip{font-size:11px;padding:5px 10px}
  }
</style>
</head><body>

<div class="topbar">
  <div class="topbar-row">
    <div class="search">
      <input id="q" type="search" placeholder="라이더 이름 검색..." autocomplete="off">
      <button class="clear-btn" id="clearBtn" onclick="clearSearch()">×</button>
    </div>
  </div>
  <div class="topbar-row">
    <div class="filters">
      <button class="chip active" data-filter="all">전체<span class="cnt">${stat.all}</span></button>
      <button class="chip" data-filter="휘핏">휘핏<span class="cnt">${stat.휘핏 || 0}</span></button>
      <button class="chip" data-filter="덕송">덕송<span class="cnt">${stat.덕송 || 0}</span></button>
      <button class="chip" data-filter="unsent">미발송</button>
      <button class="chip" data-filter="sent">발송완료</button>
      <button class="chip" data-filter="nophone">전화없음<span class="cnt">${stat.noPhone}</span></button>
      <button class="chip" data-filter="settlement">💰정산서있음<span class="cnt">${stat.settlement}</span></button>
    </div>
    <div class="stats">
      <div>오늘 발송 <b id="sentToday">0</b>/${rows.length}</div>
    </div>
  </div>
</div>

<div class="panel" id="tplPanel">
  <div class="panel-head" onclick="document.getElementById('tplPanel').classList.toggle('open')">
    <span>📝 메시지 템플릿</span><span class="arrow">▶</span>
  </div>
  <div class="panel-body">
    <div class="tpl-tabs">
      <button class="tpl-tab active" data-tpl="default">📊 오늘 현황</button>
      <button class="tpl-tab" data-tpl="settle">💰 정산서</button>
      <button class="tpl-tab" data-tpl="custom">✏️ 사용자 정의</button>
    </div>
    <textarea id="tplArea" rows="6"></textarea>
    <div class="tpl-hint">
      변수: <code>{name}</code> 라이더 이름, <code>{url}</code> 링크 (모드별 자동 변경)
      <br>· <b>오늘 현황</b> → 모니터링 페이지 / <b>정산서</b> → 정산서 페이지로 자동 전환
      <br>· "사용자 정의"는 자동 저장됨
    </div>
  </div>
</div>

<div class="panel" id="addPanel">
  <div class="panel-head" onclick="document.getElementById('addPanel').classList.toggle('open')">
    <span>➕ 신규 라이더 사전 등록</span><span class="arrow">▶</span>
  </div>
  <div class="panel-body">
    <div style="font-size:12px;color:#6b7280;line-height:1.5">아직 대시보드에 안 나타난 신규 라이더를 미리 등록해 링크를 먼저 보낼 수 있어요.</div>
    <div class="add-row">
      <input id="newName" type="text" placeholder="라이더 이름 (예: 홍길동)" onkeypress="if(event.key==='Enter')addRider()">
      <button onclick="addRider()">추가</button>
    </div>
    <div id="addResult" style="margin-top:10px;font-size:12px;display:none"></div>
  </div>
</div>

<div class="grid" id="grid"></div>

<div class="progress">
  <div>오늘 발송: <span class="num" id="sentNum">0</span> / ${rows.length}명</div>
  <button onclick="resetSent()">발송 기록 초기화</button>
</div>

<div class="toast" id="toast"></div>

<script>
const RIDERS = ${ridersJson};
const TODAY = new Date().toISOString().slice(0,10); // YYYY-MM-DD
const SENT_KEY = 'rider-links-sent-' + TODAY;
const FILTER_KEY = 'rider-links-filter';
const TPL_KEY = 'rider-links-tpl';
const TPL_CUSTOM_KEY = 'rider-links-tpl-custom';

const TEMPLATES = {
  default: '{name}님 오늘의 내 현황 링크입니다.\\n\\n{url}\\n\\n⚠️ 처음 접속 시 영어 페이지가 뜰 수 있어요.\\n파란 "Visit Site" 버튼 한 번 누르시면\\n본 페이지로 이동합니다.\\n\\n거절률/완료건수 실시간 확인 가능 (15초마다 자동 갱신)',
  settle: '{name}님 이번 주 정산서입니다.\\n\\n{url}\\n\\n링크를 누르면 본인 정산서가 바로 보입니다.\\n금액에 이상 있으시면 연락주세요.',
  custom: ''
};

// 모드별 URL 매핑
function urlForMode(r) {
  if (tplKey === 'settle' && r.settlementUrl) return r.settlementUrl;
  return r.url;
}

let sent = JSON.parse(localStorage.getItem(SENT_KEY) || '{}');
let filter = localStorage.getItem(FILTER_KEY) || 'all';
let tplKey = localStorage.getItem(TPL_KEY) || 'default';
TEMPLATES.custom = localStorage.getItem(TPL_CUSTOM_KEY) || '{name}님, 안녕하세요.\\n\\n{url}';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmtPhone(p) {
  if (!p) return '';
  return p.replace(/^(\\d{3})(\\d{3,4})(\\d{4})$/, '$1-$2-$3');
}
function buildMsg(r) {
  const tpl = TEMPLATES[tplKey] || TEMPLATES.default;
  return tpl.replace(/{name}/g, r.name).replace(/{url}/g, urlForMode(r));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}
function saveSent() {
  localStorage.setItem(SENT_KEY, JSON.stringify(sent));
  const n = Object.keys(sent).length;
  $('#sentToday').textContent = n;
  $('#sentNum').textContent = n;
}
function markSent(name) {
  sent[name] = Date.now();
  saveSent();
  const card = document.querySelector('[data-name="' + CSS.escape(name) + '"]');
  if (card) {
    card.classList.add('sent');
    const tg = card.querySelector('.btn-toggle');
    if (tg) tg.classList.add('sent');
  }
}
function unmarkSent(name) {
  delete sent[name];
  saveSent();
  const card = document.querySelector('[data-name="' + CSS.escape(name) + '"]');
  if (card) {
    card.classList.remove('sent');
    const tg = card.querySelector('.btn-toggle');
    if (tg) tg.classList.remove('sent');
  }
}
function toggleSent(name) {
  if (sent[name]) unmarkSent(name); else markSent(name);
  if (filter === 'sent' || filter === 'unsent') applyFilter();
}
function resetSent() {
  if (!confirm('오늘 발송 기록을 모두 지울까요?')) return;
  sent = {};
  saveSent();
  $$('.card.sent').forEach(c => c.classList.remove('sent'));
  $$('.btn-toggle.sent').forEach(b => b.classList.remove('sent'));
  toast('발송 기록 초기화됨');
}
function copyUrl(name) {
  const r = RIDERS.find(x => x.name === name);
  if (!r) return;
  const link = urlForMode(r);
  navigator.clipboard.writeText(link).then(() => toast('링크 복사됨: ' + name + (tplKey==='settle' ? ' (정산서)' : ''))).catch(() => prompt('이 URL을 복사하세요:', link));
}
function copyMsg(name) {
  const r = RIDERS.find(x => x.name === name);
  if (!r) return;
  const msg = buildMsg(r);
  navigator.clipboard.writeText(msg).then(() => {
    toast('메시지 복사됨 (카톡에 붙여넣기 가능)');
    markSent(name);
  });
}
function sendSms(name) {
  const r = RIDERS.find(x => x.name === name);
  if (!r) return;
  const msg = buildMsg(r);
  // 클립보드 백업
  try { navigator.clipboard.writeText(msg); } catch(e) {}
  // sms: URL 호출
  const target = r.phone ? ('sms:' + r.phone + '?body=' + encodeURIComponent(msg))
                          : ('sms:?body=' + encodeURIComponent(msg));
  const a = document.createElement('a');
  a.href = target; a.style.display='none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  // 발송 표시
  markSent(name);
  toast(r.phone ? '문자 앱 열림: ' + name : '메시지 복사됨 (수신자 직접 입력)');
}
function clearSearch() {
  $('#q').value = '';
  $('#clearBtn').classList.remove('show');
  applyFilter();
}
function applyFilter() {
  const q = ($('#q').value || '').trim().toLowerCase();
  $('#clearBtn').classList.toggle('show', !!q);
  const grid = $('#grid');
  grid.innerHTML = '';
  let shown = 0;
  for (const r of RIDERS) {
    // 검색
    if (q && !r.name.toLowerCase().includes(q) && !(r.phone || '').includes(q)) continue;
    // 매장/상태 필터
    if (filter === '휘핏' && !r.branches.includes('휘핏')) continue;
    if (filter === '덕송' && !r.branches.includes('덕송')) continue;
    if (filter === 'unsent' && sent[r.name]) continue;
    if (filter === 'sent' && !sent[r.name]) continue;
    if (filter === 'nophone' && r.hasPhone) continue;
    if (filter === 'settlement' && !r.hasSettlement) continue;
    grid.appendChild(makeCard(r));
    shown++;
  }
  if (shown === 0) {
    grid.innerHTML = '<div class="empty">조건에 맞는 라이더가 없어요</div>';
  }
}
function fmtKRW(n) {
  return new Intl.NumberFormat('ko-KR').format(n) + '원';
}
function makeCard(r) {
  const div = document.createElement('div');
  div.className = 'card' + (sent[r.name] ? ' sent' : '');
  div.dataset.name = r.name;
  const branchesHtml = r.branches.length
    ? r.branches.map(b => '<span class="badge b-' + b + '">' + b + '</span>').join('')
    : '<span class="badge b-미상">미상</span>';
  const platformsHtml = r.platforms.map(p => '<span class="badge b-' + p + '">' + p + '</span>').join('');
  // 정산서 모드일 때 정산서 없으면 경고, 있으면 금액 표시
  let settlementBadge = '';
  if (tplKey === 'settle') {
    if (r.hasSettlement) {
      settlementBadge = '<div class="settlement-info">💰 ' + escapeHtml(r.settlement.type || '') + ' ' + fmtKRW(r.settlement.payout) + ' <span style="opacity:.6">(' + r.settlement.week + ')</span></div>';
    } else {
      settlementBadge = '<div class="settlement-info no-settle">⚠️ 이번 주 정산서 없음</div>';
    }
  } else if (r.hasSettlement) {
    // 일반 모드에서도 정산서 있으면 작게 힌트
    settlementBadge = '<div class="settlement-info hint">💰 정산서 있음 (' + fmtKRW(r.settlement.payout) + ')</div>';
  }
  const phoneHtml = r.phone
    ? '<div class="phone">' + escapeHtml(fmtPhone(r.phone)) + '</div>'
    : '<div class="phone no-phone">⚠️ 전화번호 없음 (수신자 직접 입력)</div>';
  // 모드별 URL 표시
  const linkUrl = urlForMode(r);
  // 정산서 모드인데 정산서 없으면 SMS 버튼 비활성화
  const smsDisabled = (tplKey === 'settle' && !r.hasSettlement) ? ' disabled' : '';
  div.innerHTML =
    '<div class="head">' +
      '<div>' +
        '<div class="name">' + escapeHtml(r.name) + '</div>' +
        phoneHtml +
      '</div>' +
      '<div class="badges">' + branchesHtml + platformsHtml + '</div>' +
    '</div>' +
    settlementBadge +
    '<div class="url">' + escapeHtml(linkUrl) + '</div>' +
    '<div class="actions">' +
      '<button class="btn btn-sms" data-act="sms"' + smsDisabled + '>💬 문자 보내기</button>' +
      '<button class="btn btn-url" data-act="url" title="링크만 복사">🔗</button>' +
      '<button class="btn btn-url" data-act="msg" title="메시지 복사 (카톡용)">📋</button>' +
      '<button class="btn btn-toggle' + (sent[r.name] ? ' sent' : '') + '" data-act="toggle" title="발송 완료 표시">✓</button>' +
    '</div>';
  div.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (btn.disabled) return;
    if (act === 'sms') sendSms(r.name);
    else if (act === 'url') copyUrl(r.name);
    else if (act === 'msg') copyMsg(r.name);
    else if (act === 'toggle') toggleSent(r.name);
  });
  return div;
}
async function addRider() {
  const input = $('#newName');
  const name = input.value.trim();
  const result = $('#addResult');
  if (!name) { result.style.display='block'; result.style.color='#dc2626'; result.textContent='이름을 입력하세요.'; return; }
  try {
    const r = await fetch('/admin/add?key=' + encodeURIComponent(new URLSearchParams(location.search).get('key') || '') + '&name=' + encodeURIComponent(name));
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'fail');
    result.style.display='block'; result.style.color='#16a34a';
    result.innerHTML = (j.existed ? '🔁 이미 등록: ' : '✅ 등록 완료: ') + '<b>' + escapeHtml(j.name) + '</b>';
    input.value = '';
    setTimeout(() => location.reload(), 1000);
  } catch(e) {
    result.style.display='block'; result.style.color='#dc2626';
    result.textContent = '실패: ' + e.message;
  }
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  // 필터 칩
  $$('.chip').forEach(c => {
    if (c.dataset.filter === filter) c.classList.add('active'); else c.classList.remove('active');
    c.addEventListener('click', () => {
      filter = c.dataset.filter;
      localStorage.setItem(FILTER_KEY, filter);
      $$('.chip').forEach(x => x.classList.toggle('active', x === c));
      applyFilter();
    });
  });
  // 검색
  $('#q').addEventListener('input', applyFilter);
  // 템플릿 탭
  $$('.tpl-tab').forEach(t => {
    if (t.dataset.tpl === tplKey) t.classList.add('active'); else t.classList.remove('active');
    t.addEventListener('click', () => {
      tplKey = t.dataset.tpl;
      localStorage.setItem(TPL_KEY, tplKey);
      $$('.tpl-tab').forEach(x => x.classList.toggle('active', x === t));
      $('#tplArea').value = TEMPLATES[tplKey];
      $('#tplArea').readOnly = (tplKey !== 'custom');
      // 정산서 모드로 전환 시 자동으로 정산서있음 필터로 이동 (편의)
      if (tplKey === 'settle' && filter !== 'settlement') {
        const settleChip = document.querySelector('.chip[data-filter="settlement"]');
        if (settleChip) settleChip.click();
      }
      // 카드 다시 그리기 (URL/금액 표시 변경)
      applyFilter();
    });
  });
  $('#tplArea').value = TEMPLATES[tplKey];
  $('#tplArea').readOnly = (tplKey !== 'custom');
  $('#tplArea').addEventListener('input', e => {
    if (tplKey === 'custom') {
      TEMPLATES.custom = e.target.value;
      localStorage.setItem(TPL_CUSTOM_KEY, e.target.value);
    }
  });
  saveSent();
  applyFilter();
});
</script>
</body></html>`);
});

// 쿠팡 대시보드 HTML
app.get('/coupang', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'coupang.html'), {
    etag: false,
    lastModified: false,
    cacheControl: false,
  });
});

app.get('/coupang-mobile', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'coupang-mobile.html'), {
    etag: false,
    lastModified: false,
    cacheControl: false,  // 우리가 위에서 직접 설정한 헤더 유지
  });
});

// 앱 → 서버: "지금 당장 배민 API 새로고침 해줘" 요청
// WebSocket 으로 즉시 확장에게 브로드캐스트 + HTTP 폴링도 fallback 으로 유지
app.post('/api/request-refresh', (req, res) => {
  refreshPending = true;
  const sent = broadcastToExtensions({ type: 'scrape', at: Date.now() });
  console.log(`[서버] 수동 새로고침 요청 받음 (WS 즉시 전달: ${sent}개 확장)`);
  res.json({ ok: true, wsClients: sent });
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  // ETag/Last-Modified 비활성화 — iOS Safari가 304로 옛 페이지 받는 거 방지
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
};

app.get('/', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/mobile', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'baemin-mobile.html'));
});

app.get('/baemin-mobile', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'baemin-mobile.html'));
});

app.get('/raw-index', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 정산서 문자 발송 페이지
app.get('/sms', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'sms-sender.html'));
});

// 정산서 이미지 생성 페이지
app.get('/settlement', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'settlement-image.html'));
});

app.get('/settlement-card', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'settlement-card.html'));
});

app.get('/progress', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'progress.html'));
});

// 정산서 고화질 PNG 생성 (Chrome CDP 활용)
app.get('/api/settlement/screenshot', async (req, res) => {
  try {
    const CDP_PORT = 18800;

    // 1. Chrome 탭 목록 가져오기
    const tabsRes = await fetch(`http://localhost:${CDP_PORT}/json`);
    const tabs = await tabsRes.json();

    // about:blank 탭 또는 새 탭 찾기 (settlement 페이지용)
    let target = tabs.find(t => t.url && t.url.includes('settlement'));
    if (!target) target = tabs[0]; // fallback

    const ws = require('ws');
    const wsUrl = target.webSocketDebuggerUrl;

    await new Promise((resolve, reject) => {
      const socket = new ws(wsUrl);
      let msgId = 1;
      const send = (method, params = {}) => {
        const id = msgId++;
        socket.send(JSON.stringify({ id, method, params }));
        return id;
      };

      socket.on('open', () => {
        // settlement 페이지로 이동
        send('Page.navigate', { url: `http://localhost:${PORT}/settlement-card` });
      });

      const handlers = {};
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw);

        if (msg.method === 'Page.loadEventFired') {
          // 로드 완료 후 카드 요소 크기 파악
          setTimeout(() => {
            const evalId = send('Runtime.evaluate', {
              expression: `
                const el = document.getElementById('settlement-card');
                const r = el.getBoundingClientRect();
                JSON.stringify({x: r.x, y: r.y, w: r.width, h: r.height});
              `
            });
            handlers[evalId] = (result) => {
              const { x, y, w, h } = JSON.parse(result.result.value);
              const shotId = send('Page.captureScreenshot', {
                format: 'png',
                clip: { x, y, width: w, height: h, scale: 3 },
                captureBeyondViewport: true
              });
              handlers[shotId] = (shotResult) => {
                socket.close();
                const buf = Buffer.from(shotResult.data, 'base64');
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Content-Disposition', 'attachment; filename="settlement.png"');
                res.send(buf);
                resolve();
              };
            };
          }, 1500);
        }

        if (msg.id && handlers[msg.id]) {
          handlers[msg.id](msg.result);
          delete handlers[msg.id];
        }
      });

      socket.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 15000);
    });

  } catch (e) {
    console.error('[screenshot]', e.message);
    res.status(500).json({ error: e.message });
  }
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
  const urlFile = path.join('C:\\Users\\user\\.openclaw', 'tunnel-url.txt');
  if (fs.existsSync(urlFile)) {
    const url = fs.readFileSync(urlFile, 'utf8').trim();
    res.json({ url });
  } else {
    res.json({ url: null });
  }
});

// HTTP 서버 + WebSocket 서버 연결
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: '/ws-extension' });

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  const ip = req.socket.remoteAddress;
  console.log(`[WS] 확장 연결됨 (${ip}) | 총 ${wsClients.size}개`);
  // 연결 확인용 ping
  ws.send(JSON.stringify({ type: 'hello', at: Date.now() }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'pong') { /* keep-alive 응답 */ }
    } catch (e) {}
  });
  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] 확장 연결 끊김 | 남은 ${wsClients.size}개`);
  });
  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

// 30초마다 ping 보내 좀비 연결 정리
setInterval(() => {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch (e) {}
    }
  }
}, 30000);

httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const urlFile = path.join('C:\\Users\\user\\.openclaw', 'tunnel-url.txt');
  let tunnelUrl = '';
  if (fs.existsSync(urlFile)) tunnelUrl = fs.readFileSync(urlFile, 'utf8').trim();

  console.log(`\n✅ 배민 거절률 앱 실행 중!`);
  console.log(`\n💻 PC: http://localhost:${PORT}`);
  console.log(`📱 폰(같은 WiFi): http://${ip}:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws-extension (확장 즉시 push용)`);
  if (tunnelUrl) console.log(`🌐 외부(어디서든): ${tunnelUrl}`);
  console.log(`\n자동 시작: start-node.ps1 실행 시 함께 켜짐`);

  // ── 자동 scrape trigger: 30초마다 모든 확장에 신호 (service worker idle 방지) ──
  // 페이지 새로고침은 없음 (storage trigger만) — 쿠팡 사이트 부담 X
  setInterval(() => {
    const sent = broadcastToExtensions({ type: 'scrape', at: Date.now() });
    if (sent > 0 && Math.random() < 0.1) {
      console.log(`[자동 trigger] WS 전달 ${sent}개 확장`);
    }
  }, 30 * 1000);
});
