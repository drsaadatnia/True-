// ترو کوچ — single-page frontend (vanilla JS, hash routing)

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const state = { user: null, coach: null };
let cleanups = [];

// ---------- utilities ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const faNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('fa-IR'));

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const parseIso = (s) => new Date(`${s}T00:00:00`);
const todayIso = () => isoDate(new Date());
function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
/** Saturday that starts the Persian week containing `iso`. */
function weekStart(iso) {
  const d = parseIso(iso);
  return addDays(iso, -((d.getDay() + 1) % 7));
}
const faDate = (iso, opts = { day: 'numeric', month: 'long', year: 'numeric' }) =>
  iso ? new Intl.DateTimeFormat('fa-IR', opts).format(parseIso(iso.slice(0, 10))) : '—';

function statusInfo(w) {
  if (w.status === 'completed') return { cls: 'completed', label: 'انجام شد' };
  if (w.status === 'missed') return { cls: 'missed', label: 'انجام نشد' };
  if (w.date < todayIso()) return { cls: 'overdue', label: 'عقب‌افتاده' };
  return { cls: '', label: 'برنامه‌ریزی‌شده' };
}

function complianceBadge(c) {
  if (c === null || c === undefined) return '<span class="badge">بدون داده</span>';
  const cls = c >= 80 ? 'completed' : c >= 50 ? 'warn' : 'missed';
  return `<span class="badge ${cls}">${faNum(c)}٪ پایبندی</span>`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') {
    state.user = null;
    location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data.error || 'خطا در ارتباط با سرور');
  return data;
}

/** Wraps an async event handler: shows errors as a toast and disables the button while running. */
function action(fn) {
  return async (e) => {
    e?.preventDefault?.();
    const btn = e?.submitter ?? (e?.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null);
    if (btn) btn.disabled = true;
    try {
      await fn(e);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());

/** In-page replacement for the browser's confirm/prompt dialogs. Resolves to null on cancel. */
function ask(message, { input = null, type = 'text', okLabel = null, danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `<form method="dialog">
      <p>${esc(message)}</p>
      ${input !== null ? `<input id="ask-input" type="${type}" value="${esc(input)}" required>` : ''}
      <div class="row">
        <button value="ok" class="${danger ? 'danger-solid' : ''}">${okLabel ?? (danger ? 'حذف' : 'تأیید')}</button>
        <button value="cancel" class="ghost" formnovalidate>انصراف</button>
      </div></form>`;
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      const value = input !== null ? $('#ask-input', dlg).value.trim() : true;
      dlg.remove();
      resolve(dlg.returnValue === 'ok' && value ? value : null);
    });
    dlg.showModal();
    (input !== null ? $('#ask-input', dlg) : $('button', dlg)).focus();
  });
}

// ---------- layout ----------

function renderChrome() {
  const bar = $('#topbar');
  if (!state.user) return (bar.hidden = true);
  bar.hidden = false;
  $('#me-name').textContent = state.user.name;
  const links = state.user.role === 'coach'
    ? [['#/', 'داشبورد'], ['#/clients', 'شاگردان'], ['#/exercises', 'کتابخانه حرکات'], ['#/templates', 'قالب‌های تمرین']]
    : [['#/', 'تمرین‌های من'], ['#/messages', 'پیام به مربی'], ['#/progress', 'پیشرفت']];
  const current = location.hash || '#/';
  $('#nav').innerHTML = links.map(([href, label]) => {
    const active = href === '#/' ? current === '#/' : current.startsWith(href);
    return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
  }).join('');
}

$('#logout').addEventListener('click', action(async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  state.coach = null;
  location.hash = '#/login';
}));

// ---------- router ----------

const routes = [
  [/^\/login$/, loginView, { public: true }],
  [/^\/register$/, registerView, { public: true }],
  [/^\/$/, () => (state.user.role === 'coach' ? coachDashboard() : clientHome())],
  [/^\/clients$/, clientsView, { coach: true }],
  [/^\/clients\/(\d+)(?:\/(\w+))?$/, (id, tab) => clientView(Number(id), tab || 'calendar'), { coach: true }],
  [/^\/workouts\/new$/, (_, q) => workoutEditor(null, q), { coach: true }],
  [/^\/workouts\/(\d+)\/edit$/, (id) => workoutEditor(Number(id)), { coach: true }],
  [/^\/workouts\/(\d+)$/, (id) => workoutLog(Number(id))],
  [/^\/exercises$/, exercisesView, { coach: true }],
  [/^\/templates$/, templatesView, { coach: true }],
  [/^\/templates\/(new|\d+)$/, (id) => templateEditor(id === 'new' ? null : Number(id)), { coach: true }],
  [/^\/messages$/, () => chatView(state.user.id, view)],
  [/^\/progress$/, () => progressView(state.user.id, view)],
];

