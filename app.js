'use strict';
// TRIG QUIZ: старый добрый JS, без фреймворков.
const app = document.getElementById('app');
const TOKEN_KEY = 'trig_student_token_v2';
let studentToken = localStorage.getItem(TOKEN_KEY);
let student = null;
let admin = null;
let publicStatus = null;
let mode = 'home';
let studentPollTimer = null;
let clockTimer = null;
let adminEvents = null;
let adminFallback = null;
let sending = false;
let syncing = false;
let isOffline = false;
let remainingAtSync = 0;
let syncClock = performance.now();

function html(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function byId(id) { return document.getElementById(id); }
function message(text, error = false) { return `<p class="notice ${error ? 'error' : ''}" role="status">${html(text)}</p>`; }
async function api(url, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (studentToken) headers['X-Student-Token'] = studentToken;
    const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: controller.signal });
    const data = await res.json();
    if (!res.ok) { const err = new Error(data.error || 'Ошибка сервера'); err.status = res.status; err.state = data.state; throw err; }
    return data;
  } finally { clearTimeout(timeout); }
}
function stopStudent() { if (studentPollTimer) clearInterval(studentPollTimer); if (clockTimer) clearInterval(clockTimer); studentPollTimer = clockTimer = null; }
function stopAdmin() { if (adminEvents) adminEvents.close(); if (adminFallback) clearInterval(adminFallback); adminEvents = adminFallback = null; }
function setMode(next) {
  if (mode !== next) {
    if (mode === 'student') stopStudent();
    if ((mode === 'teacher' || mode === 'top') && next !== 'teacher' && next !== 'top') stopAdmin();
  }
  mode = next;
}
function isStudentComplete() { return Boolean(student && student.finished); }
function statusLabel() { return publicStatus?.open ? 'Тест открыт' : 'Тест закрыт'; }
function home(errorText = '') {
  setMode('home');
  const closed = publicStatus && !publicStatus.open;
  app.innerHTML = `<section class="panel">
    <h1>TRIG QUIZ</h1>
    <p>10 вопросов по тригонометрии. На каждый вопрос даётся 20 секунд.</p>
    <p class="small muted">Один участник, одна попытка. Введите имя и фамилию или код преподавателя.</p>
    ${errorText ? message(errorText, true) : ''}
    ${closed ? message('Тест закрыт для новых участников.') : ''}
    <form id="entry"><label for="login">Логин</label>
      <input id="login" name="login" type="text" maxlength="90" placeholder="Имя Фамилия" required autocomplete="name">
      <button class="wide" type="submit">Войти</button>
    </form>
  </section>`;
}
function studentSignature(s) { return s ? `${s.finished}-${s.published}-${s.question?.id || ''}-${s.number || ''}` : ''; }
function setStudent(next) {
  const oldSignature = studentSignature(student);
  student = next;
  remainingAtSync = next.remainingMs || 0;
  syncClock = performance.now();
  isOffline = false;
  if (mode !== 'student' || studentSignature(next) !== oldSignature) renderStudent();
  else paintClock();
}
function renderStudent() {
  setMode('student');
  if (!student) return home();
  if (student.finished) {
    const review = student.published ? `<div class="notice success"><strong>Результат: ${student.score} из ${student.total}</strong></div>
      <h2>Разбор ответов</h2>
      ${student.review.map(q => `<div class="review"><h3>${q.number}. ${html(q.text)}</h3>
        <p>Ваш ответ: <span class="${q.yourAnswer === q.correct ? 'correct' : 'wrong'}">${q.yourAnswer === null ? 'Время истекло' : html(q.options[q.yourAnswer])}</span></p>
        <p>Верный ответ: <b>${html(q.options[q.correct])}</b></p><p class="small muted">${html(q.explanation)}</p></div>`).join('')}` : message('Результаты пока скрыты. Преподаватель опубликует их после окончания тестирования.');
    app.innerHTML = `<section class="panel"><h1>Тест завершён</h1><p>Спасибо, ${html(student.name)}. Ваши ответы сохранены.</p>${review}<p class="small muted">Повторное прохождение недоступно.</p><div class="buttons"><button class="secondary" data-action="home">На страницу входа</button></div></section>`;
    startStudentPolling();
    return;
  }
  const q = student.question;
  app.innerHTML = `<section class="panel">
    <div class="row"><div><span class="small muted">${html(student.name)}</span><br><b>Вопрос ${student.number} из ${student.total}</b></div><div id="clock" class="time">00:20</div></div>
    <div class="progress" aria-hidden="true"><div style="width:${((student.number - 1) / student.total) * 100}%"></div></div>
    <h2>${html(q.text)}</h2>
    ${q.options.map((option, i) => `<button class="option" type="button" data-choice="${i}"><b>${'АБВГ'[i]}</b> ${html(option)}</button>`).join('')}
    <p id="connection" class="small muted">При потере связи таймер приостанавливается.</p>
  </section>`;
  paintClock();
  startStudentPolling();
}
function paintClock() {
  if (mode !== 'student' || !student || student.finished) return;
  const el = byId('clock');
  if (!el) return;
  const left = Math.max(0, remainingAtSync - (isOffline ? 0 : performance.now() - syncClock));
  el.textContent = '00:' + String(Math.ceil(left / 1000)).padStart(2, '0');
  el.classList.toggle('low', left <= 5000);
  const con = byId('connection');
  if (con) con.textContent = isOffline ? 'Нет связи с сервером. Таймер временно на паузе.' : 'При потере связи таймер приостанавливается.';
}
function startStudentPolling() {
  if (!clockTimer) clockTimer = setInterval(paintClock, 200);
  if (!studentPollTimer) studentPollTimer = setInterval(pollStudent, 1000);
}
async function pollStudent() {
  if (syncing || !studentToken || mode !== 'student') return;
  syncing = true;
  try { const next = await api('/api/student'); setStudent(next); }
  catch (e) {
    if (e.status === 401) { studentError(e); return; }
    isOffline = true;
    remainingAtSync = Math.max(0, remainingAtSync - (performance.now() - syncClock));
    syncClock = performance.now();
    paintClock();
  }
  finally { syncing = false; }
}
async function enter(login) {
  const button = byId('entry')?.querySelector('button');
  if (button) button.disabled = true;
  try {
    const result = await api('/api/enter', { method: 'POST', body: { login } });
    if (result.role === 'teacher') {
      stopStudent(); student = null; admin = await api('/api/admin'); renderTeacher(); startAdminEvents();
    } else {
      studentToken = result.token; localStorage.setItem(TOKEN_KEY, studentToken);
      setStudent(result.state);
    }
  } catch (e) { home(e.message); }
}
async function answer(choice) {
  if (sending || !student || student.finished || isOffline) return;
  sending = true;
  const questionId = student.question.id;
  document.querySelectorAll('.option').forEach(b => b.disabled = true);
  try {
    const next = await api('/api/answer', { method: 'POST', body: { questionId, choice } });
    setStudent(next);
  } catch (e) {
    if (e.state) setStudent(e.state);
    else { isOffline = true; paintClock(); await pollStudent(); }
  } finally {
    sending = false;
    document.querySelectorAll('.option').forEach(b => b.disabled = false);
  }
}
function studentError(error) {
  if (error.status === 401) { studentToken = null; localStorage.removeItem(TOKEN_KEY); student = null; home(); }
}
function renderTeacher() {
  setMode('teacher');
  if (!admin) return home();
  const rows = admin.participants.map(p => `<tr><td>${html(p.name)}</td><td>${p.finished ? `${p.score}/10` : 'Скрыто'}</td><td>${p.finished ? 'Закончил' : `Проходит (${p.answered}/10)`}</td><td>${p.disconnects}</td></tr>`).join('');
  app.innerHTML = `<section class="panel">
    <div class="row"><h1>Результаты</h1><span class="status">${admin.open ? 'Тест открыт' : 'Тест закрыт'}</span></div>
    <p class="small muted">Панель преподавателя. Таблица обновляется автоматически при ответах участников.</p>
    <div class="stats"><div class="stat"><strong>${admin.total}</strong><span>Участников</span></div><div class="stat"><strong>${admin.finished}</strong><span>Завершили</span></div><div class="stat"><strong>${admin.active}</strong><span>Проходят</span></div></div>
    <div class="scroll"><table><thead><tr><th>Студент</th><th>Правильно</th><th>Статус</th><th>Обрывы</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Пока нет участников</td></tr>'}</tbody></table></div>
    <div class="buttons">
      <button data-action="${admin.open ? 'close' : 'open'}">${admin.open ? 'Закрыть тест' : 'Открыть тест'}</button>
      <button class="secondary" data-action="${admin.published ? 'unpublish' : 'publish'}" ${!admin.published && (admin.open || admin.active || !admin.total) ? 'disabled' : ''}>${admin.published ? 'Скрыть результаты' : 'Опубликовать результаты'}</button>
      <button class="secondary" data-action="top">ТОП-3 на доску</button>
      <button class="secondary" data-action="logout">Выйти</button>
    </div>
    <div class="notice small">Преподаватель видит баллы только закончивших. После закрытия теста уже начавшие могут закончить. Результаты студентов скрыты до публикации.</div>
  </section>
  <section class="panel"><h2>Очистка после проверки</h2>
    <p>Удаляются только участники, ответы и результаты. <b>Вопросы и настройки сохраняются.</b></p>
    <button class="danger" data-action="clear">Удалить результаты тестирования</button>
  </section>`;
}
function renderTop() {
  setMode('top');
  const show = admin && admin.published && admin.podium.length;
  const places = show ? [admin.podium.find(p => p.place === 2), admin.podium.find(p => p.place === 1), admin.podium.find(p => p.place === 3)] : [];
  app.innerHTML = `<section class="panel"><div class="row"><h1>TRIG QUIZ · TOP 3</h1><button class="secondary" data-action="back">Назад</button></div>
    ${show ? `<p class="muted">Победители по количеству правильных ответов. При равенстве баллов место делят.</p><div class="podium">${places.map((p, i) => `<div class="place"><div class="name">${p ? p.names.map(html).join('<br>') : '—'}</div><div class="mark">${p ? p.score + '/10' : ''}</div><div class="stand ${['second','first','third'][i]}">${p ? p.place : ''}</div></div>`).join('')}</div>` : message('Победители появятся после закрытия теста и публикации результатов.')}
    <div class="buttons"><button data-action="fullscreen" class="secondary">На весь экран</button></div></section>`;
}
async function adminCommand(action) {
  if (action === 'home') { await loadHome(); return; }
  if (action === 'top') { renderTop(); return; }
  if (action === 'back') { renderTeacher(); return; }
  if (action === 'fullscreen') { document.documentElement.requestFullscreen?.(); return; }
  if (action === 'logout') {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* сессия истечёт сама */ }
    stopAdmin(); admin = null; await loadHome(); return;
  }
  if (action === 'clear') {
    if (!confirm('Точно удалить ВСЕ результаты тестирования? Вопросы и настройки останутся.')) return;
    if (prompt('Для подтверждения напишите ОЧИСТИТЬ') !== 'ОЧИСТИТЬ') return;
  }
  if (action === 'open' && !confirm('Открыть тест для новых участников? Опубликованные результаты будут скрыты.')) return;
  try {
    const newState = await api('/api/admin/' + action, { method: 'POST', body: action === 'clear' ? { confirm: 'ОЧИСТИТЬ' } : {} });
    admin = newState;
    renderTeacher();
  } catch (e) { alert(e.message); }
}
function startAdminEvents() {
  if (adminEvents) return;
  adminEvents = new EventSource('/api/admin/events');
  adminEvents.onmessage = event => {
    try { admin = JSON.parse(event.data); if (mode === 'teacher') renderTeacher(); else if (mode === 'top') renderTop(); } catch { /* ждём следующее обновление */ }
  };
  // Резервный путь на случай проблем с SSE: проверка раз в 4 секунды.
  adminFallback = setInterval(async () => {
    if (mode !== 'teacher' && mode !== 'top') return;
    if (adminEvents && adminEvents.readyState === EventSource.OPEN) return;
    try { admin = await api('/api/admin'); if (mode === 'teacher') renderTeacher(); else renderTop(); }
    catch (e) { if (e.status === 401) { stopAdmin(); admin = null; home('Время доступа преподавателя истекло.'); } }
  }, 4000);
}
async function loadHome() {
  try { publicStatus = await api('/api/status'); home(); }
  catch { home('Не удалось подключиться к серверу. Запустите node server.js.'); }
}
async function initialize() {
  try {
    admin = await api('/api/admin'); renderTeacher(); startAdminEvents(); return;
  } catch { admin = null; }
  if (studentToken) {
    try { const s = await api('/api/student'); setStudent(s); return; }
    catch (e) { if (e.status === 401) studentError(e); else { home('Нет соединения с сервером. Повторите попытку после подключения.'); return; } }
  }
  await loadHome();
}
app.addEventListener('submit', e => { if (e.target.id === 'entry') { e.preventDefault(); enter(byId('login').value.trim()); } });
app.addEventListener('click', e => {
  const choice = e.target.closest('[data-choice]');
  if (choice) { answer(Number(choice.dataset.choice)); return; }
  const action = e.target.closest('[data-action]');
  if (action) adminCommand(action.dataset.action);
});
window.addEventListener('offline', () => {
  if (mode === 'student' && student && !student.finished) {
    remainingAtSync = Math.max(0, remainingAtSync - (performance.now() - syncClock));
    syncClock = performance.now(); isOffline = true; paintClock();
  }
});
window.addEventListener('online', () => { if (mode === 'student') pollStudent(); });
initialize();
