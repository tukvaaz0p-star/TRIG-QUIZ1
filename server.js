'use strict';
// TRIG QUIZ: простой сервер на стандартных модулях Node.js, без npm-зависимостей.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public') : ROOT;
const DATA_DIR = process.env.TRIG_DATA_DIR || path.join(ROOT, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const RESULTS_PATH = path.join(DATA_DIR, 'results.json');
const TEACHER_CODE = process.env.TEACHER_CODE || '1488';
const PORT = Number(process.env.PORT || 3000);
const QUESTION_TIME = 20000;
const PAUSE_AFTER_MS = 3500; // после пропадания связи длительное отсутствие запросов не расходует время
const TEACHER_SESSION_MS = 4 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));
if (!Array.isArray(questions) || questions.length !== 10 || questions.some(q =>
  !q.id || !q.text || !Array.isArray(q.options) || q.options.length !== 4 ||
  !Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3 || !q.explanation
)) throw new Error('В questions.json должны находиться 10 корректных вопросов.');
const questionMap = new Map(questions.map(q => [q.id, q]));
if (questionMap.size !== questions.length) throw new Error('ID вопросов должны быть уникальными.');

function writeJson(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) { writeJson(file, fallback); return fallback; }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
let settings = readJson(SETTINGS_PATH, { open: true, published: false });
let attempts = readJson(RESULTS_PATH, []);
if (!Array.isArray(attempts)) throw new Error('Неверный формат results.json');
const teacherSessions = new Map();
const teacherClients = new Set();
const teacherLoginAttempts = new Map();
let saveTimer;
function saveAttempts() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; writeJson(RESULTS_PATH, attempts); }
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(saveAttempts, 800); }
function saveSettings() { writeJson(SETTINGS_PATH, settings); }
function id() { return crypto.randomBytes(24).toString('hex'); }
function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function normalizeName(name) { return String(name).trim().replace(/\s+/g, ' '); }
function keyName(name) { return normalizeName(name).toLocaleLowerCase('ru'); }
function sendJson(res, status, obj, extra = {}) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
function fail(res, status, message) { sendJson(res, status, { error: message }); }
function getBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 10000) { reject(new Error('Слишком большой запрос')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Неверный JSON')); } });
    req.on('error', reject);
  });
}
function studentFromRequest(req) {
  const token = req.headers['x-student-token'];
  if (typeof token !== 'string') return null;
  return attempts.find(a => a.token === token) || null;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim().split('=').map(decodeURIComponent)).filter(p => p.length === 2));
}
function teacherFromRequest(req) {
  const token = cookies(req).trig_teacher;
  const expiry = token && teacherSessions.get(token);
  if (!expiry) return null;
  if (expiry < Date.now()) { teacherSessions.delete(token); return null; }
  return token;
}
function requireTeacher(req, res) {
  if (!teacherFromRequest(req)) { fail(res, 401, 'Нужен код преподавателя.'); return false; }
  return true;
}
function resultsCount() { return attempts.filter(a => a.finishedAt).length; }
function score(a) { return a.order.reduce((n, questionId) => n + (a.answers[questionId] === questionMap.get(questionId).correct ? 1 : 0), 0); }
function finish(a) {
  if (a.finishedAt) return;
  a.finishedAt = Date.now();
  a.remainingMs = 0;
  saveAttempts();
  broadcast();
}
function advance(a, answer) {
  const questionId = a.order[a.index];
  a.answers[questionId] = answer;
  a.index++;
  a.remainingMs = QUESTION_TIME;
  a.lastSeenAt = Date.now();
  if (a.index === a.order.length) finish(a);
  else { saveAttempts(); broadcast(); }
}
function syncTimer(a) {
  if (a.finishedAt) return;
  const now = Date.now();
  const elapsed = Math.max(0, now - a.lastSeenAt);
  if (elapsed > PAUSE_AFTER_MS) a.disconnects = (a.disconnects || 0) + 1;
  a.remainingMs -= Math.min(elapsed, PAUSE_AFTER_MS);
  a.lastSeenAt = now;
  if (a.remainingMs <= 0) advance(a, null);
  else scheduleSave();
}
function studentView(a) {
  const base = { name: a.name, total: questions.length, answered: a.index, finished: Boolean(a.finishedAt), published: settings.published, open: settings.open, disconnects: a.disconnects || 0 };
  if (a.finishedAt) {
    if (settings.published) {
      base.score = score(a);
      base.review = a.order.map((questionId, i) => {
        const q = questionMap.get(questionId);
        return { number: i + 1, text: q.text, options: q.options, yourAnswer: a.answers[questionId], correct: q.correct, explanation: q.explanation };
      });
    }
    return base;
  }
  const q = questionMap.get(a.order[a.index]);
  return { ...base, number: a.index + 1, question: { id: q.id, text: q.text, options: a.optionOrders[q.id].map(i => q.options[i]) }, remainingMs: Math.max(0, Math.ceil(a.remainingMs)) };
}
function standings() {
  return [...attempts].filter(a => a.finishedAt).sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, 'ru'));
}
function podium() {
  const completed = standings();
  const scores = [...new Set(completed.map(score))].slice(0, 3);
  return scores.map((points, i) => ({ place: i + 1, score: points, names: completed.filter(a => score(a) === points).map(a => a.name) }));
}
function adminView() {
  const finished = standings();
  const active = attempts.filter(a => !a.finishedAt).sort((a, b) => a.startedAt - b.startedAt);
  return {
    open: settings.open, published: settings.published, total: attempts.length, finished: finished.length, active: active.length,
    participants: [...finished, ...active].map(a => ({ id: a.id, name: a.name, finished: Boolean(a.finishedAt), answered: a.index, score: a.finishedAt ? score(a) : null, disconnects: a.disconnects || 0 })),
    podium: podium()
  };
}
function broadcast() {
  if (!teacherClients.size) return;
  const message = `data: ${JSON.stringify(adminView())}\n\n`;
  for (const client of teacherClients) { try { client.write(message); } catch { teacherClients.delete(client); } }
}
function teacherLoginAllowed(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (teacherLoginAttempts.get(ip) || []).filter(t => now - t < 60000);
  recent.push(now); teacherLoginAttempts.set(ip, recent);
  return recent.length <= 12;
}
function staticFile(req, res, pathname) {
  const allowed = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' };
  const filename = allowed[pathname];
  if (!filename) return fail(res, 404, 'Страница не найдена.');
  const type = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' });
  fs.createReadStream(path.join(PUBLIC, filename)).pipe(res);
}
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET' && !p.startsWith('/api/')) return staticFile(req, res, p);
  // Все изменяющие операции: JSON с того же сайта, без CORS.
  if (req.method === 'POST' && (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) return fail(res, 403, 'Чужой сайт не может изменить данные.');
  if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, { open: settings.open, published: settings.published, questionCount: questions.length });
  if (req.method === 'GET' && p === '/api/student') {
    const a = studentFromRequest(req);
    if (!a) return fail(res, 401, 'Попытка не найдена.');
    syncTimer(a);
    return sendJson(res, 200, studentView(a));
  }
  if (req.method === 'POST' && p === '/api/enter') {
    const body = await getBody(req);
    const login = normalizeName(body.login || '');
    if (login === TEACHER_CODE) {
      if (!teacherLoginAllowed(req)) return fail(res, 429, 'Слишком много попыток. Попробуйте позже.');
      const token = id();
      teacherSessions.set(token, Date.now() + TEACHER_SESSION_MS);
      return sendJson(res, 200, { role: 'teacher' }, { 'Set-Cookie': `trig_teacher=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TEACHER_SESSION_MS / 1000}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
    }
    if (!/^[\p{L}\p{M}'-]+(?:\s+[\p{L}\p{M}'-]+){1,3}$/u.test(login) || login.length > 90) return fail(res, 400, 'Введите имя и фамилию через пробел.');
    const existing = attempts.find(a => keyName(a.name) === keyName(login));
    if (existing) {
      if (req.headers['x-student-token'] === existing.token) { syncTimer(existing); return sendJson(res, 200, { role: 'student', token: existing.token, state: studentView(existing) }); }
      return fail(res, 409, 'Такое имя уже зарегистрировано. Если это ваша попытка, вернитесь с того же устройства.');
    }
    if (!settings.open) return fail(res, 403, 'Тест закрыт для новых участников.');
    const order = shuffle(questions.map(q => q.id));
    const optionOrders = Object.fromEntries(order.map(questionId => [questionId, shuffle([0, 1, 2, 3])]));
    const a = { id: id(), token: id(), name: login, order, optionOrders, answers: {}, index: 0, remainingMs: QUESTION_TIME, lastSeenAt: Date.now(), startedAt: Date.now(), finishedAt: null, disconnects: 0 };
    attempts.push(a);
    saveAttempts(); broadcast();
    return sendJson(res, 200, { role: 'student', token: a.token, state: studentView(a) });
  }
  if (req.method === 'POST' && p === '/api/answer') {
    const a = studentFromRequest(req);
    if (!a) return fail(res, 401, 'Попытка не найдена.');
    const body = await getBody(req);
    syncTimer(a);
    if (a.finishedAt) return sendJson(res, 200, studentView(a));
    const currentId = a.order[a.index];
    if (body.questionId !== currentId) return sendJson(res, 409, { error: 'Время вопроса истекло. Переходим дальше.', state: studentView(a) });
    if (!Number.isInteger(body.choice) || body.choice < 0 || body.choice > 3) return fail(res, 400, 'Выберите один из четырёх ответов.');
    const originalChoice = a.optionOrders[currentId][body.choice];
    advance(a, originalChoice);
    return sendJson(res, 200, studentView(a));
  }
  if (req.method === 'GET' && p === '/api/admin') { if (!requireTeacher(req, res)) return; return sendJson(res, 200, adminView()); }
  if (req.method === 'GET' && p === '/api/admin/events') {
    if (!requireTeacher(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify(adminView())}\n\n`);
    teacherClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* соединение закрылось */ } }, 15000);
    req.on('close', () => { clearInterval(heartbeat); teacherClients.delete(res); });
    return;
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    const token = teacherFromRequest(req);
    if (token) teacherSessions.delete(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'trig_teacher=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (req.method === 'POST' && p.startsWith('/api/admin/')) {
    if (!requireTeacher(req, res)) return;
    if (p === '/api/admin/close') { settings.open = false; saveSettings(); broadcast(); return sendJson(res, 200, adminView()); }
    if (p === '/api/admin/open') { settings.open = true; settings.published = false; saveSettings(); broadcast(); return sendJson(res, 200, adminView()); }
    if (p === '/api/admin/publish') {
      if (settings.open) return fail(res, 409, 'Сначала закройте тест.');
      if (!attempts.length || attempts.some(a => !a.finishedAt)) return fail(res, 409, 'Дождитесь завершения всех участников.');
      settings.published = true; saveSettings(); broadcast(); return sendJson(res, 200, adminView());
    }
    if (p === '/api/admin/unpublish') { settings.published = false; saveSettings(); broadcast(); return sendJson(res, 200, adminView()); }
    if (p === '/api/admin/clear') {
      const body = await getBody(req);
      if (body.confirm !== 'ОЧИСТИТЬ') return fail(res, 400, 'Для очистки требуется подтверждение.');
      attempts = []; saveAttempts(); broadcast();
      // Намеренно НЕ меняем settings.json и questions.json.
      return sendJson(res, 200, adminView());
    }
  }
  return fail(res, 404, 'Неизвестный адрес.');
}
const server = http.createServer((req, res) => {
  Promise.resolve(route(req, res)).catch(err => {
    console.error('Ошибка запроса:', err.message);
    if (!res.headersSent) fail(res, 500, 'Ошибка сервера.');
    else res.end();
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`TRIG QUIZ запущен: http://localhost:${server.address().port}`));
function shutdown() { saveAttempts(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 1000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
