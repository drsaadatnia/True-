import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';

const db = openDb();
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  seedDemo(db);
  console.log('Seeded demo data: coach@demo.com / client@demo.com (password: demo1234)');
}

const port = Number(process.env.PORT) || 3000;
createServer(createApp(db)).listen(port, () => {
  console.log(`TrueCoach clone running at http://localhost:${port}`);
});
