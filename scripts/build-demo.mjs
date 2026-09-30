// Builds dist/demo.html: a single-file, browser-only version of the app.
//
// The real server code in src/ runs unchanged inside the page on top of sql.js
// (SQLite compiled to JavaScript). A fetch() shim routes the frontend's /api/*
// calls to it, and the database is saved to localStorage after every change.
//
//   node scripts/build-demo.mjs [--sqljs <url-or-path>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const argIndex = process.argv.indexOf('--sqljs');
const SQLJS_URL = argIndex > 0 ? process.argv[argIndex + 1] : 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm.js';

/** Turns an ES module from src/ into plain script text: drops imports and `export`. */
function stripModule(src) {
  return src
    .replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '')
    .replace(/^export /gm, '')
    .replace(/^const PUBLIC_DIR = .*$/m, "const PUBLIC_DIR = '/';")
    .replace(/^if \(import\.meta\.url[\s\S]*$/m, ''); // seed.js CLI entry
}

const server = ['src/db.js', 'src/auth.js', 'src/app.js', 'src/seed.js'].map((f) => `// ---- ${f}\n${stripModule(read(f))}`).join('\n');
for (const leftover of ['import ', 'import.meta', 'require(']) {
  if (server.includes(leftover)) throw new Error(`bundle still contains "${leftover}"`);
}

const shims = String.raw`
// ---- Node API shims (just enough for src/) ----
const STORE_KEY = 'truecoach-demo-db';
const COOKIE_KEY = 'truecoach-demo-sid';
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const Buffer = {
  from: (h) => ({ h, length: h.length / 2 }),
  concat: (chunks) => ({ toString: () => chunks.join('') }),
};
function randomBytes(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return { toString: () => hex(b) };
}
// Demo-only password hashing (the real server uses scrypt). Data never leaves this browser.
function scryptSync(password, salt, len) {
  let out = '';
  for (let i = 0; out.length < len * 2; i++) {
    let h1 = 0xdeadbeef ^ i, h2 = 0x41c6ce57 ^ i;
    const s = salt + ':' + password;
    for (let r = 0; r < 200; r++) {
      for (let j = 0; j < s.length; j++) {
        const c = s.charCodeAt(j);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    }
    out += (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }
  const h = out.slice(0, len * 2);
  return { h, length: len, toString: () => h };
}
const timingSafeEqual = (a, b) => a.h === b.h;
const mkdirSync = () => {};
const dirname = () => '';

let SQL;
let initialBytes = null;
const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
class DatabaseSync {
  constructor() { this.db = new SQL.Database(initialBytes ?? undefined); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    const query = (params, many) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length) stmt.bind(norm(params));
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
          if (!many) break;
        }
        return rows;
      } finally {
        stmt.free();
      }
    };
    return {
      run: (...p) => {
        db.run(sql, norm(p));
        return { changes: db.getRowsModified(), lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
      },
      get: (...p) => query(p, false)[0],
      all: (...p) => query(p, true),
    };
  }
}
`;

const boot = String.raw`
// ---- in-browser server + fetch shim ----
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const backend = (async () => {
  SQL = await initSqlJs();
  const saved = storage.get(STORE_KEY);
  if (saved) {
    try { initialBytes = fromBase64(saved); } catch { initialBytes = null; }
  }
  let db;
  try {
    db = openDb(':memory:');
  } catch {
    initialBytes = null;
    db = openDb(':memory:');
  }
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) seedDemo(db);
  const persist = () => storage.set(STORE_KEY, toBase64(db.db.export()));
  persist();
  return { handler: createApp(db), persist };
})();

document.documentElement.dir = 'rtl';
document.documentElement.lang = 'fa';
document.getElementById('demo-reset').addEventListener('click', () => {
  storage.set(STORE_KEY, null);
  storage.set(COOKIE_KEY, null);
  location.hash = '#/login';
  location.reload();
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const { handler, persist } = await backend;
  const method = (init.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
  const sid = storage.get(COOKIE_KEY);
  if (sid) headers.cookie = 'sid=' + sid;

  const listeners = {};
  const req = {
    method, headers, url: url.pathname + url.search,
    on(event, cb) {
      listeners[event] = cb;
      if (event === 'end') {
        setTimeout(() => {
          if (init.body) listeners.data?.(String(init.body));
          listeners.end?.();
        });
      }
    },
    destroy() {},
  };
  const response = await new Promise((resolve) => {
    let status = 200, outHeaders = {};
    handler(req, {
      writeHead(s, h = {}) { status = s; outHeaders = h; },
      end(body = '') { resolve({ status, outHeaders, body }); },
    });
  });
  for (const c of [].concat(response.outHeaders['Set-Cookie'] || [])) {
    const m = /^sid=([^;]*);.*Max-Age=(\d+)/.exec(c);
    if (m) storage.set(COOKIE_KEY, m[2] === '0' || !m[1] ? null : m[1]);
  }
  if (method !== 'GET' && response.status < 400) persist();
  return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
};
`;

const body = read('public/index.html').match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/\s*<script type="module" src="\/app\.js"><\/script>/, '');

const html = `<title>ترو کوچ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700&display=swap" rel="stylesheet">
<style>
${read('public/styles.css')}
.demo-note { max-width: 1100px; margin: 0 auto; padding: 0 16px 24px; color: var(--muted); font-size: 0.8rem; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.demo-note button { font-size: 0.8rem; padding: 3px 10px; }
</style>
<div dir="rtl" lang="fa">
${body.trim()}
<p class="demo-note">نسخه‌ی نمایشی: همه‌ی اطلاعات فقط در همین مرورگر ذخیره می‌شود.
  <button type="button" class="ghost" id="demo-reset">بازنشانی داده‌ها</button></p>
</div>
<script src="${SQLJS_URL}"></script>
<script>
(() => {
${shims}
${server}
${boot}
})();
</script>
<script type="module">
${read('public/app.js')}
</script>
`;

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/demo.html', root), html);
console.log(`dist/demo.html written (${(html.length / 1024).toFixed(0)} KB), sql.js from ${SQLJS_URL}`);