async function router() {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  const raw = (location.hash || '#/').slice(1);
  const [path, qs] = raw.split('?');
  const query = new URLSearchParams(qs);

  if (!state.user) {
    try {
      Object.assign(state, await api('/api/me'));
    } catch { /* not logged in */ }
  }

  for (const [re, handler, opts = {}] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    if (!opts.public && !state.user) return void (location.hash = '#/login');
    if (opts.public && state.user) return void (location.hash = '#/');
    if (opts.coach && state.user.role !== 'coach') return void (location.hash = '#/');
    renderChrome();
    view.innerHTML = '<div class="empty">در حال بارگذاری…</div>';
    try {
      const args = m.slice(1);
      await (args.length ? handler(...args, query) : handler(query, query));
    } catch (err) {
      view.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
    }
    return;
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', router);

// ---------- auth views ----------

function loginView() {
  renderChrome();
  view.innerHTML = `
    <div class="auth card">
      <h1>💪 ورود به ترو کوچ</h1>
      <form id="f">
        <label><span>ایمیل</span><input name="email" type="email" required autocomplete="email" dir="ltr"></label>
        <label><span>رمز عبور</span><input name="password" type="password" required autocomplete="current-password" dir="ltr"></label>
        <button style="width:100%">ورود</button>
      </form>
      <p class="muted small">حساب مربی ندارید؟ <a href="#/register">ثبت‌نام مربی</a><br>
      دموی مربی: <code>coach@demo.com</code> · دموی شاگرد: <code>client@demo.com</code> · رمز: <code>demo1234</code></p>
    </div>`;
  $('#f').addEventListener('submit', action(async (e) => {
    await api('/api/auth/login', { method: 'POST', body: formData(e.target) });
    location.hash = '#/'; // router re-fetches /api/me (user + coach)
  }));
}

function registerView() {
  renderChrome();
  view.innerHTML = `
    <div class="auth card">
      <h1>ثبت‌نام مربی</h1>
      <form id="f">
        <label><span>نام و نام خانوادگی</span><input name="name" required></label>
        <label><span>ایمیل</span><input name="email" type="email" required dir="ltr"></label>
        <label><span>رمز عبور (حداقل ۶ کاراکتر)</span><input name="password" type="password" minlength="6" required dir="ltr"></label>
        <button style="width:100%">ساخت حساب</button>
      </form>
      <p class="muted small">شاگردان را مربی از داخل پنل اضافه می‌کند. <a href="#/login">ورود</a></p>
    </div>`;
  $('#f').addEventListener('submit', action(async (e) => {
    await api('/api/auth/register', { method: 'POST', body: formData(e.target) });
    location.hash = '#/';
  }));
}

// ---------- coach: dashboard ----------

async function coachDashboard() {
  const d = await api('/api/dashboard');
  const reasons = (c) => {
    const r = [];
    if (!c.stats.scheduled_through) r.push('<span class="badge missed">برنامه آینده ندارد</span>');
    else if (c.stats.scheduled_through < addDays(todayIso(), 3)) r.push(`<span class="badge warn">برنامه تا ${faDate(c.stats.scheduled_through, { day: 'numeric', month: 'short' })}</span>`);
    if (c.stats.missed_30d && (c.stats.compliance ?? 100) < 70) r.push(complianceBadge(c.stats.compliance));
    if (c.stats.unread_messages) r.push(`<span class="badge">${faNum(c.stats.unread_messages)} پیام نخوانده</span>`);
    return r.join(' ');
  };
  view.innerHTML = `
    <h1>سلام ${esc(state.user.name)} 👋</h1>
    <div class="grid cols-4">
      <div class="card stat"><div class="value">${faNum(d.totals.clients)}</div><div class="label">شاگرد فعال</div></div>
      <div class="card stat"><div class="value">${d.totals.compliance === null ? '—' : faNum(d.totals.compliance) + '٪'}</div><div class="label">پایبندی ۳۰ روز اخیر</div></div>
      <div class="card stat"><div class="value">${faNum(d.totals.workouts_today)}</div><div class="label">تمرین امروز</div></div>
      <div class="card stat"><div class="value">${faNum(d.totals.unread_messages)}</div><div class="label">پیام نخوانده</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>نیازمند توجه</h2>
        ${d.needs_attention.length ? d.needs_attention.map((c) => `
          <div class="list-item">
            <a href="#/clients/${c.id}">${esc(c.name)}</a>
            <div class="row">${reasons(c)}</div>
          </div>`).join('') : '<div class="empty">همه چیز مرتب است ✅</div>'}
      </div>
      <div class="card">
        <h2>فعالیت اخیر شاگردان</h2>
        ${d.recent_activity.length ? d.recent_activity.map((w) => {
          const s = statusInfo(w);
          return `<div class="list-item">
            <div>
              <a href="#/clients/${w.client_id}">${esc(w.client_name)}</a> — <a href="#/workouts/${w.id}/edit">${esc(w.title)}</a>
              ${w.client_comment ? `<div class="small muted">💬 ${esc(w.client_comment)}</div>` : ''}
            </div>
            <div class="row"><span class="badge ${s.cls}">${s.label}</span><span class="small muted">${faDate(w.date, { day: 'numeric', month: 'short' })}</span></div>
          </div>`;
        }).join('') : '<div class="empty">هنوز فعالیتی ثبت نشده</div>'}
      </div>
    </div>`;
}

// ---------- coach: clients ----------

async function clientsView(query) {
  const archived = query.get('archived') === '1';
  const clients = await api(`/api/clients${archived ? '?archived=1' : ''}`);
  view.innerHTML = `
    <div class="row spread"><h1>شاگردان</h1>
      <div class="row">
        <a class="btn ghost" href="#/clients${archived ? '' : '?archived=1'}">${archived ? 'شاگردان فعال' : 'بایگانی‌شده‌ها'}</a>
        <button id="add-toggle">+ افزودن شاگرد</button>
      </div>
    </div>
    <form id="add" class="card" hidden>
      <h2>شاگرد جدید</h2>
      <div class="grid cols-2">
        <label><span>نام</span><input name="name" required></label>
        <label><span>ایمیل (نام کاربری شاگرد)</span><input name="email" type="email" required dir="ltr"></label>
        <label><span>رمز عبور اولیه</span><input name="password" minlength="6" required dir="ltr"></label>
        <label><span>هدف</span><input name="goal" placeholder="مثلاً کاهش وزن، افزایش قدرت…"></label>
      </div>
      <button>ذخیره</button>
    </form>
    <div class="card">
      ${clients.length ? `<table>
        <thead><tr><th>نام</th><th>هدف</th><th>پایبندی</th><th>آخرین تمرین انجام‌شده</th><th>برنامه تا</th><th></th></tr></thead>
        <tbody>${clients.map((c) => `
          <tr>
            <td><a href="#/clients/${c.id}">${esc(c.name)}</a><div class="small muted" dir="ltr" style="text-align:right">${esc(c.email)}</div></td>
            <td class="small">${esc(c.goal) || '—'}</td>
            <td>${complianceBadge(c.stats.compliance)}</td>
            <td class="small">${faDate(c.stats.last_completed)}</td>
            <td class="small">${c.stats.scheduled_through ? faDate(c.stats.scheduled_through) : '<span class="badge missed">بدون برنامه</span>'}</td>
            <td>${c.stats.unread_messages ? `<a class="badge" href="#/clients/${c.id}/messages">${faNum(c.stats.unread_messages)} پیام</a>` : ''}</td>
          </tr>`).join('')}</tbody></table>`
        : `<div class="empty">${archived ? 'شاگرد بایگانی‌شده‌ای ندارید' : 'هنوز شاگردی اضافه نکرده‌اید'}</div>`}
    </div>`;
  $('#add-toggle').addEventListener('click', () => ($('#add').hidden = !$('#add').hidden));
  $('#add').addEventListener('submit', action(async (e) => {
    const c = await api('/api/clients', { method: 'POST', body: formData(e.target) });
    toast('شاگرد اضافه شد');
    location.hash = `#/clients/${c.id}`;
  }));
}

async function clientView(clientId, tab) {
  const client = await api(`/api/clients/${clientId}`);
  const tabs = [['calendar', 'برنامه تمرینی'], ['messages', 'پیام‌ها'], ['progress', 'پیشرفت'], ['settings', 'تنظیمات']];
  view.innerHTML = `
    <div class="row spread">
      <div><h1 style="margin-bottom:0">${esc(client.name)} ${client.archived ? '<span class="badge warn">بایگانی</span>' : ''}</h1>
        <div class="muted small">${esc(client.goal) || 'هدفی ثبت نشده'}</div></div>
      <div class="row">${complianceBadge(client.stats.compliance)}
        <span class="small muted">${faNum(client.stats.completed_30d)} انجام‌شده / ${faNum(client.stats.missed_30d)} ازدست‌رفته (۳۰ روز)</span></div>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/clients/${clientId}/${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'messages' && client.stats.unread_messages ? ` (${faNum(client.stats.unread_messages)})` : ''}</a>`).join('')}</nav>
    <section id="tab"></section>`;
  const el = $('#tab');
  if (tab === 'calendar') return calendarTab(client, el);
  if (tab === 'messages') return chatView(client.id, el);
  if (tab === 'progress') return progressView(client.id, el);
  if (tab === 'settings') return clientSettings(client, el);
}

const calendarState = { start: null };

async function calendarTab(client, el) {
  calendarState.start ??= weekStart(todayIso());
  const start = calendarState.start;
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
  const workouts = await api(`/api/workouts?client_id=${client.id}&from=${days[0]}&to=${days[13]}`);
  const today = todayIso();
  el.innerHTML = `
    <div class="row spread" style="margin-bottom:12px">
      <div class="row">
        <button class="ghost" data-nav="-7">→ هفته قبل</button>
        <button class="ghost" data-nav="0">امروز</button>
        <button class="ghost" data-nav="7">هفته بعد ←</button>
      </div>
      <strong>${faDate(days[0], { day: 'numeric', month: 'long' })} تا ${faDate(days[13])}</strong>
    </div>
    <div class="calendar">${days.map((d) => `
      <div class="day ${d === today ? 'today' : ''}">
        <div class="day-head"><span>${faDate(d, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          <a class="btn icon" title="افزودن تمرین" href="#/workouts/new?client=${client.id}&date=${d}">+</a></div>
        ${workouts.filter((w) => w.date === d).map((w) => {
          const s = statusInfo(w);
          return `<div class="w-chip ${s.cls}" data-open="${w.id}" tabindex="0">
            <div class="t">${esc(w.title)}</div>
            <div class="small muted">${faNum(w.item_count)} حرکت · ${s.label}${w.client_comment ? ' · 💬' : ''}</div>
            <div class="actions">
              <button class="icon" data-copy="${w.id}">کپی</button>
              <button class="icon" data-del="${w.id}">حذف</button>
            </div>
          </div>`;
        }).join('')}
      </div>`).join('')}
    </div>`;

  const rerender = () => calendarTab(client, el);
  $$('[data-nav]', el).forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.nav);
    calendarState.start = n === 0 ? weekStart(todayIso()) : addDays(calendarState.start, n);
    rerender();
  }));
  $$('[data-open]', el).forEach((c) => {
    const open = () => (location.hash = `#/workouts/${c.dataset.open}/edit`);
    c.addEventListener('click', (e) => !e.target.closest('button') && open());
    c.addEventListener('keydown', (e) => e.key === 'Enter' && !e.target.closest('button') && open());
  });
  $$('[data-copy]', el).forEach((b) => b.addEventListener('click', action(async () => {
    const target = await ask('این تمرین به چه تاریخی کپی شود؟', { input: addDays(workouts.find((w) => w.id == b.dataset.copy).date, 7), type: 'date', okLabel: 'کپی' });
    if (!target) return;
    await api(`/api/workouts/${b.dataset.copy}/copy`, { method: 'POST', body: { date: target } });
    toast('تمرین کپی شد');
    rerender();
  })));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', action(async () => {
    if (!(await ask('این تمرین حذف شود؟', { danger: true }))) return;
    await api(`/api/workouts/${b.dataset.del}`, { method: 'DELETE' });
    toast('حذف شد');
    rerender();
  })));
}

