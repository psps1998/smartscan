// Admin dashboard for database management. Mounted at /admin by server.js.
// Separate login (ADMIN_USER / ADMIN_PASSWORD from .env); disabled entirely when ADMIN_PASSWORD is not set.
import express from 'express';
import { createHmac, createHash, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_MS = 8 * 3600 * 1000;
const HIDDEN_KEYS = ['password_hash']; // settings rows the dashboard must never show or change

export function mountAdmin(app, db) {
  const USER = process.env.ADMIN_USER || 'admin', PASS = process.env.ADMIN_PASSWORD;
  const router = express.Router();
  app.use('/admin', router);
  if (!PASS) {
    router.use((_req, res) => res.status(503).send('Admin dashboard is disabled. Set ADMIN_PASSWORD in .env and restart to enable it.'));
    return;
  }

  const KEY = createHmac('sha256', process.env.SESSION_SECRET || 'smartscan').update(`admin:${PASS}`).digest();
  const sign = (s) => createHmac('sha256', KEY).update(s).digest('base64url');
  const h = (s) => createHash('sha256').update(String(s)).digest();
  const safeEq = (a, b) => timingSafeEqual(h(a), h(b));
  const authed = (req) => {
    const m = /(?:^|;\s*)ss_admin=([^;]+)/.exec(req.headers.cookie || '');
    const [exp, sig] = (m ? m[1] : '').split('.');
    return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now();
  };
  const flags = (req) => `Path=/admin; HttpOnly; SameSite=Strict${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
  const failures = new Map();

  router.get('/', (_req, res) => res.sendFile('index.html', { root: HERE }));
  router.get('/api/session', (req, res) => res.json({ loggedIn: authed(req) }));
  router.post('/api/login', (req, res) => {
    const f = failures.get(req.ip);
    if (f && f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const { user, password } = req.body || {};
    if (!safeEq(user ?? '', USER) || !safeEq(password ?? '', PASS)) {
      failures.set(req.ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 5 * 60000 });
      return res.status(401).json({ error: 'Invalid admin user or password.' });
    }
    failures.delete(req.ip);
    const exp = Date.now() + SESSION_MS;
    res.setHeader('Set-Cookie', `ss_admin=${exp}.${sign(String(exp))}; ${flags(req)}; Max-Age=${SESSION_MS / 1000}`);
    res.json({ ok: true });
  });
  router.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', `ss_admin=; ${flags(req)}; Max-Age=0`); res.json({ ok: true }); });

  router.use('/api', (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'Not logged in' }));

  const q = (n) => `"${String(n).replace(/"/g, '""')}"`;
  const tableNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const columns = (t) => db.prepare(`PRAGMA table_info(${q(t)})`).all();
  const hiddenRow = (t, row) => t === 'settings' && HIDDEN_KEYS.includes(row?.key);
  // Resolve :t against the real table list (never interpolate the raw param).
  router.param('t', (req, res, next, t) => tableNames().includes(t) ? next() : res.status(404).json({ error: 'Unknown table' }));

  // Turn submitted values into a { column: value } map limited to real columns.
  const cleanValues = (t, input) => {
    const out = {};
    for (const c of columns(t)) {
      if (!(c.name in (input || {}))) continue;
      if (t === 'users' && ['password_hash', 'activation_token'].includes(c.name) && input[c.name] === '(hidden)') continue; // masked in the grid; leave unchanged
      let v = input[c.name];
      if (v === null || v === undefined || v === '') v = c.notnull && !c.dflt_value && c.type.toUpperCase().includes('TEXT') ? '' : null;
      out[c.name] = v;
    }
    return out;
  };
  const fail = (res, e) => res.status(400).json({ error: String(e.message || e) });

  router.get('/api/tables', (_req, res) =>
    res.json(tableNames().map((name) => ({ name, count: db.prepare(`SELECT COUNT(*) n FROM ${q(name)}`).get().n }))));

  router.get('/api/table/:t', (req, res) => {
    const t = req.params.t, cols = columns(t);
    const size = Math.min(200, Math.max(5, Number(req.query.size) || 25)), page = Math.max(1, Number(req.query.page) || 1);
    const term = String(req.query.q || '').trim();
    const where = term ? `WHERE ${cols.map((c) => `CAST(${q(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')}` : '';
    const args = term ? cols.map(() => `%${term.replace(/[\\%_]/g, '\\$&')}%`) : [];
    const total = db.prepare(`SELECT COUNT(*) n FROM ${q(t)} ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT rowid AS _rid, * FROM ${q(t)} ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size)
      .filter((r) => !hiddenRow(t, r)).map((r) => t === 'users' ? { ...r, password_hash: '(hidden)', activation_token: r.activation_token && '(hidden)' } : r);
    res.json({ columns: cols.map((c) => ({ name: c.name, type: c.type, pk: !!c.pk, notnull: !!c.notnull })), rows, total, page, size });
  });

  router.post('/api/table/:t', (req, res) => {
    const t = req.params.t, v = cleanValues(t, req.body?.values), keys = Object.keys(v);
    if (t === 'settings' && HIDDEN_KEYS.includes(v.key)) return res.status(403).json({ error: 'That setting cannot be managed here.' });
    try {
      const r = keys.length
        ? db.prepare(`INSERT INTO ${q(t)} (${keys.map(q).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => v[k]))
        : db.prepare(`INSERT INTO ${q(t)} DEFAULT VALUES`).run();
      res.json({ ok: true, rowid: Number(r.lastInsertRowid) });
    } catch (e) { fail(res, e); }
  });

  const existing = (t, rid) => db.prepare(`SELECT rowid AS _rid, * FROM ${q(t)} WHERE rowid = ?`).get(Number(rid));

  router.put('/api/table/:t/:rid', (req, res) => {
    const t = req.params.t, row = existing(t, req.params.rid);
    if (!row) return res.status(404).json({ error: 'Row not found' });
    if (hiddenRow(t, row)) return res.status(403).json({ error: 'That setting cannot be managed here.' });
    const v = cleanValues(t, req.body?.values), keys = Object.keys(v);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
    if (t === 'settings' && HIDDEN_KEYS.includes(v.key)) return res.status(403).json({ error: 'That setting cannot be managed here.' });
    try {
      db.prepare(`UPDATE ${q(t)} SET ${keys.map((k) => `${q(k)} = ?`).join(', ')} WHERE rowid = ?`).run(...keys.map((k) => v[k]), row._rid);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  router.delete('/api/table/:t/:rid', (req, res) => {
    const t = req.params.t, row = existing(t, req.params.rid);
    if (!row) return res.status(404).json({ error: 'Row not found' });
    if (hiddenRow(t, row)) return res.status(403).json({ error: 'That setting cannot be managed here.' });
    try {
      if (t === 'users') {
        // Deleting an account removes everything it owns, children first so the foreign keys stay satisfied.
        db.exec('BEGIN');
        try {
          const u = row.userid, run = (sql) => db.prepare(sql).run(u);
          run('DELETE FROM consumption_log WHERE inventory_id IN (SELECT id FROM inventory WHERE owner = ?)');
          run('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner = ?)');
          for (const tbl of ['invoices', 'inventory', 'categories', 'buyers', 'households', 'user_settings']) run(`DELETE FROM ${tbl} WHERE owner = ?`);
          run('DELETE FROM users WHERE userid = ?');
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      } else db.prepare(`DELETE FROM ${q(t)} WHERE rowid = ?`).run(row._rid);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Account actions (users table = households).
  const userOr404 = (req, res) => {
    const u = db.prepare('SELECT userid, status FROM users WHERE userid = ?').get(req.params.userid);
    if (!u) res.status(404).json({ error: 'User not found' });
    return u;
  };
  router.post('/api/users/:userid/status', (req, res) => {
    const u = userOr404(req, res); if (!u) return;
    const status = req.body?.status;
    if (!['active', 'pending', 'disabled'].includes(status)) return res.status(400).json({ error: 'Status must be active, pending or disabled.' });
    db.prepare("UPDATE users SET status = ?, activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, CURRENT_TIMESTAMP) ELSE activated_at END WHERE userid = ?").run(status, status, u.userid);
    res.json({ ok: true });
  });
  router.post('/api/users/:userid/password', (req, res) => {
    const u = userOr404(req, res); if (!u) return;
    const pw = req.body?.password;
    if (typeof pw !== 'string' || pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const salt = randomBytes(16);
    db.prepare('UPDATE users SET password_hash = ? WHERE userid = ?').run(`${salt.toString('base64')}$${scryptSync(pw, salt, 32).toString('base64')}`, u.userid);
    res.json({ ok: true }); // the new hash also signs the user out of every device
  });

  // Consistent snapshot of the live database as a download.
  router.get('/api/backup', (_req, res) => {
    const dir = mkdtempSync(join(tmpdir(), 'smartscan-'));
    const file = join(dir, 'inventory-backup.db');
    try {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.download(file, `smartscan-${stamp}.db`, () => rmSync(dir, { recursive: true, force: true }));
    } catch (e) { rmSync(dir, { recursive: true, force: true }); fail(res, e); }
  });
}
