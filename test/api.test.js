import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp, today } from '../src/app.js';
import { seedDemo } from '../src/seed.js';

let server;
let base;

before(async () => {
  const db = openDb(':memory:');
  seedDemo(db);
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** Minimal cookie-keeping client. */
function agent() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

async function login(email, password = 'demo1234') {
  const a = agent();
  const r = await a('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200);
  return a;
}

test('rejects unauthenticated and bad logins', async () => {
  const a = agent();
  assert.equal((await a('GET', '/api/me')).status, 401);
  assert.equal((await a('POST', '/api/auth/login', { email: 'coach@demo.com', password: 'nope' })).status, 401);
});

test('coach registration creates a fresh, isolated account', async () => {
  const a = agent();
  const r = await a('POST', '/api/auth/register', { name: 'New Coach', email: 'new@coach.com', password: 'secret1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'coach');
  assert.deepEqual((await a('GET', '/api/clients')).body, []);
  assert.equal((await a('POST', '/api/auth/register', { name: 'x', email: 'NEW@coach.com', password: 'secret1' })).status, 409);
});

test('full coach → client workflow', async () => {
  const coach = await login('coach@demo.com');

  const client = await coach('POST', '/api/clients', { name: 'Ali', email: 'ali@test.com', password: 'secret1', goal: 'strength' });
  assert.equal(client.status, 201);
  const clientId = client.body.id;

  const ex = await coach('POST', '/api/exercises', { name: 'Push-up', category: 'chest' });
  assert.equal(ex.status, 201);

  const w = await coach('POST', '/api/workouts', {
    client_id: clientId, date: today(), title: 'Day 1',
    items: [{ exercise_id: ex.body.id, sets: '3', reps: '10' }, { name: 'Free jog', reps: '10 min' }],
  });
  assert.equal(w.status, 201);
  assert.equal(w.body.items.length, 2);
  assert.equal(w.body.items[0].name, 'Push-up', 'name is filled from the library');

  const ali = await login('ali@test.com', 'secret1');
  const mine = await ali('GET', '/api/workouts');
  assert.equal(mine.body.length, 1);

  const logged = await ali('POST', `/api/workouts/${w.body.id}/log`, {
    status: 'completed', comment: 'felt great', results: { [w.body.items[0].id]: '3x12' },
  });
  assert.equal(logged.status, 200);
  assert.equal(logged.body.status, 'completed');
  assert.equal(logged.body.items[0].result, '3x12');

  // Clients can't edit programming.
  assert.equal((await ali('PUT', `/api/workouts/${w.body.id}`, { title: 'hacked' })).status, 403);

  const stats = await coach('GET', `/api/clients/${clientId}`);
  assert.equal(stats.body.stats.compliance, 100);

  // Messaging both ways with unread tracking.
  await ali('POST', '/api/messages', { body: 'hi coach' });
  assert.equal((await coach('GET', `/api/clients/${clientId}`)).body.stats.unread_messages, 1);
  const thread = await coach('GET', `/api/messages?client_id=${clientId}`);
  assert.equal(thread.body.length, 1);
  assert.equal((await coach('GET', `/api/clients/${clientId}`)).body.stats.unread_messages, 0);

  // Copy & templates.
  const copy = await coach('POST', `/api/workouts/${w.body.id}/copy`, { date: today(7) });
  assert.equal(copy.body.status, 'planned');
  assert.equal(copy.body.items[0].result, '', 'results are not copied');
  const tpl = await coach('POST', `/api/workouts/${w.body.id}/save-template`, { title: 'Starter' });
  const assigned = await coach('POST', `/api/templates/${tpl.body.id}/assign`, { client_id: clientId, date: today(3) });
  assert.equal(assigned.body.items.length, 2);

  // Metrics.
  assert.equal((await ali('POST', '/api/metrics', { weight: 80.5 })).status, 201);
  assert.equal((await coach('GET', `/api/metrics?client_id=${clientId}`)).body.length, 1);
});

test('clients and coaches cannot reach data they do not own', async () => {
  const sara = await login('client@demo.com');
  const reza = await login('reza@demo.com');
  const other = agent();
  await other('POST', '/api/auth/register', { name: 'Other', email: 'other@coach.com', password: 'secret1' });

  const rezaWorkouts = (await reza('GET', '/api/workouts')).body;
  assert.ok(rezaWorkouts.length > 0);
  const rezaWorkout = rezaWorkouts[0].id;
  const rezaId = rezaWorkouts[0].client_id;

  assert.equal((await sara('GET', `/api/workouts/${rezaWorkout}`)).status, 404);
  assert.equal((await sara('POST', `/api/workouts/${rezaWorkout}/log`, { status: 'completed' })).status, 404);
  assert.equal((await sara('GET', '/api/clients')).status, 403);
  assert.equal((await other('GET', `/api/clients/${rezaId}`)).status, 404);
  assert.equal((await other('GET', `/api/workouts/${rezaWorkout}`)).status, 404);
  assert.equal((await other('GET', `/api/messages?client_id=${rezaId}`)).status, 404);

  // Other coach can't reference the demo coach's exercises.
  const coach = await login('coach@demo.com');
  const demoEx = (await coach('GET', '/api/exercises')).body[0].id;
  const c = await other('POST', '/api/clients', { name: 'X', email: 'x@x.com', password: 'secret1' });
  const r = await other('POST', '/api/workouts', { client_id: c.body.id, date: today(), title: 't', items: [{ exercise_id: demoEx }] });
  assert.equal(r.status, 404);
});

test('validation and CSRF guard', async () => {
  const coach = await login('coach@demo.com');
  const clients = (await coach('GET', '/api/clients')).body;
  assert.equal((await coach('POST', '/api/workouts', { client_id: clients[0].id, date: '2024-13-45', title: 't' })).status, 400);
  assert.equal((await coach('POST', '/api/workouts', { client_id: clients[0].id, date: today(), title: '' })).status, 400);

  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

test('dashboard flags clients needing attention', async () => {
  const coach = await login('coach@demo.com');
  const d = await coach('GET', '/api/dashboard');
  assert.equal(d.status, 200);
  assert.ok(d.body.totals.clients >= 2);
  // Reza has an overdue workout and nothing scheduled ahead.
  assert.ok(d.body.needs_attention.some((c) => c.name === 'رضا کریمی'));
});

test('serves the SPA', async () => {
  const res = await fetch(`${base}/clients/5`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<main id="view">/);
  const escape = await fetch(`${base}/../src/db.js`);
  assert.doesNotMatch(await escape.text(), /DatabaseSync/);
});