function clientSettings(client, el) {
  el.innerHTML = `
    <form id="f" class="card">
      <label><span>نام</span><input name="name" value="${esc(client.name)}" required></label>
      <label><span>هدف</span><textarea name="goal">${esc(client.goal)}</textarea></label>
      <p class="small muted">ایمیل ورود: <span dir="ltr">${esc(client.email)}</span></p>
      <button>ذخیره</button>
    </form>
    <div class="card row">
      <button class="ghost" id="archive">${client.archived ? 'بازگردانی از بایگانی' : 'بایگانی شاگرد'}</button>
      <button class="danger" id="delete">حذف کامل شاگرد</button>
    </div>`;
  $('#f', el).addEventListener('submit', action(async (e) => {
    await api(`/api/clients/${client.id}`, { method: 'PUT', body: formData(e.target) });
    toast('ذخیره شد');
    router();
  }));
  $('#archive', el).addEventListener('click', action(async () => {
    await api(`/api/clients/${client.id}`, { method: 'PUT', body: { archived: !client.archived } });
    toast(client.archived ? 'شاگرد فعال شد' : 'شاگرد بایگانی شد');
    router();
  }));
  $('#delete', el).addEventListener('click', action(async () => {
    if (!(await ask(`همه اطلاعات «${client.name}» حذف شود؟ این کار برگشت‌پذیر نیست.`, { danger: true }))) return;
    await api(`/api/clients/${client.id}`, { method: 'DELETE' });
    toast('حذف شد');
    location.hash = '#/clients';
  }));
}

