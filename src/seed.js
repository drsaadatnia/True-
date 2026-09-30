import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { openDb, tx } from './db.js';
import { today } from './app.js';
import { DEFAULT_EXERCISES, importDefaultExercises } from './exercise-library.js';

export function seedDemo(db) {
  tx(db, () => {
    const pw = hashPassword('demo1234');
    const addUser = db.prepare(`INSERT INTO users (role, name, email, password_hash, coach_id, goal) VALUES (?, ?, ?, ?, ?, ?)`);
    const coachId = Number(addUser.run('coach', 'مربی نمونه', 'coach@demo.com', pw, null, '').lastInsertRowid);
    const sara = Number(addUser.run('client', 'سارا احمدی', 'client@demo.com', pw, coachId, 'کاهش ۵ کیلو وزن و افزایش قدرت').lastInsertRowid);
    const reza = Number(addUser.run('client', 'رضا کریمی', 'reza@demo.com', pw, coachId, 'آماده‌سازی برای مسابقه پاورلیفتینگ').lastInsertRowid);

    importDefaultExercises(db, coachId);
    const findEx = db.prepare('SELECT id, name FROM exercises WHERE coach_id = ? AND name = ?');
    const item = (en, sets, reps, load = '', rest = '90 ثانیه') => {
      const ex = findEx.get(coachId, DEFAULT_EXERCISES.find((e) => e.en === en).name);
      return { exercise_id: ex.id, name: ex.name, sets, reps, load, rest, notes: '' };
    };

    const lower = [item('Back Squat', '4', '8', '60kg'), item('Romanian Deadlift', '3', '10', '40kg'),
      item('Walking Lunge', '3', '12 هر پا'), item('Plank', '3', '45 ثانیه', '', '30 ثانیه')];
    const upper = [item('Barbell Bench Press', '4', '8', '40kg'), item('Pull-up', '3', 'حداکثر'),
      item('One-Arm Dumbbell Row', '3', '10', '14kg'), item('Seated Dumbbell Shoulder Press', '3', '10', '10kg')];
    const addTpl = db.prepare('INSERT INTO templates (coach_id, title, notes, items_json) VALUES (?, ?, ?, ?)');
    addTpl.run(coachId, 'پایین‌تنه A', 'گرم کردن ۱۰ دقیقه‌ای فراموش نشود.', JSON.stringify(lower));
    addTpl.run(coachId, 'بالاتنه A', '', JSON.stringify(upper));

    const addW = db.prepare(`INSERT INTO workouts (coach_id, client_id, date, title, notes, status, client_comment, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const addItem = db.prepare(`INSERT INTO workout_items (workout_id, position, exercise_id, name, sets, reps, load, rest, notes, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const plan = (clientId, offset, title, items, status = 'planned', comment = '') => {
      const done = status === 'planned' ? null : `${today(offset)} 18:00:00`;
      const wid = addW.run(coachId, clientId, today(offset), title, '', status, comment, done).lastInsertRowid;
      items.forEach((it, i) => addItem.run(wid, i, it.exercise_id, it.name, it.sets, it.reps, it.load, it.rest, it.notes,
        status === 'completed' ? `${it.sets}×${it.reps} ${it.load}`.trim() : ''));
    };
    plan(sara, -6, 'پایین‌تنه A', lower, 'completed', 'اسکات سنگین بود ولی خوب پیش رفت 💪');
    plan(sara, -4, 'بالاتنه A', upper, 'completed');
    plan(sara, -2, 'پایین‌تنه A', lower, 'missed', 'متاسفانه مریض بودم');
    plan(sara, 0, 'بالاتنه A', upper);
    plan(sara, 2, 'پایین‌تنه A', lower);
    plan(sara, 4, 'بالاتنه A', upper);
    plan(reza, -3, 'بالاتنه A', upper, 'completed', 'پرس سینه رکورد زدم!');
    plan(reza, -1, 'پایین‌تنه A', lower);

    const addMsg = db.prepare('INSERT INTO messages (client_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)');
    addMsg.run(sara, coachId, 'سلام سارا! برنامه این هفته رو گذاشتم. سوالی بود بپرس.', `${today(-5)} 09:00:00`);
    addMsg.run(sara, sara, 'ممنون! برای ددلیفت وزنه رو بیشتر کنم؟', `${today(-5)} 12:30:00`);

    const addMetric = db.prepare('INSERT INTO metrics (client_id, date, weight, body_fat) VALUES (?, ?, ?, ?)');
    [[-28, 72.5, 29], [-21, 71.8, 28.6], [-14, 71.1, 28.1], [-7, 70.6, 27.5], [0, 70.2, 27.2]]
      .forEach(([d, w, bf]) => addMetric.run(sara, today(d), w, bf));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    console.log('Database already has data; delete data/truecoach.db to reseed.');
  } else {
    seedDemo(db);
    console.log('Seeded. coach@demo.com / client@demo.com — password: demo1234');
  }
}
