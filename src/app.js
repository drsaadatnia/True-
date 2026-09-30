import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx } from './db.js';
import { importDefaultExercises } from './exercise-library.js';
import {
  createSession, destroySession, hashPassword, parseCookies,
  sessionCookie, sessionUser, verifyPassword,
} from './auth.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ITEM_FIELDS = ['sets', 'reps', 'load', 'rest', 'notes'];

const CREATED = Symbol('created');
const created = (body) => ({ [CREATED]: true, body });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- validation helpers ----------

function str(value, field, { required = false, max = 2000 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `فیلد ${field} نامعتبر است`);
  value = String(value).trim();
  if (required && !value) throw new HttpError(400, `فیلد ${field} الزامی است`);
  if (value.length > max) throw new HttpError(400, `فیلد ${field} بیش از حد طولانی است`);
  return value;
}

function date(value, field = 'تاریخ') {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} نامعتبر است (فرمت YYYY-MM-DD)`);
  }
  return value;
}

function num(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `فیلد ${field} باید عدد باشد`);
  return n;
}

function id(value, field = 'شناسه') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} نامعتبر است`);
  return n;
}

// ---------- the app ----------

export function createApp(db) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  // ----- access control -----

  const requireUser = (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'ابتدا وارد شوید');
    return ctx.user;
  };
  const requireCoach = (ctx) => {
    const user = requireUser(ctx);
    if (user.role !== 'coach') throw new HttpError(403, 'فقط مربی به این بخش دسترسی دارد');
    return user;
  };
  /** Returns the client row if `user` may see it (coach of the client, or the client themself). */
  const accessClient = (user, clientId) => {
    const client = db.prepare(`SELECT id, name, email, goal, coach_id, archived, created_at
      FROM users WHERE id = ? AND role = 'client'`).get(clientId);
    const allowed = client && (user.role === 'coach' ? client.coach_id === user.id : client.id === user.id);
    if (!allowed) throw new HttpError(404, 'شاگرد پیدا نشد');
    return client;
  };
  const accessWorkout = (user, workoutId) => {
    const w = db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId);
    if (!w) throw new HttpError(404, 'تمرین پیدا نشد');
    accessClient(user, w.client_id);
    return w;
  };
  const ownExercise = (coachId, exerciseId) => {
    const ex = db.prepare('SELECT * FROM exercises WHERE id = ? AND coach_id = ?').get(exerciseId, coachId);
    if (!ex) throw new HttpError(404, 'حرکت پیدا نشد');
    return ex;
  };
  const ownTemplate = (coachId, templateId) => {
    const t = db.prepare('SELECT * FROM templates WHERE id = ? AND coach_id = ?').get(templateId, coachId);
    if (!t) throw new HttpError(404, 'قالب پیدا نشد');
    return t;
  };

  // ----- shared helpers -----

  const cleanItems = (coachId, items) => {
    if (items === undefined) return [];
    if (!Array.isArray(items)) throw new HttpError(400, 'لیست حرکات نامعتبر است');
    if (items.length > 100) throw new HttpError(400, 'تعداد حرکات بیش از حد است');
    return items.map((raw) => {
      const item = {};
      item.exercise_id = raw.exercise_id ? ownExercise(coachId, id(raw.exercise_id)).id : null;
      item.name = str(raw.name, 'نام حرکت', { max: 200 });
      if (!item.name && item.exercise_id) {
        item.name = db.prepare('SELECT name FROM exercises WHERE id = ?').get(item.exercise_id).name;
      }
      if (!item.name) throw new HttpError(400, 'نام حرکت الزامی است');
      for (const f of ITEM_FIELDS) item[f] = str(raw[f], f, { max: 500 });
      return item;
    });
  };

  const insertItems = (workoutId, items) => {
    const stmt = db.prepare(`INSERT INTO workout_items
      (workout_id, position, exercise_id, name, sets, reps, load, rest, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    items.forEach((it, i) => stmt.run(workoutId, i, it.exercise_id, it.name, it.sets, it.reps, it.load, it.rest, it.notes));
  };

  const createWorkout = (coachId, clientId, { date: d, title, notes, items }) => tx(db, () => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO workouts (coach_id, client_id, date, title, notes)
      VALUES (?, ?, ?, ?, ?)`).run(coachId, clientId, d, title, notes);
    insertItems(lastInsertRowid, items);
    return Number(lastInsertRowid);
  });

  const workoutWithItems = (workoutId) => {
    const w = db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId);
    w.items = db.prepare(`SELECT wi.*, e.video_url, e.instructions, e.category
      FROM workout_items wi LEFT JOIN exercises e ON e.id = wi.exercise_id
      WHERE wi.workout_id = ? ORDER BY wi.position`).all(workoutId);
    return w;
  };

  /** Adherence over the last 30 days: completed / (completed + past-due planned + missed). */
  const clientStats = (clientId, viewerId) => {
    const from = today(-30);
    const t = today();
    const row = db.prepare(`SELECT
        SUM(status = 'completed') AS completed,
        SUM(status = 'missed' OR (status = 'planned' AND date < ?)) AS missed
      FROM workouts WHERE client_id = ? AND date >= ? AND date <= ?`).get(t, clientId, from, t);
    const completed = row.completed ?? 0;
    const missed = row.missed ?? 0;
    const due = completed + missed;
    const next = db.prepare(`SELECT MAX(date) AS d FROM workouts WHERE client_id = ? AND date >= ?`).get(clientId, t).d;
    const last = db.prepare(`SELECT MAX(date) AS d FROM workouts WHERE client_id = ? AND status = 'completed'`).get(clientId).d;
    const unread = db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE client_id = ? AND sender_id != ? AND read_at IS NULL`).get(clientId, viewerId).n;
    return {
      completed_30d: completed,
      missed_30d: missed,
      compliance: due ? Math.round((completed / due) * 100) : null,
      scheduled_through: next ?? null,
      last_completed: last ?? null,
      unread_messages: unread,
    };
  };

  // ================= auth =================

  route('POST', '/api/auth/register', (ctx) => {
    const name = str(ctx.body.name, 'نام', { required: true, max: 100 });
    const email = str(ctx.body.email, 'ایمیل', { required: true, max: 200 }).toLowerCase();
    const password = str(ctx.body.password, 'رمز عبور', { required: true, max: 200 });
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'ایمیل نامعتبر است');
    if (password.length < 6) throw new HttpError(400, 'رمز عبور باید حداقل ۶ کاراکتر باشد');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'این ایمیل قبلاً ثبت شده است');
    const { lastInsertRowid } = tx(db, () => {
      const res = db.prepare(`INSERT INTO users (role, name, email, password_hash)
        VALUES ('coach', ?, ?, ?)`).run(name, email, hashPassword(password));
      importDefaultExercises(db, Number(res.lastInsertRowid));
      return res;
    });
    ctx.setCookie(sessionCookie(createSession(db, Number(lastInsertRowid))));
    return created({ user: sessionUserById(Number(lastInsertRowid)) });
  });

  const sessionUserById = (userId) =>
    db.prepare('SELECT id, role, name, email, coach_id, goal FROM users WHERE id = ?').get(userId);

  route('POST', '/api/auth/login', (ctx) => {
    const email = str(ctx.body.email, 'ایمیل', { required: true }).toLowerCase();
    const password = str(ctx.body.password, 'رمز عبور', { required: true });
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND archived = 0').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'ایمیل یا رمز عبور اشتباه است');
    ctx.setCookie(sessionCookie(createSession(db, user.id)));
    return { user: sessionUserById(user.id) };
  });

  route('POST', '/api/auth/logout', (ctx) => {
    destroySession(db, ctx.token);
    ctx.setCookie(sessionCookie(null));
    return { ok: true };
  });

  route('GET', '/api/me', (ctx) => {
    const user = requireUser(ctx);
    const coach = user.coach_id ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(user.coach_id) : null;
    return { user, coach };
  });

  // ================= dashboard =================

  route('GET', '/api/dashboard', (ctx) => {
    const coach = requireCoach(ctx);
    const clients = db.prepare(`SELECT id, name, goal FROM users
      WHERE coach_id = ? AND role = 'client' AND archived = 0 ORDER BY name`).all(coach.id)
      .map((c) => ({ ...c, stats: clientStats(c.id, coach.id) }));
    const soon = today(3);
    const needsAttention = clients.filter((c) =>
      c.stats.missed_30d > 0 && (c.stats.compliance ?? 100) < 70
      || !c.stats.scheduled_through || c.stats.scheduled_through < soon
      || c.stats.unread_messages > 0);
    const recent = db.prepare(`SELECT w.id, w.title, w.date, w.status, w.client_comment, w.completed_at,
        u.id AS client_id, u.name AS client_name
      FROM workouts w JOIN users u ON u.id = w.client_id
      WHERE w.coach_id = ? AND w.completed_at IS NOT NULL
      ORDER BY w.completed_at DESC LIMIT 15`).all(coach.id);
    const due = clients.reduce((a, c) => a + c.stats.completed_30d + c.stats.missed_30d, 0);
    const done = clients.reduce((a, c) => a + c.stats.completed_30d, 0);
    return {
      totals: {
        clients: clients.length,
        compliance: due ? Math.round((done / due) * 100) : null,
        unread_messages: clients.reduce((a, c) => a + c.stats.unread_messages, 0),
        workouts_today: db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE coach_id = ? AND date = ?`).get(coach.id, today()).n,
      },
      needs_attention: needsAttention,
      recent_activity: recent,
    };
  });

  // ================= clients =================

  route('GET', '/api/clients', (ctx) => {
    const coach = requireCoach(ctx);
    const archived = ctx.query.get('archived') === '1' ? 1 : 0;
    return db.prepare(`SELECT id, name, email, goal, archived, created_at FROM users
      WHERE coach_id = ? AND role = 'client' AND archived = ? ORDER BY name`).all(coach.id, archived)
      .map((c) => ({ ...c, stats: clientStats(c.id, coach.id) }));
  });

  route('POST', '/api/clients', (ctx) => {
    const coach = requireCoach(ctx);
    const name = str(ctx.body.name, 'نام', { required: true, max: 100 });
    const email = str(ctx.body.email, 'ایمیل', { required: true, max: 200 }).toLowerCase();
    const password = str(ctx.body.password, 'رمز عبور', { required: true, max: 200 });
    const goal = str(ctx.body.goal, 'هدف', { max: 500 });
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'ایمیل نامعتبر است');
    if (password.length < 6) throw new HttpError(400, 'رمز عبور باید حداقل ۶ کاراکتر باشد');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'این ایمیل قبلاً ثبت شده است');
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (role, name, email, password_hash, coach_id, goal)
      VALUES ('client', ?, ?, ?, ?, ?)`).run(name, email, hashPassword(password), coach.id, goal);
    return created(accessClient(coach, Number(lastInsertRowid)));
  });

  route('GET', '/api/clients/:id', (ctx) => {
    const user = requireUser(ctx);
    const client = accessClient(user, id(ctx.params.id));
    return { ...client, stats: clientStats(client.id, user.id) };
  });

  route('PUT', '/api/clients/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const client = accessClient(coach, id(ctx.params.id));
    const name = ctx.body.name !== undefined ? str(ctx.body.name, 'نام', { required: true, max: 100 }) : client.name;
    const goal = ctx.body.goal !== undefined ? str(ctx.body.goal, 'هدف', { max: 500 }) : client.goal;
    const archived = ctx.body.archived !== undefined ? (ctx.body.archived ? 1 : 0) : client.archived;
    db.prepare('UPDATE users SET name = ?, goal = ?, archived = ? WHERE id = ?').run(name, goal, archived, client.id);
    if (archived) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(client.id);
    return accessClient(coach, client.id);
  });

  route('DELETE', '/api/clients/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const client = accessClient(coach, id(ctx.params.id));
    db.prepare('DELETE FROM users WHERE id = ?').run(client.id);
    return { ok: true };
  });

  // ================= exercise library =================

  const exerciseFields = (body) => ({
    name: str(body.name, 'نام حرکت', { required: true, max: 200 }),
    category: str(body.category, 'دسته', { max: 100 }),
    video_url: str(body.video_url, 'لینک ویدیو', { max: 500 }),
    instructions: str(body.instructions, 'توضیحات', { max: 4000 }),
  });

  route('GET', '/api/exercises', (ctx) => {
    const coach = requireCoach(ctx);
    const q = `%${ctx.query.get('q') ?? ''}%`;
    return db.prepare(`SELECT * FROM exercises WHERE coach_id = ? AND (name LIKE ? OR category LIKE ?)
      ORDER BY category, name`).all(coach.id, q, q);
  });

  route('POST', '/api/exercises', (ctx) => {
    const coach = requireCoach(ctx);
    const f = exerciseFields(ctx.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO exercises (coach_id, name, category, video_url, instructions)
      VALUES (?, ?, ?, ?, ?)`).run(coach.id, f.name, f.category, f.video_url, f.instructions);
    return created(ownExercise(coach.id, Number(lastInsertRowid)));
  });

  route('POST', '/api/exercises/import-defaults', (ctx) => {
    const coach = requireCoach(ctx);
    return { added: tx(db, () => importDefaultExercises(db, coach.id)) };
  });

  route('PUT', '/api/exercises/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const ex = ownExercise(coach.id, id(ctx.params.id));
    const f = exerciseFields({ ...ex, ...ctx.body });
    db.prepare(`UPDATE exercises SET name = ?, category = ?, video_url = ?, instructions = ? WHERE id = ?`)
      .run(f.name, f.category, f.video_url, f.instructions, ex.id);
    return ownExercise(coach.id, ex.id);
  });

  route('DELETE', '/api/exercises/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const ex = ownExercise(coach.id, id(ctx.params.id));
    db.prepare('DELETE FROM exercises WHERE id = ?').run(ex.id);
    return { ok: true };
  });

  // ================= workouts =================

  route('GET', '/api/workouts', (ctx) => {
    const user = requireUser(ctx);
    const clientId = user.role === 'client' ? user.id : id(ctx.query.get('client_id'), 'شاگرد');
    accessClient(user, clientId);
    const from = ctx.query.get('from') ? date(ctx.query.get('from')) : today(-14);
    const to = ctx.query.get('to') ? date(ctx.query.get('to')) : today(28);
    const workouts = db.prepare(`SELECT * FROM workouts WHERE client_id = ? AND date BETWEEN ? AND ?
      ORDER BY date, id`).all(clientId, from, to);
    const counts = db.prepare('SELECT COUNT(*) AS n FROM workout_items WHERE workout_id = ?');
    return workouts.map((w) => ({ ...w, item_count: counts.get(w.id).n }));
  });

  route('GET', '/api/workouts/:id', (ctx) => {
    const user = requireUser(ctx);
    const w = accessWorkout(user, id(ctx.params.id));
    return workoutWithItems(w.id);
  });

  route('POST', '/api/workouts', (ctx) => {
    const coach = requireCoach(ctx);
    const client = accessClient(coach, id(ctx.body.client_id, 'شاگرد'));
    const workoutId = createWorkout(coach.id, client.id, {
      date: date(ctx.body.date),
      title: str(ctx.body.title, 'عنوان', { required: true, max: 200 }),
      notes: str(ctx.body.notes, 'یادداشت', { max: 4000 }),
      items: cleanItems(coach.id, ctx.body.items),
    });
    return created(workoutWithItems(workoutId));
  });

  route('PUT', '/api/workouts/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const w = accessWorkout(coach, id(ctx.params.id));
    const b = ctx.body;
    const next = {
      date: b.date !== undefined ? date(b.date) : w.date,
      title: b.title !== undefined ? str(b.title, 'عنوان', { required: true, max: 200 }) : w.title,
      notes: b.notes !== undefined ? str(b.notes, 'یادداشت', { max: 4000 }) : w.notes,
    };
    const items = b.items !== undefined ? cleanItems(coach.id, b.items) : null;
    tx(db, () => {
      db.prepare('UPDATE workouts SET date = ?, title = ?, notes = ? WHERE id = ?').run(next.date, next.title, next.notes, w.id);
      if (items) {
        db.prepare('DELETE FROM workout_items WHERE workout_id = ?').run(w.id);
        insertItems(w.id, items);
      }
    });
    return workoutWithItems(w.id);
  });

  route('DELETE', '/api/workouts/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const w = accessWorkout(coach, id(ctx.params.id));
    db.prepare('DELETE FROM workouts WHERE id = ?').run(w.id);
    return { ok: true };
  });

  route('POST', '/api/workouts/:id/copy', (ctx) => {
    const coach = requireCoach(ctx);
    const src = workoutWithItems(accessWorkout(coach, id(ctx.params.id)).id);
    const clientId = ctx.body.client_id ? accessClient(coach, id(ctx.body.client_id, 'شاگرد')).id : src.client_id;
    const newId = createWorkout(coach.id, clientId, {
      date: date(ctx.body.date), title: src.title, notes: src.notes, items: src.items,
    });
    return created(workoutWithItems(newId));
  });

  /** Client (or coach on their behalf) logs results and marks the workout completed / missed / planned. */
  route('POST', '/api/workouts/:id/log', (ctx) => {
    const user = requireUser(ctx);
    const w = accessWorkout(user, id(ctx.params.id));
    const status = ctx.body.status ?? 'completed';
    if (!['completed', 'missed', 'planned'].includes(status)) throw new HttpError(400, 'وضعیت نامعتبر است');
    const comment = ctx.body.comment !== undefined ? str(ctx.body.comment, 'نظر', { max: 4000 }) : w.client_comment;
    const results = ctx.body.results ?? {};
    if (typeof results !== 'object' || Array.isArray(results)) throw new HttpError(400, 'نتایج نامعتبر است');
    tx(db, () => {
      const setResult = db.prepare('UPDATE workout_items SET result = ? WHERE id = ? AND workout_id = ?');
      for (const [itemId, value] of Object.entries(results)) setResult.run(str(value, 'نتیجه', { max: 1000 }), id(itemId), w.id);
      db.prepare(`UPDATE workouts SET status = ?, client_comment = ?,
        completed_at = CASE WHEN ? = 'planned' THEN NULL ELSE datetime('now') END WHERE id = ?`)
        .run(status, comment, status, w.id);
    });
    return workoutWithItems(w.id);
  });

  route('POST', '/api/workouts/:id/save-template', (ctx) => {
    const coach = requireCoach(ctx);
    const w = workoutWithItems(accessWorkout(coach, id(ctx.params.id)).id);
    const title = str(ctx.body.title ?? w.title, 'عنوان', { required: true, max: 200 });
    const items = w.items.map(({ exercise_id, name, sets, reps, load, rest, notes }) =>
      ({ exercise_id, name, sets, reps, load, rest, notes }));
    const { lastInsertRowid } = db.prepare('INSERT INTO templates (coach_id, title, notes, items_json) VALUES (?, ?, ?, ?)')
      .run(coach.id, title, w.notes, JSON.stringify(items));
    return created(templateOut(ownTemplate(coach.id, Number(lastInsertRowid))));
  });

  // ================= templates (workout library) =================

  const templateOut = (t) => ({ id: t.id, title: t.title, notes: t.notes, items: JSON.parse(t.items_json) });

  route('GET', '/api/templates', (ctx) => {
    const coach = requireCoach(ctx);
    return db.prepare('SELECT * FROM templates WHERE coach_id = ? ORDER BY title').all(coach.id).map(templateOut);
  });

  route('POST', '/api/templates', (ctx) => {
    const coach = requireCoach(ctx);
    const title = str(ctx.body.title, 'عنوان', { required: true, max: 200 });
    const notes = str(ctx.body.notes, 'یادداشت', { max: 4000 });
    const items = cleanItems(coach.id, ctx.body.items);
    const { lastInsertRowid } = db.prepare('INSERT INTO templates (coach_id, title, notes, items_json) VALUES (?, ?, ?, ?)')
      .run(coach.id, title, notes, JSON.stringify(items));
    return created(templateOut(ownTemplate(coach.id, Number(lastInsertRowid))));
  });

  route('PUT', '/api/templates/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const t = templateOut(ownTemplate(coach.id, id(ctx.params.id)));
    const title = ctx.body.title !== undefined ? str(ctx.body.title, 'عنوان', { required: true, max: 200 }) : t.title;
    const notes = ctx.body.notes !== undefined ? str(ctx.body.notes, 'یادداشت', { max: 4000 }) : t.notes;
    const items = ctx.body.items !== undefined ? cleanItems(coach.id, ctx.body.items) : t.items;
    db.prepare('UPDATE templates SET title = ?, notes = ?, items_json = ? WHERE id = ?').run(title, notes, JSON.stringify(items), t.id);
    return templateOut(ownTemplate(coach.id, t.id));
  });

  route('DELETE', '/api/templates/:id', (ctx) => {
    const coach = requireCoach(ctx);
    const t = ownTemplate(coach.id, id(ctx.params.id));
    db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
    return { ok: true };
  });

  route('POST', '/api/templates/:id/assign', (ctx) => {
    const coach = requireCoach(ctx);
    const t = templateOut(ownTemplate(coach.id, id(ctx.params.id)));
    const client = accessClient(coach, id(ctx.body.client_id, 'شاگرد'));
    // Items may reference exercises deleted since the template was saved; drop those links.
    const items = t.items.map((it) => ({
      ...it,
      exercise_id: it.exercise_id && db.prepare('SELECT 1 FROM exercises WHERE id = ? AND coach_id = ?').get(it.exercise_id, coach.id)
        ? it.exercise_id : null,
    }));
    const workoutId = createWorkout(coach.id, client.id, { date: date(ctx.body.date), title: t.title, notes: t.notes, items });
    return created(workoutWithItems(workoutId));
  });

  // ================= messages =================

  route('GET', '/api/messages', (ctx) => {
    const user = requireUser(ctx);
    const clientId = user.role === 'client' ? user.id : id(ctx.query.get('client_id'), 'شاگرد');
    accessClient(user, clientId);
    db.prepare(`UPDATE messages SET read_at = datetime('now')
      WHERE client_id = ? AND sender_id != ? AND read_at IS NULL`).run(clientId, user.id);
    return db.prepare(`SELECT m.id, m.body, m.created_at, m.sender_id, u.name AS sender_name, u.role AS sender_role
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.client_id = ? ORDER BY m.id`).all(clientId);
  });

  route('POST', '/api/messages', (ctx) => {
    const user = requireUser(ctx);
    const clientId = user.role === 'client' ? user.id : id(ctx.body.client_id, 'شاگرد');
    accessClient(user, clientId);
    const body = str(ctx.body.body, 'متن پیام', { required: true, max: 4000 });
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (client_id, sender_id, body) VALUES (?, ?, ?)')
      .run(clientId, user.id, body);
    return created(db.prepare('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid));
  });

  // ================= body metrics / progress =================

  route('GET', '/api/metrics', (ctx) => {
    const user = requireUser(ctx);
    const clientId = user.role === 'client' ? user.id : id(ctx.query.get('client_id'), 'شاگرد');
    accessClient(user, clientId);
    return db.prepare('SELECT * FROM metrics WHERE client_id = ? ORDER BY date, id').all(clientId);
  });

  route('POST', '/api/metrics', (ctx) => {
    const user = requireUser(ctx);
    const clientId = user.role === 'client' ? user.id : id(ctx.body.client_id, 'شاگرد');
    accessClient(user, clientId);
    const weight = num(ctx.body.weight, 'وزن');
    const bodyFat = num(ctx.body.body_fat, 'درصد چربی');
    if (weight === null && bodyFat === null) throw new HttpError(400, 'حداقل وزن یا درصد چربی را وارد کنید');
    const { lastInsertRowid } = db.prepare('INSERT INTO metrics (client_id, date, weight, body_fat, notes) VALUES (?, ?, ?, ?, ?)')
      .run(clientId, date(ctx.body.date ?? today()), weight, bodyFat, str(ctx.body.notes, 'یادداشت', { max: 1000 }));
    return created(db.prepare('SELECT * FROM metrics WHERE id = ?').get(lastInsertRowid));
  });

  route('DELETE', '/api/metrics/:id', (ctx) => {
    const user = requireUser(ctx);
    const m = db.prepare('SELECT * FROM metrics WHERE id = ?').get(id(ctx.params.id));
    if (!m) throw new HttpError(404, 'رکورد پیدا نشد');
    accessClient(user, m.client_id);
    db.prepare('DELETE FROM metrics WHERE id = ?').run(m.id);
    return { ok: true };
  });

  // ================= request handling =================

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'درخواست بیش از حد بزرگ است'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'JSON نامعتبر است'));
      }
    });
    req.on('error', reject);
  });

  const serveStatic = async (res, pathname) => {
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    let file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !extname(file)) file = join(PUBLIC_DIR, 'index.html');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  };

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      return serveStatic(res, url.pathname);
    }

    const cookies = [];
    const send = (status, body) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (cookies.length) headers['Set-Cookie'] = cookies;
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    try {
      let match = null;
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
        break;
      }
      if (!match) throw new HttpError(methodMismatch ? 405 : 404, 'مسیر پیدا نشد');

      // Basic CSRF defense for cookie auth: state-changing requests must be JSON (forces a CORS preflight cross-origin).
      if (req.method !== 'GET' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'Content-Type باید application/json باشد');
      }

      const token = parseCookies(req.headers.cookie).sid;
      const ctx = {
        token,
        user: sessionUser(db, token),
        params: match.params,
        query: url.searchParams,
        body: req.method === 'GET' ? {} : await readBody(req),
        setCookie: (c) => cookies.push(c),
      };
      const result = await match.r.handler(ctx);
      if (result?.[CREATED]) send(201, result.body);
      else send(200, result);
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      console.error(err);
      send(500, { error: 'خطای داخلی سرور' });
    }
  };
}