// ---------- coach: workout builder (shared by workouts and templates) ----------

function itemsEditor(container, initialItems, exercises) {
  let items = initialItems.map((it) => ({ ...it }));
  const byName = new Map(exercises.map((e) => [e.name, e]));
  const listId = `ex-list-${Math.random().toString(36).slice(2)}`;

  const readRows = () => {
    $$('.item-row[data-i]', container).forEach((row) => {
      const it = items[Number(row.dataset.i)];
      for (const f of ['name', 'sets', 'reps', 'load', 'rest', 'notes']) it[f] = $(`[name=${f}]`, row).value;
      const ex = byName.get(it.name.trim());
      it.exercise_id = ex ? ex.id : null;
    });
  };

  const render = () => {
    container.innerHTML = `
      <datalist id="${listId}">${exercises.map((e) => `<option value="${esc(e.name)}">${esc(e.category)}</option>`).join('')}</datalist>
      <div class="item-row item-head"><span></span><span>حرکت</span><span>ست</span><span>تکرار</span><span>وزنه</span><span>استراحت</span><span>نکته</span><span></span></div>
      ${items.map((it, i) => `
        <div class="item-row" data-i="${i}">
          <span class="num">${faNum(i + 1)}</span>
          <input class="name" name="name" list="${listId}" placeholder="نام حرکت (از کتابخانه یا دلخواه)" value="${esc(it.name)}">
          <input name="sets" placeholder="ست" value="${esc(it.sets)}">
          <input name="reps" placeholder="تکرار" value="${esc(it.reps)}">
          <input name="load" placeholder="وزنه" value="${esc(it.load)}">
          <input name="rest" placeholder="استراحت" value="${esc(it.rest)}">
          <input name="notes" placeholder="نکته" value="${esc(it.notes)}">
          <div class="ctrl">
            <button type="button" class="icon" data-up="${i}" title="بالا">▲</button>
            <button type="button" class="icon" data-down="${i}" title="پایین">▼</button>
            <button type="button" class="icon" data-rm="${i}" title="حذف">✕</button>
          </div>
        </div>`).join('')}
      <div class="row" style="margin-top:10px"><button type="button" class="ghost" id="add-item">+ افزودن حرکت</button></div>`;
    $('#add-item', container).addEventListener('click', () => {
      readRows();
      items.push({ name: '', sets: '', reps: '', load: '', rest: '', notes: '' });
      render();
      $$('.item-row[data-i] .name', container).at(-1).focus();
    });
    const move = (i, j) => {
      readRows();
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j], items[i]];
      render();
    };
    $$('[data-up]', container).forEach((b) => b.addEventListener('click', () => move(+b.dataset.up, +b.dataset.up - 1)));
    $$('[data-down]', container).forEach((b) => b.addEventListener('click', () => move(+b.dataset.down, +b.dataset.down + 1)));
    $$('[data-rm]', container).forEach((b) => b.addEventListener('click', () => {
      readRows();
      items.splice(+b.dataset.rm, 1);
      render();
    }));
  };

  render();
  return {
    getItems() {
      readRows();
      return items.filter((it) => it.name.trim())
        .map(({ exercise_id, name, sets, reps, load, rest, notes }) => ({ exercise_id, name, sets, reps, load, rest, notes }));
    },
    setItems(next) {
      items = next.map((it) => ({ ...it }));
      render();
    },
  };
}

