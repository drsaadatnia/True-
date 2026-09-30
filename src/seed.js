import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { openDb, tx } from './db.js';
import { today } from './app.js';

const EXERCISES = [
  ['اسکات با هالتر', 'پا', 'https://www.youtube.com/watch?v=ultWZbUMPL8', 'پاها به عرض شانه، کمر صاف، تا موازی زمین پایین بروید.'],
  ['ددلیفت رومانیایی', 'پا', '', 'زانوها کمی خم، باسن را به عقب ببرید و هالتر را نزدیک پا نگه دارید.'],
  ['پرس سینه با هالتر', 'سینه', 'https://www.youtube.com/watch?v=rT7DgCr-3pg', 'کتف‌ها جمع، هالتر تا وسط سینه پایین بیاید.'],
  ['بارفیکس', 'پشت', '', 'از حالت آویزان کامل شروع کنید و چانه را بالای میله ببرید.'],
  ['پارویی دمبل تک‌دست', 'پشت', '', 'آرنج را به سمت لگن بکشید، تنه ثابت بماند.'],
  ['پرس سرشانه دمبل', 'شانه', '', 'در حالت نشسته یا ایستاده، دمبل‌ها را بالای سر ببرید.'],
  ['لانج راه‌رفتنی', 'پا', '', 'زانوی جلو پشت نوک پا بماند.'],
  ['پلانک', 'میان‌تنه', '', 'بدن در یک خط صاف، شکم سفت.'],
  ['طناب‌زنی', 'هوازی', '', 'روی پنجه پا، با ریتم ثابت.'],
];

export function seedDemo(db) {
  tx(db, () => {
    const pw = hashPassword('demo1234');
    const addUser = db.prepare(`INSERT INTO users (role, name, email, password_hash, coach_id, goal) VALUES (?, ?, ?, ?, ?, ?)`);
    const coachId = Number(addUser.run('coach', 'مربی نمونه', 'coach@demo.com', pw, null, '').lastInsertRowid);
    const sara = Number(addUser.run('client', 'سارا احمدی', 'client@demo.com', pw, coachId, 'کاهش ۵ کیلو وزن و افزایش قدرت').lastInsertRowid);
    const reza = Number(addUser.run('client', 'رضا کریمی', 'reza@demo.com', pw, coachId, 'آماده‌سازی برای مسابقه پاورلیفتینگ').lastInsertRowid);

    const addEx = db.prepare('INSERT INTO exercises (coach_id, name, category, video_url, instructions) VALUES (?, ?, ?, ?, ?)');
    const ex = EXERCISES.map((e) => ({ id: Number(addEx.run(coachId, ...e).lastInsertRowid), name: e[0] }));
    const item = (i, sets, reps, load = '', rest = '90 ثانیه') => ({ exercise_id: ex[i].id, name: ex[i].name, sets, reps, load, rest, notes: '' });

    const lower = [item(0, '4', '8', '60kg'), item(1, '3', '10', '40kg'), item(6, '3', '12 هر پا'), item(7, '3', '45 ثانیه', '', '30 ثانیه')];
    const upper = [item(2, '4', '8', '40kg'), item(3, '3', 'حداکثر'), item(4, '3', '10', '14kg'), item(5, '3', '10', '10kg')];
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