async function workoutEditor(workoutId, query) {
  const [exercises, templates] = await Promise.all([api('/api/exercises'), api('/api/templates')]);
  const w = workoutId
    ? await api(`/api/workouts/${workoutId}`)
    : { client_id: Number(query.get('client')), date: query.get('date') || todayIso(), title: '', notes: '', items: [], status: 'planned' };
  const client = await api(`/api/clients/${w.client_id}`);
  const s = statusInfo(w);
  const hasResults = w.status !== 'planned' || w.items.some((it) => it.result);

  view.innerHTML = `
    <p><a href="#/clients/${client.id}">→ بازگشت به برنامه ${esc(client.name)}</a></p>
    <div class="row spread"><h1>${workoutId ? 'ویرایش تمرین' : 'تمرین جدید'} — ${esc(client.name)}</h1>
      ${workoutId ? `<span class="badge ${s.cls}">${s.label}</span>` : ''}</div>
    ${hasResults ? `
      <div class="card">
        <h2>گزارش شاگرد</h2>
        ${w.client_comment ? `<p>💬 ${esc(w.client_comment)}</p>` : ''}
        <table><thead><tr><th>حرکت</th><th>تجویز</th><th>نتیجه ثبت‌شده</th></tr></thead><tbody>
        ${w.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="small">${esc([it.sets && `${it.sets} ست`, it.reps && `${it.reps} تکرار`, it.load].filter(Boolean).join(' · '))}</td><td>${esc(it.result) || '—'}</td></tr>`).join('')}
        </tbody></table>
      </div>` : ''}
    <form id="f" class="card">
      <div class="grid cols-2">
        <label><span>عنوان تمرین</span><input name="title" required value="${esc(w.title)}" placeholder="مثلاً: پایین‌تنه A"></label>
        <label><span>تاریخ (${faDate(w.date, { weekday: 'long', day: 'numeric', month: 'long' })})</span><input name="date" type="date" required value="${esc(w.date)}"></label>
      </div>
      ${!workoutId && templates.length ? `
        <label><span>شروع از قالب</span><select id="tpl"><option value="">— بدون قالب —</option>
          ${templates.map((t) => `<option value="${t.id}">${esc(t.title)} (${faNum(t.items.length)} حرکت)</option>`).join('')}</select></label>` : ''}
      <label><span>توضیحات / گرم کردن</span><textarea name="notes">${esc(w.notes)}</textarea></label>
      <h3>حرکات</h3>
      <div id="items"></div>
      <div class="row spread" style="margin-top:16px">
        <div class="row"><button>ذخیره تمرین</button>
          ${workoutId ? '<button type="button" class="ghost" id="as-tpl">ذخیره به‌عنوان قالب</button>' : ''}</div>
        ${workoutId ? '<button type="button" class="danger" id="del">حذف تمرین</button>' : ''}
      </div>
    </form>`;

  const editor = itemsEditor($('#items'), w.items.length ? w.items : [{ name: '', sets: '', reps: '', load: '', rest: '', notes: '' }], exercises);
  $('#tpl')?.addEventListener('change', (e) => {
    const t = templates.find((x) => x.id == e.target.value);
    if (!t) return;
    const form = $('#f');
    if (!form.title.value) form.title.value = t.title;
    if (!form.notes.value) form.notes.value = t.notes;
    editor.setItems(t.items);
  });
  $('#f').addEventListener('submit', action(async (e) => {
    const body = { ...formData(e.target), items: editor.getItems(), client_id: client.id };
    if (!body.items.length) throw new Error('حداقل یک حرکت اضافه کنید');
    if (workoutId) await api(`/api/workouts/${workoutId}`, { method: 'PUT', body });
    else await api('/api/workouts', { method: 'POST', body });
    toast('تمرین ذخیره شد');
    calendarState.start = weekStart(body.date);
    location.hash = `#/clients/${client.id}`;
  }));
  $('#as-tpl')?.addEventListener('click', action(async () => {
    const title = await ask('نام قالب:', { input: $('#f').title.value, okLabel: 'ذخیره' });
    if (!title) return;
    await api(`/api/workouts/${workoutId}/save-template`, { method: 'POST', body: { title } });
    toast('به قالب‌ها اضافه شد');
  }));
  $('#del')?.addEventListener('click', action(async () => {
    if (!(await ask('این تمرین حذف شود؟', { danger: true }))) return;
    await api(`/api/workouts/${workoutId}`, { method: 'DELETE' });
    toast('حذف شد');
    location.hash = `#/clients/${client.id}`;
  }));
}

// ---------- coach: exercise library ----------

async function exercisesView() {
  let exercises = await api('/api/exercises');
  let category = '';
  view.innerHTML = `
    <div class="row spread">
      <h1>کتابخانه حرکات</h1>
      <div class="row">
        <button type="button" class="ghost" id="import">بارگذاری کتابخانه‌ی کامل</button>
        <button type="button" id="new">+ حرکت جدید</button>
      </div>
    </div>
    <form id="f" class="card" hidden>
      <h2 id="form-title">حرکت جدید</h2>
      <input type="hidden" name="id">
      <div class="grid cols-2">
        <label><span>نام حرکت</span><input name="name" required></label>
        <label><span>دسته (عضله / نوع)</span><input name="category" list="cat-list" placeholder="پا، سینه، هوازی…"></label>
      </div>
      <datalist id="cat-list"></datalist>
      <label><span>لینک ویدیوی آموزشی (یوتیوب، آپارات…)</span><input name="video_url" type="url" dir="ltr"></label>
      <label><span>نحوه اجرا</span><textarea name="instructions"></textarea></label>
      <div class="row"><button>ذخیره</button><button type="button" class="ghost" id="cancel-edit">انصراف</button></div>
    </form>
    <div class="card">
      <input id="q" style="margin-bottom:10px">
      <div class="chips" id="cats"></div>
      <div id="list"></div>
    </div>`;
  const form = $('#f');
  const closeForm = () => {
    form.reset();
    form.id.value = '';
    form.hidden = true;
  };
  const openForm = (e = null) => {
    form.reset();
    for (const k of ['id', 'name', 'category', 'video_url', 'instructions']) form[k].value = e ? e[k] : '';
    if (!e && category) form.category.value = category;
    $('#form-title').textContent = e ? `ویرایش «${e.name}»` : 'حرکت جدید';
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth' });
    form.name.focus({ preventScroll: true });
  };
  const renderCats = () => {
    const counts = new Map();
    for (const e of exercises) counts.set(e.category || 'بدون دسته', (counts.get(e.category || 'بدون دسته') ?? 0) + 1);
    if (category && !counts.has(category)) category = '';
    $('#q').placeholder = `جستجو در ${faNum(exercises.length)} حرکت (فارسی یا انگلیسی)…`;
    $('#cat-list').innerHTML = [...counts.keys()].map((c) => `<option value="${esc(c)}">`).join('');
    $('#cats').innerHTML = [['', 'همه', exercises.length], ...[...counts].map(([c, n]) => [c, c, n])]
      .map(([value, label, n]) => `<button type="button" class="chip ${value === category ? 'active' : ''}" data-cat="${esc(value)}" aria-pressed="${value === category}">${esc(label)} <span>${faNum(n)}</span></button>`).join('');
    $$('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      category = b.dataset.cat;
      renderCats();
      renderList();
    }));
  };
  const renderList = () => {
    const q = $('#q').value.trim().toLowerCase();
    const shown = exercises.filter((e) =>
      (!category || (e.category || 'بدون دسته') === category)
      && (!q || e.name.toLowerCase().includes(q) || e.category.includes(q)));
    $('#list').innerHTML = shown.length ? shown.map((e) => `
      <div class="list-item">
        <div style="min-width:0"><strong>${esc(e.name)}</strong> ${e.category && !category ? `<span class="badge">${esc(e.category)}</span>` : ''}
          ${e.video_url ? `<a class="small" href="${esc(e.video_url)}" target="_blank" rel="noopener">▶ ویدیو</a>` : ''}
          ${e.instructions ? `<div class="small muted">${esc(e.instructions)}</div>` : ''}</div>
        <div class="row" style="flex-wrap:nowrap"><button class="icon" data-edit="${e.id}">ویرایش</button><button class="icon" data-del="${e.id}">حذف</button></div>
      </div>`).join('') : '<div class="empty">حرکتی پیدا نشد</div>';
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openForm(exercises.find((x) => x.id == b.dataset.edit))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', action(async () => {
      if (!(await ask('این حرکت از کتابخانه حذف شود؟ (تمرین‌های قبلی تغییر نمی‌کنند)', { danger: true }))) return;
      await api(`/api/exercises/${b.dataset.del}`, { method: 'DELETE' });
      exercises = exercises.filter((x) => x.id != b.dataset.del);
      renderCats();
      renderList();
    })));
  };
  $('#q').addEventListener('input', renderList);
  $('#new').addEventListener('click', () => openForm());
  $('#cancel-edit').addEventListener('click', closeForm);
  $('#import').addEventListener('click', action(async () => {
    const { added } = await api('/api/exercises/import-defaults', { method: 'POST' });
    toast(added ? `${faNum(added)} حرکت به کتابخانه اضافه شد` : 'همه‌ی حرکات کتابخانه‌ی کامل از قبل موجود است');
    if (added) exercisesView();
  }));
  form.addEventListener('submit', action(async () => {
    const { id, ...body } = formData(form);
    if (id) {
      const updated = await api(`/api/exercises/${id}`, { method: 'PUT', body });
      exercises = exercises.map((x) => (x.id === updated.id ? updated : x));
    } else {
      exercises.push(await api('/api/exercises', { method: 'POST', body }));
    }
    exercises.sort((a, b) => a.category.localeCompare(b.category, 'fa') || a.name.localeCompare(b.name, 'fa'));
    toast('ذخیره شد');
    closeForm();
    renderCats();
    renderList();
  }));
  renderCats();
  renderList();
}

// ---------- coach: templates ----------

async function templatesView() {
  const [templates, clients] = await Promise.all([api('/api/templates'), api('/api/clients')]);
  view.innerHTML = `
    <div class="row spread"><h1>قالب‌های تمرین</h1><a class="btn" href="#/templates/new">+ قالب جدید</a></div>
    <p class="muted">تمرین‌های پرتکرار را یک بار بسازید و با یک کلیک برای هر شاگرد در هر تاریخی برنامه‌ریزی کنید.</p>
    ${templates.length ? templates.map((t) => `
      <div class="card">
        <div class="row spread">
          <div><a href="#/templates/${t.id}"><strong>${esc(t.title)}</strong></a>
            <div class="small muted">${t.items.map((i) => esc(i.name)).join('، ')}</div></div>
          <form class="row assign" data-id="${t.id}">
            <select name="client_id" required style="width:auto"><option value="">انتخاب شاگرد…</option>
              ${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
            <input type="date" name="date" value="${todayIso()}" required style="width:auto">
            <button>اختصاص</button>
            <button type="button" class="danger" data-del="${t.id}">حذف</button>
          </form>
        </div>
      </div>`).join('') : '<div class="card empty">هنوز قالبی نساخته‌اید</div>'}`;
  $$('form.assign').forEach((f) => f.addEventListener('submit', action(async (e) => {
    const body = formData(e.target);
    await api(`/api/templates/${f.dataset.id}/assign`, { method: 'POST', body });
    toast(`برای ${clients.find((c) => c.id == body.client_id).name} برنامه‌ریزی شد`);
  })));
  $$('[data-del]').forEach((b) => b.addEventListener('click', action(async () => {
    if (!(await ask('این قالب حذف شود؟', { danger: true }))) return;
    await api(`/api/templates/${b.dataset.del}`, { method: 'DELETE' });
    router();
  })));
}

async function templateEditor(templateId) {
  const exercises = await api('/api/exercises');
  const t = templateId
    ? (await api('/api/templates')).find((x) => x.id === templateId)
    : { title: '', notes: '', items: [] };
  if (!t) throw new Error('قالب پیدا نشد');
  view.innerHTML = `
    <p><a href="#/templates">→ بازگشت به قالب‌ها</a></p>
    <h1>${templateId ? 'ویرایش قالب' : 'قالب جدید'}</h1>
    <form id="f" class="card">
      <label><span>عنوان</span><input name="title" required value="${esc(t.title)}"></label>
      <label><span>توضیحات</span><textarea name="notes">${esc(t.notes)}</textarea></label>
      <h3>حرکات</h3>
      <div id="items"></div>
      <button style="margin-top:16px">ذخیره قالب</button>
    </form>`;
  const editor = itemsEditor($('#items'), t.items.length ? t.items : [{ name: '', sets: '', reps: '', load: '', rest: '', notes: '' }], exercises);
  $('#f').addEventListener('submit', action(async (e) => {
    const body = { ...formData(e.target), items: editor.getItems() };
    if (!body.items.length) throw new Error('حداقل یک حرکت اضافه کنید');
    if (templateId) await api(`/api/templates/${templateId}`, { method: 'PUT', body });
    else await api('/api/templates', { method: 'POST', body });
    toast('قالب ذخیره شد');
    location.hash = '#/templates';
  }));
}

// ---------- client: home & workout logging ----------

async function clientHome() {
  const [me, workouts] = await Promise.all([
    api(`/api/clients/${state.user.id}`),
    api(`/api/workouts?from=${addDays(todayIso(), -30)}&to=${addDays(todayIso(), 30)}`),
  ]);
  const today = todayIso();
  const upcoming = workouts.filter((w) => w.date >= today && w.status === 'planned');
  const overdue = workouts.filter((w) => w.date < today && w.status === 'planned');
  const history = workouts.filter((w) => w.status !== 'planned').reverse();
  const row = (w) => {
    const s = statusInfo(w);
    return `<a class="list-item" href="#/workouts/${w.id}">
      <div><strong>${esc(w.title)}</strong><div class="small muted">${faDate(w.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${faNum(w.item_count)} حرکت</div></div>
      <span class="badge ${s.cls}">${w.date === today && w.status === 'planned' ? 'امروز' : s.label}</span></a>`;
  };
  view.innerHTML = `
    <div class="row spread">
      <div><h1 style="margin-bottom:0">سلام ${esc(state.user.name)} 👋</h1>
        <div class="muted small">مربی شما: ${esc(state.coach?.name ?? '—')}${me.goal ? ` · هدف: ${esc(me.goal)}` : ''}</div></div>
      ${complianceBadge(me.stats.compliance)}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div>
        ${overdue.length ? `<div class="card"><h2>عقب‌افتاده</h2>${overdue.map(row).join('')}</div>` : ''}
        <div class="card"><h2>تمرین‌های پیش رو</h2>${upcoming.length ? upcoming.map(row).join('') : '<div class="empty">فعلاً تمرینی برنامه‌ریزی نشده</div>'}</div>
      </div>
      <div class="card"><h2>تاریخچه</h2>${history.length ? history.map(row).join('') : '<div class="empty">هنوز تمرینی ثبت نکرده‌اید</div>'}</div>
    </div>`;
}

async function workoutLog(workoutId) {
  const w = await api(`/api/workouts/${workoutId}`);
  if (state.user.role === 'coach') return void (location.hash = `#/workouts/${workoutId}/edit`);
  const s = statusInfo(w);
  view.innerHTML = `
    <p><a href="#/">→ بازگشت</a></p>
    <div class="row spread"><h1 style="margin-bottom:0">${esc(w.title)}</h1><span class="badge ${s.cls}">${s.label}</span></div>
    <p class="muted">${faDate(w.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
    ${w.notes ? `<div class="card">📝 ${esc(w.notes)}</div>` : ''}
    <form id="f">
      ${w.items.map((it, i) => `
        <div class="ex-card card">
          <div class="row spread"><h3>${faNum(i + 1)}. ${esc(it.name)}</h3>
            ${it.video_url ? `<a href="${esc(it.video_url)}" target="_blank" rel="noopener" class="small">▶ ویدیوی آموزشی</a>` : ''}</div>
          <div class="rx">
            ${it.sets ? `<span>ست: <b>${esc(it.sets)}</b></span>` : ''}
            ${it.reps ? `<span>تکرار: <b>${esc(it.reps)}</b></span>` : ''}
            ${it.load ? `<span>وزنه: <b>${esc(it.load)}</b></span>` : ''}
            ${it.rest ? `<span>استراحت: <b>${esc(it.rest)}</b></span>` : ''}
          </div>
          ${it.notes ? `<div class="small">💡 ${esc(it.notes)}</div>` : ''}
          ${it.instructions ? `<details class="small muted"><summary>نحوه اجرا</summary>${esc(it.instructions)}</details>` : ''}
          <label style="margin:8px 0 0"><span>نتیجه شما (وزنه/تکرار انجام‌شده)</span>
            <input name="r${it.id}" value="${esc(it.result)}" placeholder="مثلاً ۴×۸ با ۶۰ کیلو"></label>
        </div>`).join('')}
      <div class="card">
        <label><span>نظر برای مربی</span><textarea name="comment" placeholder="حس‌تان چطور بود؟ دردی داشتید؟">${esc(w.client_comment)}</textarea></label>
        <div class="row">
          <button class="ok" value="completed">✔ تمرین را انجام دادم</button>
          <button class="ghost" value="missed">انجام ندادم</button>
          ${w.status !== 'planned' ? '<button class="ghost" value="planned">بازگرداندن به حالت برنامه‌ریزی</button>' : ''}
        </div>
      </div>
    </form>`;
  $('#f').addEventListener('submit', action(async (e) => {
    const data = formData(e.target);
    const results = Object.fromEntries(w.items.map((it) => [it.id, data[`r${it.id}`] ?? '']));
    const status = e.submitter?.value ?? 'completed';
    await api(`/api/workouts/${w.id}/log`, { method: 'POST', body: { status, results, comment: data.comment } });
    toast(status === 'completed' ? 'آفرین! تمرین ثبت شد 🎉' : 'ثبت شد');
    location.hash = '#/';
  }));
}

// ---------- shared: messages ----------

async function chatView(clientId, el) {
  el.innerHTML = `
    ${el === view ? '<h1>پیام به مربی</h1>' : ''}
    <div class="card">
      <div class="chat" id="chat"></div>
      <form id="send" class="row" style="margin-top:12px">
        <textarea name="body" required placeholder="پیام خود را بنویسید… (Ctrl+Enter برای ارسال)" style="flex:1;min-height:44px"></textarea>
        <button>ارسال</button>
      </form>
    </div>`;
  const chat = $('#chat', el);
  let lastCount = -1;
  const load = async () => {
    const msgs = await api(`/api/messages${state.user.role === 'coach' ? `?client_id=${clientId}` : ''}`);
    if (msgs.length === lastCount) return;
    lastCount = msgs.length;
    chat.innerHTML = msgs.length ? msgs.map((m) => `
      <div class="bubble ${m.sender_id === state.user.id ? 'mine' : 'theirs'}"><div class="body">${esc(m.body)}</div><div class="meta">${esc(m.sender_name)} · ${new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(`${m.created_at.replace(' ', 'T')}Z`))}</div>
      </div>`).join('') : '<div class="empty">هنوز پیامی رد و بدل نشده</div>';
    chat.scrollTop = chat.scrollHeight;
  };
  await load();
  const timer = setInterval(() => load().catch(() => {}), 8000);
  cleanups.push(() => clearInterval(timer));
  const form = $('#send', el);
  form.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
  form.addEventListener('submit', action(async () => {
    await api('/api/messages', { method: 'POST', body: { client_id: clientId, body: form.body.value } });
    form.reset();
    await load();
  }));
}

// ---------- shared: progress / body metrics ----------

function lineChart(points) {
  if (points.length < 2) return '<div class="empty small">برای نمایش نمودار حداقل دو ثبت وزن لازم است</div>';
  const W = 640, H = 220, P = { l: 16, r: 44, t: 16, b: 28 };
  const ys = points.map((p) => p.y);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;
  const t0 = parseIso(points[0].x).getTime();
  const t1 = parseIso(points.at(-1).x).getTime() || t0 + 1;
  // RTL: time flows right-to-left so the latest point sits on the left.
  const sx = (x) => W - P.r - ((parseIso(x).getTime() - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
  const sy = (y) => P.t + (1 - (y - min) / (max - min)) * (H - P.t - P.b);
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="نمودار وزن">
    ${ticks.map((v) => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${sy(v)}" y2="${sy(v)}"/>
      <text x="${W - P.r + 6}" y="${sy(v) + 4}">${faNum(v.toFixed(1))}</text>`).join('')}
    <polyline class="line" points="${points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}"/>
    ${points.map((p) => `<circle class="dot" cx="${sx(p.x)}" cy="${sy(p.y)}" r="4"><title>${faDate(p.x)}: ${faNum(p.y)}</title></circle>`).join('')}
    <text x="${W - P.r}" y="${H - 6}" text-anchor="end">${faDate(points[0].x, { day: 'numeric', month: 'short' })}</text>
    <text x="${P.l}" y="${H - 6}" text-anchor="start">${faDate(points.at(-1).x, { day: 'numeric', month: 'short' })}</text>
  </svg>`;
}

async function progressView(clientId, el) {
  const metrics = await api(`/api/metrics${state.user.role === 'coach' ? `?client_id=${clientId}` : ''}`);
  const weights = metrics.filter((m) => m.weight !== null);
  const first = weights[0]?.weight, last = weights.at(-1)?.weight;
  const delta = weights.length > 1 ? last - first : null;
  el.innerHTML = `
    ${el === view ? '<h1>پیشرفت من</h1>' : ''}
    <div class="grid cols-2">
      <div class="card chart">
        <div class="row spread"><h2>روند وزن (کیلوگرم)</h2>
          ${delta !== null ? `<span class="badge ${delta <= 0 ? 'completed' : 'warn'}">${delta > 0 ? '+' : ''}${faNum(delta.toFixed(1))} کیلو</span>` : ''}</div>
        ${lineChart(weights.map((m) => ({ x: m.date, y: m.weight })))}
      </div>
      <form id="add" class="card">
        <h2>ثبت اندازه جدید</h2>
        <div class="grid cols-2">
          <label><span>تاریخ</span><input type="date" name="date" value="${todayIso()}" required></label>
          <label><span>وزن (کیلوگرم)</span><input type="number" step="0.1" name="weight" inputmode="decimal"></label>
          <label><span>درصد چربی</span><input type="number" step="0.1" name="body_fat" inputmode="decimal"></label>
          <label><span>یادداشت</span><input name="notes"></label>
        </div>
        <button>ثبت</button>
      </form>
    </div>
    <div class="card">
      <h2>سوابق</h2>
      ${metrics.length ? `<table><thead><tr><th>تاریخ</th><th>وزن</th><th>درصد چربی</th><th>یادداشت</th><th></th></tr></thead><tbody>
        ${[...metrics].reverse().map((m) => `<tr><td>${faDate(m.date)}</td><td>${faNum(m.weight)}</td><td>${faNum(m.body_fat)}</td><td class="small">${esc(m.notes)}</td>
          <td><button class="icon" data-del="${m.id}">حذف</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">هنوز اندازه‌ای ثبت نشده</div>'}
    </div>`;
  $('#add', el).addEventListener('submit', action(async (e) => {
    await api('/api/metrics', { method: 'POST', body: { ...formData(e.target), client_id: clientId } });
    toast('ثبت شد');
    progressView(clientId, el);
  }));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', action(async () => {
    if (!(await ask('این رکورد حذف شود؟', { danger: true }))) return;
    await api(`/api/metrics/${b.dataset.del}`, { method: 'DELETE' });
    progressView(clientId, el);
  })));
}

router();
