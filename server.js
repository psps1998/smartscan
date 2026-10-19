import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createHmac, createHash, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { mountAdmin } from './admin/routes.js';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/inventory.db');
db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, vendor TEXT, invoice_date TEXT,
  printed_total REAL, computed_total REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT, quantity REAL, uom TEXT, rate REAL, amount REAL);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE, description TEXT, uom TEXT,
  quantity REAL DEFAULT 0, last_rate REAL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
PRAGMA foreign_keys = ON;
`);
db.exec(`CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
  budget_pct REAL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
for (const sql of [
  'ALTER TABLE inventory ADD COLUMN min_qty REAL DEFAULT 0',
  'ALTER TABLE invoice_items ADD COLUMN mrp REAL',
  'ALTER TABLE invoices ADD COLUMN discount REAL DEFAULT 0',
  'ALTER TABLE invoices ADD COLUMN tax REAL DEFAULT 0',
  'ALTER TABLE invoices ADD COLUMN buyer_id INTEGER REFERENCES buyers(id)',
  'ALTER TABLE invoice_items ADD COLUMN discount_pct REAL DEFAULT 0',
  'ALTER TABLE invoice_items ADD COLUMN tax_pct REAL DEFAULT 0',
  'ALTER TABLE inventory ADD COLUMN category_id INTEGER REFERENCES categories(id)',
  "ALTER TABLE invoices ADD COLUMN channel TEXT DEFAULT 'offline'",
  'ALTER TABLE invoices ADD COLUMN provider TEXT',
  'ALTER TABLE invoice_items ADD COLUMN category_id INTEGER REFERENCES categories(id)',
  "ALTER TABLE inventory ADD COLUMN used_by TEXT DEFAULT 'everyone'",
  "ALTER TABLE invoice_items ADD COLUMN used_by TEXT DEFAULT 'everyone'",
  "ALTER TABLE inventory ADD COLUMN consumption_type TEXT",
]) { try { db.exec(sql); } catch {} }
// Inventory is valued at the weighted-average purchase rate (seeded from the old last rate).
try { db.exec('ALTER TABLE inventory ADD COLUMN avg_rate REAL'); db.exec('UPDATE inventory SET avg_rate = last_rate'); } catch {}
// quantity is the total purchased; used_qty is what has been used; balance = quantity - used_qty.
// Existing quantities were already net of usage, so fold logged usage back in to keep each balance unchanged.
try {
  db.exec('ALTER TABLE inventory ADD COLUMN used_qty REAL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS consumption_log (
    id INTEGER PRIMARY KEY, inventory_id INTEGER, quantity REAL, consumed_at TEXT DEFAULT (date('now', 'localtime')))`);
  db.exec('UPDATE inventory SET used_qty = COALESCE((SELECT SUM(quantity) FROM consumption_log WHERE inventory_id = inventory.id), 0)');
  db.exec('UPDATE inventory SET quantity = quantity + used_qty');
} catch {}
db.exec(`
CREATE TABLE IF NOT EXISTS consumption_log (
  id INTEGER PRIMARY KEY, inventory_id INTEGER, quantity REAL, consumed_at TEXT DEFAULT (date('now', 'localtime')));
`);
// Per-account settings. rate_includes_tax: 0 = unit rate excludes tax (tax added on top), 1 = unit rate already includes tax.
db.exec('CREATE TABLE IF NOT EXISTS user_settings (owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (owner, key))');
const SETTING_DEFAULTS = { language: 'en', currency: 'INR', rate_includes_tax: '0' };
const LANGUAGES = ['en', 'hi', 'mr', 'es', 'fr', 'de'];
const CURRENCIES = ['USD', 'GBP', 'EUR', 'AUD', 'CAD', 'JPY', 'SGD', 'INR'];
const getSettings = (uid) => {
  const s = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM user_settings WHERE owner = ?').all(uid)) if (r.key in s) s[r.key] = r.value;
  return { language: s.language, currency: s.currency, rate_includes_tax: s.rate_includes_tax === '1' };
};
// Categories every new account starts with (each account then edits its own list and budget shares).
const DEFAULT_CATEGORIES = [
  ['Fruits', 'Apples, bananas, berries, grapes, lemons, melons, oranges, mangoes, papaya, pears, watermelon'],
  ['Vegetables', 'Broccoli, cabbage, carrots, cauliflower, cucumbers, eggplant, garlic, onions, peppers, potatoes, spinach, tomatoes, salad greens'],
  ['Breakfast', 'Cereal, oatmeal, pancake mix, syrup, instant coffee, muffins, grits, protein powder'],
  ['Meat', 'Bacon, chicken, beef, ham, pork, sausage, steak, turkey, deli meat'],
  ['Seafood', 'Fish, crab, lobster, oysters, salmon, shrimp, tuna'],
  ['Frozen Items', 'Ice cream, frozen vegetables and fruit, pizza, fish sticks, frozen meals, waffles, juice concentrate'],
  ['Baby Food', 'Baby cereal, baby food, baby shampoo, diapers, diaper cream, formula, wipes'],
  ['Pets', 'Cat and dog food, cat litter, pet shampoo, treats, flea treatment'],
  ['Flour', 'Flour, sugar, baking powder and soda, cocoa, chocolate chips, yeast, cake mix, shortening, food coloring'],
  ['Snacks', 'Candy, cookies, crackers, chips, nuts, popcorn, pretzels, granola bars, dried fruit, raisins, seeds'],
  ['Bakery Items', 'Bread, bagels, buns, rolls, croissants, donuts, muffins, pastries, pita, tortillas'],
  ['Rice, Wheat, Cereals', 'Rice, pasta, noodles, macaroni, spaghetti, couscous, lasagna, mac & cheese'],
  ['Cans & Jars', 'Canned beans, vegetables, fruit, soup, broth, pasta, jam, peanut butter, pickles, olives, mushrooms'],
  ['Refrigerated', 'Milk, butter, cheese, cream, eggs, yogurt, dips, biscuits, sour cream, salsa, whipped cream'],
  ['Seasoning, Masala', 'Salt, pepper, spices, cinnamon, cumin, curry, paprika, garlic powder, herbs, vanilla extract, marinade'],
  ['Sauces & Condiments', 'Ketchup, mustard, mayonnaise, vinegar, olive oil, vegetable oil, honey, hot sauce, soy sauce, salad dressing, BBQ sauce'],
  ['Beverages & Drinks', 'Beer, wine, coffee, tea, juice, soft drinks, soda, energy drinks, liquor, champagne'],
  ['Paper Products', 'Aluminum foil, coffee filters, cups, garbage bags, napkins, paper plates and towels, plastic bags, straws, plastic wrap'],
  ['Cleaning', 'Air freshener, bleach, dish soap, dishwasher pods, floor cleaner, glass spray, laundry detergent, fabric softener, sponges'],
  ['Personal Care', 'Bath soap, shampoo, conditioner, toothpaste, toothbrush, deodorant, lotion, razors, tissue, toilet tissue, sunscreen, makeup'],
  ['Misc. Items', 'Batteries, charcoal, greeting cards, light bulbs'],
];
// Country-level category sets: the first signup from a country creates its set (COUNTRY_CATEGORIES[cc] if defined, else DEFAULT_CATEGORIES);
// every later account from that country gets the same list. Accounts then edit their own copy and budget shares.
db.exec(`CREATE TABLE IF NOT EXISTS country_categories (
  country TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', PRIMARY KEY (country, code))`);
const COUNTRY_CATEGORIES = {}; // e.g. { IN: [[name, description], ...] } to localise a country's starter list
const countryCategories = (cc) => {
  if (!db.prepare('SELECT 1 FROM country_categories WHERE country = ?').get(cc)) {
    const ins = db.prepare('INSERT INTO country_categories (country, code, name, description) VALUES (?,?,?,?)');
    (COUNTRY_CATEGORIES[cc] || DEFAULT_CATEGORIES).forEach(([name, description], i) => ins.run(cc, `C-${String(i + 1).padStart(3, '0')}`, name, description));
  }
  return db.prepare('SELECT code, name, description FROM country_categories WHERE country = ? ORDER BY code').all(cc);
};
const seedCategories = (uid, cc) => {
  const ins = db.prepare('INSERT INTO categories (owner, code, name, description, budget_pct) VALUES (?,?,?,?,0)');
  for (const c of countryCategories(cc)) ins.run(uid, c.code, c.name, c.description);
};
// Default language and currency by country (limited to LANGUAGES / CURRENCIES); anything unlisted gets English + USD.
const EUR = 'AT BE CY EE FI GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const COUNTRY_DEFAULTS = {
  IN: ['en', 'INR'], US: ['en', 'USD'], GB: ['en', 'GBP'], AU: ['en', 'AUD'], CA: ['en', 'CAD'], SG: ['en', 'SGD'], JP: ['en', 'JPY'],
  DE: ['de', 'EUR'], AT: ['de', 'EUR'], FR: ['fr', 'EUR'], ES: ['es', 'EUR'], MX: ['es', 'USD'], AR: ['es', 'USD'],
  ...Object.fromEntries(EUR.filter((c) => !['AT'].includes(c)).map((c) => [c, ['en', 'EUR']])),
};
const countryDefaults = (cc) => COUNTRY_DEFAULTS[cc] || ['en', 'USD'];
// Country from the caller's IP (ipwho.is, 2 s timeout); falls back to the browser's language region, then India.
async function detectCountry(req) {
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (ip && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(ip)) {
    try {
      const j = await (await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`, { signal: AbortSignal.timeout(2000) })).json();
      if (j.success && /^[A-Z]{2}$/.test(j.country_code)) return j.country_code;
    } catch {}
  }
  const region = /[a-z]{2,3}-([A-Za-z]{2})\b/.exec(req.headers['accept-language'] || '')?.[1];
  return region ? region.toUpperCase() : 'IN';
}
const USED_BY = ['everyone', 'male', 'female', 'children'];
const usedBy = (v) => USED_BY.includes(norm(v)) ? norm(v) : 'everyone';
const CONSUMPTION_TYPES = ['daily', 'frequently', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'occasional'];
const pickConsumption = (v) => CONSUMPTION_TYPES.includes(norm(v)) ? norm(v) : null;
const AGE_GROUPS = ['0-1', '2-6', '7-14', '15-21', '22-28', '29-38', '39-45', '46-55', '56-62', '63-70', '71+'];

const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Consumption recorded against a scanned invoice line (Invoices Scanned tab).
for (const sql of [
  'ALTER TABLE invoice_items ADD COLUMN used_qty REAL DEFAULT 0',
  'ALTER TABLE invoice_items ADD COLUMN used_date TEXT',
  'ALTER TABLE consumption_log ADD COLUMN invoice_item_id INTEGER',
]) { try { db.exec(sql); } catch {} }

const app = express();
app.set('trust proxy', 'loopback'); // behind Caddy: req.ip is the real client IP from X-Forwarded-For
app.use(express.json());

// --- Accounts: every household is a row in `users` (User ID, family name, email, password). Login = User ID + password; signed session cookie. ---
db.exec(`CREATE TABLE IF NOT EXISTS users (
  userid TEXT PRIMARY KEY, family_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', activation_token TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, activated_at TEXT)`);
db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)');
const APP_USER = process.env.APP_USER || 'testscan'; // only used to adopt data from the old single-user setup (see migration below)
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  let v = db.prepare("SELECT value FROM app_meta WHERE key = 'session_secret'").get()?.value;
  if (!v) { v = randomBytes(32).toString('base64url'); db.prepare("INSERT INTO app_meta (key, value) VALUES ('session_secret', ?)").run(v); }
  return v;
})();
const SESSION_KEY = createHmac('sha256', SESSION_SECRET).update('smartscan-session').digest();
const SESSION_MS = 7 * 24 * 3600 * 1000;
const sign = (s) => createHmac('sha256', SESSION_KEY).update(s).digest('base64url');
const safeEq = (a, b) => { const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y); };
const hashPassword = (pw) => { const salt = randomBytes(16); return `${salt.toString('base64')}$${scryptSync(String(pw), salt, 32).toString('base64')}`; };
const verifyPassword = (pw, stored) => {
  const [salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(String(pw ?? ''), Buffer.from(salt, 'base64'), 32), b = Buffer.from(hash, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
};
const DUMMY_HASH = hashPassword(randomBytes(8).toString('hex')); // compared against when the User ID is unknown, so timing doesn't reveal it
const userRow = (id) => db.prepare('SELECT userid, family_name, email, password_hash, status FROM users WHERE userid = ? COLLATE NOCASE').get(String(id ?? '').trim());

// One-time upgrade from the single-household schema: every data table gets an owner (users.userid) and the existing data is
// handed to the account for the old household (the users row whose User ID equals the old household code, else the APP_USER account).
function migrateToAccounts() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const exists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (cols('inventory').includes('owner')) return;
  const count = (t) => (exists(t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 0);
  const oldHousehold = exists('household') ? db.prepare('SELECT * FROM household WHERE id = 1').get() : null;
  const hasData = oldHousehold || ['buyers', 'categories', 'inventory', 'invoices'].some((t) => count(t) > 0);
  let owner = null;
  if (hasData) {
    owner = (oldHousehold?.code && userRow(oldHousehold.code))?.userid;
    if (!owner) {
      const pw = process.env.APP_PASSWORD;
      if (!pw) throw new Error(`Existing data found but no matching account. Sign up as the household first, or set APP_PASSWORD once so the "${APP_USER}" account can adopt it.`);
      owner = APP_USER.toLowerCase();
      const oldHash = exists('settings') ? db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get()?.value : null;
      db.prepare("INSERT OR IGNORE INTO users (userid, family_name, email, password_hash, status, activated_at) VALUES (?,?,?,?,'active',CURRENT_TIMESTAMP)")
        .run(owner, oldHousehold?.family_name || APP_USER, process.env.APP_EMAIL || `${owner}@smartscan.local`, oldHash || hashPassword(pw));
    }
    db.prepare("UPDATE users SET status = 'active', activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP) WHERE userid = ?").run(owner);
  }
  const o = owner;
  db.exec(`VACUUM INTO 'data/inventory.migration-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.db'`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
CREATE TABLE buyers_new (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (owner, code));
CREATE TABLE categories_new (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '',
  budget_pct REAL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (owner, code), UNIQUE (owner, name));
CREATE TABLE inventory_new (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, key TEXT, description TEXT, uom TEXT, quantity REAL DEFAULT 0, last_rate REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, min_qty REAL DEFAULT 0, category_id INTEGER REFERENCES categories(id), used_by TEXT DEFAULT 'everyone',
  consumption_type TEXT, avg_rate REAL, used_qty REAL DEFAULT 0, UNIQUE (owner, key));
CREATE TABLE households (owner TEXT PRIMARY KEY, code TEXT, family_name TEXT, persons INTEGER, children INTEGER, adults INTEGER, males INTEGER,
  females INTEGER, age_groups TEXT, buyers INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
    const own = (t, list) => { if (o) db.prepare(`INSERT INTO ${t}_new (owner, ${list}) SELECT ?, ${list} FROM ${t}`).run(o); };
    own('buyers', 'id, code, name, created_at');
    own('categories', 'id, code, name, description, budget_pct, created_at');
    own('inventory', 'id, key, description, uom, quantity, last_rate, updated_at, min_qty, category_id, used_by, consumption_type, avg_rate, used_qty');
    for (const t of ['buyers', 'categories', 'inventory']) { db.exec(`DROP TABLE ${t}`); db.exec(`ALTER TABLE ${t}_new RENAME TO ${t}`); }
    if (!cols('invoices').includes('owner')) db.exec('ALTER TABLE invoices ADD COLUMN owner TEXT');
    if (o) db.prepare('UPDATE invoices SET owner = ?').run(o);
    if (oldHousehold && o) {
      db.prepare('INSERT INTO households (owner, code, family_name, persons, children, adults, males, females, age_groups, buyers, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(o, o, oldHousehold.family_name, oldHousehold.persons, oldHousehold.children, oldHousehold.adults, oldHousehold.males, oldHousehold.females, oldHousehold.age_groups, oldHousehold.buyers, oldHousehold.updated_at);
      db.prepare('UPDATE users SET family_name = ? WHERE userid = ?').run(oldHousehold.family_name, o);
    }
    if (exists('settings') && o) {
      const put = db.prepare('INSERT OR IGNORE INTO user_settings (owner, key, value) VALUES (?,?,?)');
      for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in SETTING_DEFAULTS) put.run(o, r.key, r.value);
    }
    db.exec('DROP TABLE IF EXISTS household; DROP TABLE IF EXISTS settings;');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  if (o) console.log(`Existing data moved to account "${o}".`);
}
migrateToAccounts();

const sessionCookie = (req) => {
  const m = /(?:^|;\s*)ss_session=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
};
// The cookie holds base64url(userid).expiry.signature; the signature also covers the password hash, so changing the password signs out other devices.
const pwTag = (u) => createHash('sha256').update(u.password_hash).digest('base64url').slice(0, 12);
const sessionToken = (u, exp) => `${Buffer.from(u.userid).toString('base64url')}.${exp}.${sign(`${u.userid}.${exp}.${pwTag(u)}`)}`;
const sessionUser = (req) => {
  const [b64, exp, sig] = sessionCookie(req).split('.');
  if (!sig || !(Number(exp) > Date.now())) return null;
  const u = userRow(Buffer.from(b64, 'base64url').toString());
  return u && u.status === 'active' && safeEq(sig, sign(`${u.userid}.${exp}.${pwTag(u)}`)) ? u : null;
};
const loggedIn = (req) => !!sessionUser(req);
const cookieFlags = (req) => `Path=/; HttpOnly; SameSite=Lax${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
const failures = new Map(); // ip -> { n, until }
app.post('/login', (req, res) => {
  const ip = req.ip, f = failures.get(ip);
  if (f && f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { userid, password } = req.body || {};
  const u = userRow(userid), ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH) && !!u;
  if (!ok) {
    failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 5 * 60000 });
    return res.status(401).json({ error: 'Invalid user id or password.' });
  }
  if (u.status !== 'active') return res.status(403).json({ error: 'This account is disabled. Please contact support.' });
  failures.delete(ip);
  const exp = Date.now() + SESSION_MS;
  res.setHeader('Set-Cookie', `ss_session=${sessionToken(u, exp)}; ${cookieFlags(req)}; Max-Age=${SESSION_MS / 1000}`);
  res.json({ ok: true });
});
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `ss_session=; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/login', (req, res) => loggedIn(req) ? res.redirect('/') : res.sendFile('login.html', { root: 'public' }));
// The landing page and its assets are public; only the API needs a login.
app.get('/session', (req, res) => { const u = sessionUser(req); res.json(u ? { loggedIn: true, userid: u.userid, family_name: u.family_name } : { loggedIn: false }); });
// Public feedback form (no login); max 5 submissions per IP per hour.
db.exec('CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, rating INTEGER, message TEXT NOT NULL, email TEXT)');
const fbHits = new Map(); // ip -> [timestamps]
app.post('/feedback', (req, res) => {
  const now = Date.now(), hits = (fbHits.get(req.ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 5) return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  const message = String(req.body?.message || '').trim().slice(0, 2000), email = String(req.body?.email || '').trim().slice(0, 200);
  const rating = Number(req.body?.rating) || null;
  if (!message) return res.status(400).json({ error: 'Please enter your feedback.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email or leave it blank.' });
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Invalid rating.' });
  fbHits.set(req.ip, [...hits, now]);
  db.prepare('INSERT INTO feedback (rating, message, email) VALUES (?, ?, ?)').run(rating, message, email || null);
  res.json({ ok: true });
});
mountAdmin(app, db); // /admin: database management dashboard (own login, see admin/routes.js)
// Public signup. The account is active straight away. Email activation is a planned later step: create it as 'pending' there and activate it from the emailed link.
const signupHits = new Map(); // ip -> [timestamps]
// The User ID is the account's email address (lowercased). Email activation is still to come.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/signup', async (req, res) => {
  const now = Date.now(), hits = (signupHits.get(req.ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 5) return res.status(429).json({ error: 'Too many signups from this address. Please try again later.' });
  const b = req.body || {}, family = String(b.family_name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (family.length < 2 || family.length > 60) return res.status(400).json({ error: 'Enter your family name (2-60 characters).' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof b.password !== 'string' || b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (b.password !== b.confirm) return res.status(400).json({ error: 'Passwords do not match.' });
  if (db.prepare('SELECT 1 FROM users WHERE userid = ? COLLATE NOCASE OR email = ?').get(email, email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const country = await detectCountry(req), [language, currency] = countryDefaults(country);
  db.exec('BEGIN');
  try {
    db.prepare("INSERT INTO users (userid, family_name, email, password_hash, status, activation_token, activated_at) VALUES (?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)")
      .run(email, family, email, hashPassword(b.password), randomBytes(24).toString('base64url'));
    const put = db.prepare('INSERT INTO user_settings (owner, key, value) VALUES (?,?,?)');
    put.run(email, 'country', country); put.run(email, 'language', language); put.run(email, 'currency', currency);
    seedCategories(email, country);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not create the account.' }); }
  signupHits.set(req.ip, [...hits, now]);
  res.json({ ok: true, userid: email, country });
});
// Every /api route works on the logged-in account's data only: req.uid is the owner used in each query.
app.use('/api', (req, res, next) => {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  req.user = u; req.uid = u.userid;
  next();
});
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const tokens = (s) => new Set(norm(s).replace(/(\d)\s+([a-z])/g, '$1$2').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).map((t) => t.replace(/(es|s)$/, '')));
const similar = (a, b) => {
  const A = tokens(a), B = tokens(b);
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / (A.size + B.size - inter || 1);
};
// Reuse an existing inventory item with the same UOM and a near-identical name (word order, plurals, punctuation).
function findMatch(uid, description, uom) {
  let best = null, bestScore = 0.8;
  for (const r of db.prepare('SELECT * FROM inventory WHERE owner=? AND uom=?').all(uid, uom)) {
    const sc = similar(description, r.description);
    if (sc >= bestScore) { best = r; bestScore = sc; }
  }
  return best;
}
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const PROMPT = `Extract this purchase invoice/receipt as JSON only (no prose, no code fences):
{"is_invoice": boolean, "vendor": string|null, "purchase_channel": "online"|"offline", "provider": string|null, "invoice_date": "YYYY-MM-DD"|null, "printed_total": number|null,
 "invoice_discount": number, "invoice_tax": number,
 "items": [{"description": string, "quantity": number, "uom": string, "mrp": number|null, "rate": number, "tax_pct": number, "amount": number}]}
Rules: "is_invoice" is false if the file is not a purchase invoice/receipt (e.g. a random photo, a blank or unreadable page); then leave items empty. "uom" is the unit of measure used for pricing (kg, g, l, ml, pcs, pack, dozen...). If the pack size/weight is in the
description (e.g. "Rice 5kg"), keep it in the description and use the billed unit as uom (e.g. pcs) unless pricing is per weight.
"mrp" is the printed maximum retail price per uom (Rate 1); null if the invoice does not show one. "rate" is the price per uom
actually charged to the buyer (Rate 2), already net of any item-level discount, before tax. "tax_pct" is the per-item tax
percentage (0 if none shown). "amount" is the line total.
"purchase_channel" is "online" if bought through a website/app/delivery service (order number, delivery fee, platform name), else "offline"
(in-store). For online purchases "provider" is the platform or service provider (e.g. Amazon, Blinkit, Swiggy Instamart); null if offline.
"invoice_discount" and "invoice_tax" are lump-sum amounts applying to the whole invoice (0 if none). Do not list
tax/discount/total lines as items. Use null/0 when unreadable.`;

const USED_BY_PROMPT = `
Also add "used_by" to each item: who the item is for, one of "everyone" (default, most food/household items), "male", "female" or "children" (e.g. baby food, diapers, kids' snacks).`;

// The model may add prose or extra braces around the JSON; take just the first balanced {...} object.
function firstJsonObject(text) {
  const start = text.indexOf('{');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i >= 0 && i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('No JSON found in model response');
}

// Identify the upload by its first bytes (the browser-supplied mimetype can't be trusted); null if not a supported image/PDF.
function sniffType(buf) {
  const h = (s, o = 0) => buf.subarray(o, o + s.length).toString('latin1') === s;
  if (h('%PDF')) return 'application/pdf';
  if (buf[0] === 0x89 && h('PNG', 1)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (h('GIF8')) return 'image/gif';
  if (h('RIFF') && h('WEBP', 8)) return 'image/webp';
  return null;
}

// Sanity-check what the model extracted. Returns { error } when the scan is unusable, else { warnings } to show the user.
function validateScan(out) {
  if (!out || typeof out !== 'object' || out.is_invoice === false)
    return { error: "This doesn't look like a purchase invoice or receipt. Upload a clear photo or PDF of the bill." };
  const warnings = [];
  const items = (Array.isArray(out.items) ? out.items : []).filter((it) => it && norm(it.description));
  if (!items.length)
    return { error: 'No items could be read from this file. Retake the photo (flat, well lit, whole page) or enter the items manually.' };
  out.items = items;
  const seen = new Set();
  items.forEach((it, k) => {
    const name = String(it.description).trim(), at = `Line ${k + 1} (${name})`;
    for (const f of ['quantity', 'rate', 'amount', 'mrp', 'tax_pct']) if (it[f] != null) it[f] = Number(it[f]);
    if (!(it.quantity > 0)) warnings.push(`${at}: quantity is missing or not positive.`);
    if (!(it.rate > 0)) warnings.push(`${at}: rate is missing or not positive.`);
    if (it.tax_pct > 40 || it.tax_pct < 0) warnings.push(`${at}: tax % of ${it.tax_pct} looks wrong.`);
    if (!norm(it.uom)) { it.uom = 'pcs'; warnings.push(`${at}: unit of measure was not found; set to pcs.`); }
    if (it.quantity > 0 && it.rate > 0 && it.amount > 0) {
      const base = it.quantity * it.rate, close = (x) => Math.abs(x - it.amount) <= Math.max(1, x * 0.03);
      if (!close(base) && !close(base * (1 + (it.tax_pct || 0) / 100))) warnings.push(`${at}: amount ${it.amount} does not match quantity × rate (${round(base)}).`);
    }
    const key = norm(name) + '|' + norm(it.uom);
    if (seen.has(key)) warnings.push(`${at}: appears more than once; it may be a duplicated line.`);
    seen.add(key);
  });
  if (!norm(out.vendor)) warnings.push('Vendor name could not be read.');
  if (out.invoice_date != null) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(out.invoice_date) ? new Date(out.invoice_date + 'T00:00:00Z') : null;
    if (!d || isNaN(d)) { warnings.push(`Invoice date "${out.invoice_date}" is not valid; please enter it.`); out.invoice_date = null; }
    else if (d.getTime() > Date.now() + 2 * 86400000) warnings.push(`Invoice date ${out.invoice_date} is in the future.`);
    else if (d.getTime() < Date.now() - 800 * 86400000) warnings.push(`Invoice date ${out.invoice_date} is more than two years old.`);
  } else warnings.push('Invoice date could not be read.');
  const sum = items.reduce((s, it) => s + (Number(it.amount) || 0), 0), printed = Number(out.printed_total);
  if (printed > 0 && sum > 0) {
    const expected = sum - (Number(out.invoice_discount) || 0) + (Number(out.invoice_tax) || 0), tol = Math.max(2, printed * 0.02);
    if (Math.abs(expected - printed) > tol && Math.abs(sum - printed) > tol)
      warnings.push(`Items add up to ${round(sum)} but the printed total is ${printed}; some lines may be missing or misread.`);
  } else if (!(printed > 0)) warnings.push('Printed total could not be read, so the items could not be cross-checked.');
  return { warnings };
}

app.post('/api/scan', upload.single('invoice'), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set. Add it to .env, or enter items manually.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mt = sniffType(req.file.buffer);
    if (!mt) return res.status(400).json({ error: 'Unsupported file. Upload a JPG, PNG, WEBP, GIF or PDF of the invoice.' });
    const data = req.file.buffer.toString('base64');
    const block = mt === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mt, data } }
      : { type: 'image', source: { type: 'base64', media_type: mt, data } };
    const cats = db.prepare('SELECT id, name, description FROM categories WHERE owner=? ORDER BY name').all(req.uid);
    const catPrompt = cats.length
      ? `\nAlso add "category" to each item: exactly one of these names (or null if none fits): ${cats.map((c) => c.description ? `${c.name} (${c.description})` : c.name).join('; ')}.`
      : '';
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT + USED_BY_PROMPT + catPrompt }] }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let out;
    try { out = JSON.parse(firstJsonObject(text)); } catch { return res.status(422).json({ error: 'The invoice could not be read. Try a clearer photo or PDF.' }); }
    const check = validateScan(out);
    if (check.error) return res.status(422).json({ error: check.error });
    for (const it of out.items || []) it.used_by = usedBy(it.used_by);
    for (const it of out.items || []) it.category_id = cats.find((c) => norm(c.name) === norm(it.category))?.id ?? null;
    res.json({ ...out, warnings: check.warnings });
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + e.message });
  }
});

// Save a reviewed invoice and update inventory.
app.post('/api/invoices', (req, res) => {
  const { vendor, invoice_date, printed_total, items } = req.body;
  const channel = norm(req.body.channel) === 'online' ? 'online' : 'offline';
  const provider = channel === 'online' ? String(req.body.provider || '').trim() || null : null;
  const invDiscount = Math.max(0, Number(req.body.invoice_discount) || 0), invTax = Math.max(0, Number(req.body.invoice_tax) || 0);
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items' });
  const uid = req.uid;
  const buyer = db.prepare('SELECT id FROM buyers WHERE id=? AND owner=?').get(Number(req.body.buyer_id) || 0, uid);
  if (!buyer) return res.status(400).json({ error: 'Select the buyer member for this invoice' });
  const taxInRate = getSettings(uid).rate_includes_tax;
  db.exec('BEGIN');
  try {
    const lines = items.filter((i) => norm(i.description)).map((i) => {
      const quantity = Number(i.quantity) || 0, rate = Number(i.rate) || 0;
      const tax_pct = Number(i.tax_pct) || 0, mrp = Number(i.mrp) > 0 ? Number(i.mrp) : null;
      // Rate 2 is the price paid; an item discount exists only when Rate 1 (MRP) is given and higher.
      const discount_pct = mrp && mrp > rate ? round((mrp - rate) / mrp * 100) : 0;
      // The amount may be edited by hand on the scan screen; otherwise it is computed from the rate.
      const amount = i.amount != null && Number.isFinite(Number(i.amount)) ? round(Number(i.amount)) : round(quantity * rate * (taxInRate ? 1 : 1 + tax_pct / 100));
      return { description: i.description.trim(), uom: norm(i.uom) || 'pcs', quantity, mrp, rate, discount_pct, tax_pct, amount, action: i.action, used_by: usedBy(i.used_by), consumption_type: pickConsumption(i.consumption_type),
        category_id: db.prepare('SELECT id FROM categories WHERE id=? AND owner=?').get(Number(i.category_id) || 0, uid)?.id ?? null };
    });
    const missing = lines.find((l) => !l.consumption_type && !findMatch(uid, l.description, l.uom)?.consumption_type);
    if (missing) throw Object.assign(new Error(`Select a Stock In value for "${missing.description}"`), { status: 400 });
    const total = round(lines.reduce((s, l) => s + l.amount, 0) - invDiscount + invTax);
    const inv = db.prepare('INSERT INTO invoices (owner, vendor, invoice_date, printed_total, computed_total, discount, tax, buyer_id, channel, provider) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid, vendor || null, invoice_date || null, printed_total ?? null, total, invDiscount, invTax, buyer.id, channel, provider);
    const insItem = db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, uom, mrp, rate, amount, discount_pct, tax_pct, category_id, used_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    // Adding stock re-weights the average rate: (old qty * old avg + new qty * rate) / total qty.
    const addStock = db.prepare(`UPDATE inventory SET quantity = quantity + ?, last_rate = ?,
      avg_rate = CASE WHEN quantity + ? > 0 THEN (quantity * COALESCE(avg_rate, 0) + ? * ?) / (quantity + ?) ELSE ? END,
      category_id = COALESCE(?, category_id), used_by = COALESCE(?, used_by), consumption_type = COALESCE(?, consumption_type), updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    const setStock = db.prepare('UPDATE inventory SET quantity = ?, used_qty = 0, last_rate = ?, avg_rate = ?, category_id = COALESCE(?, category_id), used_by = COALESCE(?, used_by), consumption_type = COALESCE(?, consumption_type), updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const newItem = db.prepare('INSERT INTO inventory (owner, key, description, uom, quantity, last_rate, avg_rate, category_id, used_by, consumption_type) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const l of lines) {
      insItem.run(inv.lastInsertRowid, l.description, l.quantity, l.uom, l.mrp, l.rate, l.amount, l.discount_pct, l.tax_pct, l.category_id, l.used_by);
      const m = findMatch(uid, l.description, l.uom), ub = l.used_by === 'everyone' ? null : l.used_by;
      if (!m) newItem.run(uid, `${norm(l.description)}|${l.uom}`, l.description, l.uom, l.quantity, l.rate, l.rate, l.category_id, l.used_by, l.consumption_type);
      else if (l.action === 'update') setStock.run(l.quantity, l.rate, l.rate, l.category_id, ub, l.consumption_type, m.id);
      else addStock.run(l.quantity, l.rate, l.quantity, l.quantity, l.rate, l.quantity, l.rate, l.category_id, ub, l.consumption_type, m.id);    }
    db.exec('COMMIT');
    res.json({ id: Number(inv.lastInsertRowid), computed_total: total });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  }
});

// For each scanned line, report the existing inventory item it would merge into (if any).
app.post('/api/check', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  res.json(items.map((i) => {
    if (!norm(i.description)) return null;
    const m = findMatch(req.uid, String(i.description), norm(i.uom) || 'pcs');
    return m && { id: m.id, description: m.description, quantity: m.quantity - (m.used_qty || 0), uom: m.uom, consumption_type: m.consumption_type };
  }));
});

app.get('/api/settings', (req, res) => res.json({ settings: getSettings(req.uid), languages: LANGUAGES, currencies: CURRENCIES }));
app.put('/api/settings', (req, res) => {
  const { language, currency, rate_includes_tax } = req.body;
  if (!LANGUAGES.includes(language)) return res.status(400).json({ error: 'Unknown language' });
  if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Unknown currency' });
  const put = db.prepare('INSERT INTO user_settings (owner, key, value) VALUES (?, ?, ?) ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value');
  put.run(req.uid, 'language', language); put.run(req.uid, 'currency', currency); put.run(req.uid, 'rate_includes_tax', rate_includes_tax ? '1' : '0');
  res.json({ settings: getSettings(req.uid) });
});

app.post('/api/change-password', (req, res) => {
  const ip = `pw:${req.ip}`, f = failures.get(ip);
  if (f && f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { current, next } = req.body || {};
  if (!verifyPassword(current, req.user.password_hash)) {
    failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 5 * 60000 });
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (typeof next !== 'string' || next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  failures.delete(ip);
  const updated = { ...req.user, password_hash: hashPassword(next) };
  db.prepare('UPDATE users SET password_hash = ? WHERE userid = ?').run(updated.password_hash, req.uid);
  // Changing the password invalidates every session, so give this browser a fresh one.
  const exp = Date.now() + SESSION_MS;
  res.setHeader('Set-Cookie', `ss_session=${sessionToken(updated, exp)}; ${cookieFlags(req)}; Max-Age=${SESSION_MS / 1000}`);
  res.json({ ok: true });
});

// The household is the logged-in account: its Unique ID is the User ID and its family name comes from the account record.
app.get('/api/household', (req, res) => {
  const h = db.prepare('SELECT * FROM households WHERE owner=?').get(req.uid);
  res.json({ age_group_labels: AGE_GROUPS, userid: req.uid, family_name: req.user.family_name, household: h && { ...h, age_groups: JSON.parse(h.age_groups) } });
});
app.put('/api/household', (req, res) => {
  const b = req.body, n = (v) => Math.max(0, Math.floor(Number(v) || 0)), uid = req.uid;
  const name = String(b.family_name || '').trim();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Family name is required (2-60 characters)' });
  const persons = n(b.persons), children = n(b.children), adults = n(b.adults), males = n(b.males), females = n(b.females);
  const ages = AGE_GROUPS.map((g) => n(b.age_groups?.[g]));
  const ageSum = ages.reduce((s, v) => s + v, 0);
  if (children + adults !== persons) return res.status(400).json({ error: `Children + adults (${children + adults}) must equal persons (${persons})` });
  if (males + females !== persons) return res.status(400).json({ error: `Males + females (${males + females}) must equal persons (${persons})` });
  if (ageSum !== persons) return res.status(400).json({ error: `Age groups total (${ageSum}) must equal persons (${persons})` });
  const buyers = db.prepare('SELECT COUNT(*) c FROM buyers WHERE owner=?').get(uid).c;
  if (buyers > persons) return res.status(400).json({ error: `There are ${buyers} buyer members registered; persons cannot be fewer` });
  db.prepare('UPDATE users SET family_name=? WHERE userid=?').run(name, uid);
  db.prepare(`INSERT INTO households (owner, code, family_name, persons, children, adults, males, females, age_groups, buyers)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET code=excluded.code, family_name=excluded.family_name,
    persons=excluded.persons, children=excluded.children, adults=excluded.adults, males=excluded.males,
    females=excluded.females, age_groups=excluded.age_groups, buyers=excluded.buyers, updated_at=CURRENT_TIMESTAMP`)
    .run(uid, uid, name, persons, children, adults, males, females, JSON.stringify(Object.fromEntries(AGE_GROUPS.map((g, i) => [g, ages[i]]))), buyers);
  res.json({ ok: true });
});
// Next free "PREFIX-001" style code among this account's rows of a table.
const nextCode = (table, prefix, uid) => {
  const nums = db.prepare(`SELECT code FROM ${table} WHERE owner=?`).all(uid).map((r) => Number(new RegExp(`^${prefix}-(\\d+)$`).exec(r.code)?.[1])).filter(Boolean);
  return `${prefix}-${String(Math.max(0, ...nums) + 1).padStart(3, '0')}`;
};
// Buyer members: each has a unique ID within the household; their number cannot exceed the household's persons.
const nextBuyerCode = (uid) => nextCode('buyers', 'B', uid);
const syncBuyerCount = (uid) => db.prepare('UPDATE households SET buyers=(SELECT COUNT(*) FROM buyers WHERE owner=?) WHERE owner=?').run(uid, uid);
app.get('/api/buyers', (req, res) => {
  const h = db.prepare('SELECT persons FROM households WHERE owner=?').get(req.uid);
  res.json({ buyers: db.prepare('SELECT * FROM buyers WHERE owner=? ORDER BY id').all(req.uid), max: h?.persons ?? 0, next_code: nextBuyerCode(req.uid) });
});
app.post('/api/buyers', (req, res) => {
  const uid = req.uid, h = db.prepare('SELECT persons FROM households WHERE owner=?').get(uid);
  if (!h) return res.status(400).json({ error: 'Set up the household first' });
  if (db.prepare('SELECT COUNT(*) c FROM buyers WHERE owner=?').get(uid).c >= h.persons) return res.status(400).json({ error: `Buyer members cannot exceed the ${h.persons} persons in the household` });
  const name = String(req.body.name || '').trim(), code = String(req.body.code || '').trim() || nextBuyerCode(uid);
  if (!name) return res.status(400).json({ error: 'Member name is required' });
  try {
    const r = db.prepare('INSERT INTO buyers (owner, code, name) VALUES (?,?,?)').run(uid, code, name);
    syncBuyerCount(uid);
    res.json({ id: Number(r.lastInsertRowid), code });
  } catch { res.status(400).json({ error: `Member ID "${code}" already exists` }); }
});
app.delete('/api/buyers/:id', (req, res) => {
  if (db.prepare('SELECT 1 FROM invoices WHERE buyer_id=? AND owner=?').get(req.params.id, req.uid)) return res.status(400).json({ error: 'This member has invoices and cannot be removed' });
  db.prepare('DELETE FROM buyers WHERE id=? AND owner=?').run(req.params.id, req.uid);
  syncBuyerCount(req.uid);
  res.json({ ok: true });
});

// Inventory categories (veggies, dairy, grains, pulses...): unique ID, description, and share of the monthly budget (%).
const nextCategoryCode = (uid) => nextCode('categories', 'C', uid);
function readCategory(body, uid, excludeId = 0) {
  const name = String(body.name || '').trim(), description = String(body.description || '').trim();
  const code = String(body.code || '').trim() || nextCategoryCode(uid), budget_pct = Number(body.budget_pct) || 0;
  if (!name) return { error: 'Category name is required' };
  if (budget_pct < 0 || budget_pct > 100) return { error: 'Monthly budget % must be between 0 and 100' };
  const others = db.prepare('SELECT COALESCE(SUM(budget_pct),0) s FROM categories WHERE owner=? AND id<>?').get(uid, excludeId).s;
  if (others + budget_pct > 100.0001) return { error: `Budget would total ${round(others + budget_pct)}%; only ${round(100 - others)}% is left to allocate` };
  return { code, name, description, budget_pct };
}
const categoryError = (e) => /UNIQUE/i.test(e.message) ? 'Category ID or name already exists' : e.message;
app.get('/api/categories', (req, res) => {
  const categories = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM inventory WHERE category_id=c.id) AS item_count FROM categories c WHERE c.owner=? ORDER BY c.name').all(req.uid);
  res.json({ categories, allocated: round(categories.reduce((s, c) => s + c.budget_pct, 0)), next_code: nextCategoryCode(req.uid) });
});
app.post('/api/categories', (req, res) => {
  const c = readCategory(req.body, req.uid);
  if (c.error) return res.status(400).json({ error: c.error });
  try {
    const r = db.prepare('INSERT INTO categories (owner, code, name, description, budget_pct) VALUES (?,?,?,?,?)').run(req.uid, c.code, c.name, c.description, c.budget_pct);
    res.json({ id: Number(r.lastInsertRowid), code: c.code });
  } catch (e) { res.status(400).json({ error: categoryError(e) }); }
});
app.put('/api/categories/:id', (req, res) => {
  const c = readCategory(req.body, req.uid, Number(req.params.id));
  if (c.error) return res.status(400).json({ error: c.error });
  try {
    db.prepare('UPDATE categories SET code=?, name=?, description=?, budget_pct=? WHERE id=? AND owner=?').run(c.code, c.name, c.description, c.budget_pct, req.params.id, req.uid);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: categoryError(e) }); }
});
app.delete('/api/categories/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM categories WHERE id=? AND owner=?').get(req.params.id, req.uid)) return res.status(404).json({ error: 'Category not found' });
  db.prepare('UPDATE inventory SET category_id=NULL WHERE category_id=? AND owner=?').run(req.params.id, req.uid);
  db.prepare('DELETE FROM categories WHERE id=? AND owner=?').run(req.params.id, req.uid);
  res.json({ ok: true });
});

app.get('/api/invoices', (req, res) => res.json(db.prepare(
  `SELECT i.*, b.code AS buyer_code, b.name AS buyer_name,
    (SELECT group_concat(ii.description || ' ' || COALESCE(c.name, ''), char(10)) FROM invoice_items ii LEFT JOIN categories c ON c.id = ii.category_id WHERE ii.invoice_id = i.id) AS items_text
    FROM invoices i LEFT JOIN buyers b ON b.id=i.buyer_id WHERE i.owner=? ORDER BY i.id DESC`).all(req.uid)));
app.get('/api/invoices/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND owner=?').get(req.params.id, req.uid);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  // Category and Used by are stored per line; the consumption type lives on the matching inventory item.
  const items = db.prepare(`SELECT ii.*, c.name AS category FROM invoice_items ii LEFT JOIN categories c ON c.id = ii.category_id WHERE ii.invoice_id=?`).all(req.params.id)
    .map((x) => {
      const type = findMatch(req.uid, x.description, x.uom)?.consumption_type || null;
      // Rows never saved show the full ordered quantity and the default date until the user saves them.
      return { ...x, consumption_type: type, saved: !!x.used_date, used_qty: x.used_date ? x.used_qty : x.quantity, used_date: x.used_date || defaultUsedDate(inv.invoice_date, type) };
    });
  res.json({ ...inv, items });
});

// Default consumption date: purchase date + the Stock In cycle length - 1 days (daily = purchase date itself).
function defaultUsedDate(invoiceDate, type) {
  const days = { ...CYCLE_DAYS, quarterly: 90 }[type] || 1;
  const d = new Date((/^\d{4}-\d{2}-\d{2}/.test(invoiceDate || '') ? invoiceDate.slice(0, 10) : localToday()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days - 1);
  return d.toISOString().slice(0, 10);
}

// Record quantity consumed (and when) against one invoice line; the change flows into the matching inventory item and consumption log.
app.patch('/api/invoice-items/:id', (req, res) => {
  const it = db.prepare('SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.id=? AND i.owner=?').get(req.params.id, req.uid);
  if (!it) return res.status(404).json({ error: 'Not found' });
  const used = Math.min(Math.max(0, Number(req.body.used_qty) || 0), it.quantity);
  const inv = findMatch(req.uid, it.description, it.uom), delta = used - (it.used_qty || 0);
  const parent = db.prepare('SELECT invoice_date FROM invoices WHERE id=?').get(it.invoice_id);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.used_date || '') ? req.body.used_date : (it.used_date || defaultUsedDate(parent?.invoice_date, inv?.consumption_type));
  db.exec('BEGIN');
  try {
    if (inv && delta) {
      // Never push the inventory balance below zero or its used quantity below zero.
      const cur = db.prepare('SELECT quantity - used_qty AS balance, used_qty FROM inventory WHERE id=?').get(inv.id);
      const applied = delta > 0 ? Math.min(delta, cur.balance) : Math.max(delta, -cur.used_qty);
      db.prepare('UPDATE inventory SET used_qty = used_qty + ?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(applied, inv.id);
      if (applied) db.prepare('INSERT INTO consumption_log (inventory_id, quantity, consumed_at, invoice_item_id) VALUES (?,?,?,?)').run(inv.id, applied, date || localToday(), it.id);
    } else if (inv && date) {
      db.prepare('UPDATE consumption_log SET consumed_at=? WHERE invoice_item_id=?').run(date, it.id);
    }
    db.prepare('UPDATE invoice_items SET used_qty=?, used_date=? WHERE id=?').run(used, date, it.id);
    db.exec('COMMIT');
    const bal = inv && db.prepare('SELECT quantity - used_qty AS b FROM inventory WHERE id=?').get(inv.id).b;
    res.json({ used_qty: used, used_date: date, balance: bal == null ? null : round(bal), uom: it.uom });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inventory', (req, res) => {
  const rows = db.prepare('SELECT * FROM inventory WHERE owner=? ORDER BY description').all(req.uid);
  res.json({ items: rows, total_value: round(rows.reduce((s, r) => s + r.quantity * (r.avg_rate || 0), 0)) });
});
app.patch('/api/inventory/:id', (req, res) => {
  // Changing Used qty by hand is logged as consumption (or a correction) so the overstock report sees it.
  const cur = db.prepare('SELECT used_qty FROM inventory WHERE id=? AND owner=?').get(req.params.id, req.uid);
  if (!cur) return res.status(404).json({ error: 'Item not found' });
  const used = Math.max(0, Number(req.body.used_qty) || 0), delta = used - (cur.used_qty || 0);
  const categoryId = db.prepare('SELECT id FROM categories WHERE id=? AND owner=?').get(Number(req.body.category_id) || 0, req.uid)?.id ?? null;
  if (delta) db.prepare('INSERT INTO consumption_log (inventory_id, quantity) VALUES (?,?)').run(req.params.id, delta);
  db.prepare('UPDATE inventory SET quantity=?, used_qty=?, avg_rate=?, min_qty=COALESCE(?, min_qty), category_id=?, used_by=?, consumption_type=COALESCE(?, consumption_type), updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner=?')
    .run(Number(req.body.quantity) || 0, used, Number(req.body.avg_rate) || 0, req.body.min_qty == null ? null : Number(req.body.min_qty) || 0, categoryId, usedBy(req.body.used_by), pickConsumption(req.body.consumption_type), req.params.id, req.uid);
  res.json({ ok: true });
});
app.post('/api/inventory/:id/consume', (req, res) => {
  const q = Number(req.body.quantity);
  if (!(q > 0)) return res.status(400).json({ error: 'Quantity must be positive' });
  const cur = db.prepare('SELECT quantity - used_qty AS balance FROM inventory WHERE id=? AND owner=?').get(req.params.id, req.uid);
  if (!cur) return res.status(404).json({ error: 'Item not found' });
  db.prepare('UPDATE inventory SET used_qty = used_qty + ?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Math.min(q, cur.balance), req.params.id);
  db.prepare('INSERT INTO consumption_log (inventory_id, quantity) VALUES (?,?)').run(req.params.id, Math.min(q, cur.balance));
  res.json({ ok: true });
});
app.delete('/api/inventory/:id', (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id=? AND owner=?').run(req.params.id, req.uid);
  res.json({ ok: true });
});

// Consumption stats: purchases in a calendar month (first to last day) aggregated per item.
function monthPurchases(q, uid) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`, end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const rows = db.prepare(`SELECT ii.description, ii.uom, c.name AS category, SUM(ii.quantity) AS quantity, SUM(ii.amount) AS value
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id LEFT JOIN categories c ON c.id = ii.category_id
    WHERE i.owner = ? AND COALESCE(i.invoice_date, substr(i.created_at, 1, 10)) BETWEEN ? AND ?
    GROUP BY lower(trim(ii.description)), ii.uom ORDER BY value DESC`).all(uid, start, end);
  return { month, start, end, rows };
}
// Shape rows for the report: share of the total value, rounded.
function compositionReport({ month, start, end }, rows) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return { month, start, end, total: round(total), items: rows.map((r) => ({ ...r, category: r.category || 'Uncategorized',
    quantity: round(r.quantity), value: round(r.value), pct: total ? Math.round(r.value / total * 10000) / 100 : 0 })) };
}
app.get('/api/stats/composition', (req, res) => {
  const p = monthPurchases(req.query.month, req.uid);
  res.json(compositionReport(p, p.rows));
});
// Pattern buying: the month's purchases grouped by the consumption pattern (daily, weekly, ...) of the matching inventory item.
app.get('/api/stats/pattern', (req, res) => {
  const p = monthPurchases(req.query.month, req.uid), groups = new Map();
  for (const r of p.rows) {
    const type = findMatch(req.uid, r.description, r.uom)?.consumption_type || 'unset';
    const g = groups.get(type) || { type, value: 0, items: [] };
    g.value += r.value; g.items.push(r.description); groups.set(type, g);
  }
  const total = [...groups.values()].reduce((s, g) => s + g.value, 0);
  const order = [...CONSUMPTION_TYPES, 'unset'];
  const patterns = [...groups.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    .map((g) => ({ type: g.type, items: g.items, value: round(g.value), pct: total ? Math.round(g.value / total * 10000) / 100 : 0 }));
  res.json({ month: p.month, start: p.start, end: p.end, total: round(total), patterns });
});
// Overstocked: bought during the month but not used (consumed) during that month. Valued at that month's purchase rate.
app.get('/api/stats/overstock', (req, res) => {
  const p = monthPurchases(req.query.month, req.uid);
  const used = db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM consumption_log WHERE inventory_id=? AND consumed_at BETWEEN ? AND ?');
  const rows = [];
  for (const r of p.rows) {
    const inv = findMatch(req.uid, r.description, r.uom);
    const consumed = inv ? used.get(inv.id, p.start, p.end).q : 0;
    // Unused can never exceed what is still in stock, which also covers usage that predates the consumption log.
    const unused = Math.min(r.quantity - Math.min(consumed, r.quantity), inv ? inv.quantity - inv.used_qty : 0);
    if (unused > 0 && r.quantity > 0) rows.push({ ...r, purchased: round(r.quantity), consumed: round(Math.min(consumed, r.quantity)), quantity: unused, value: unused * r.value / r.quantity });
  }
  rows.sort((a, b) => b.value - a.value);
  res.json(compositionReport(p, rows));
});

// Online / offline report: invoices in a month per vendor (the platform for online purchases), with each vendor's share of spend and
// effective discount = (item discounts, i.e. MRP above the rate paid, + invoice-level discount) / gross value before discounts.
app.get('/api/stats/channels', (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`, end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const inv = db.prepare(`SELECT i.id, COALESCE(i.channel, 'offline') AS channel, i.provider, i.vendor, i.computed_total AS spend, COALESCE(i.discount, 0) AS inv_discount,
      COALESCE(SUM(ii.quantity * MAX(COALESCE(ii.mrp, ii.rate), ii.rate)), 0) AS gross,
      COALESCE(SUM(ii.quantity * (MAX(COALESCE(ii.mrp, ii.rate), ii.rate) - ii.rate)), 0) AS item_discount
    FROM invoices i LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE i.owner = ? AND COALESCE(i.invoice_date, substr(i.created_at, 1, 10)) BETWEEN ? AND ? GROUP BY i.id`).all(req.uid, start, end);
  const total = inv.reduce((s, r) => s + (r.spend || 0), 0);
  const group = (keyOf, labelOf) => {
    const g = new Map();
    for (const r of inv) {
      const k = keyOf(r), e = g.get(k) || { ...labelOf(r), purchases: 0, spend: 0, discount: 0, gross: 0 };
      e.purchases++; e.spend += r.spend || 0; e.discount += r.item_discount + r.inv_discount; e.gross += r.gross + r.inv_discount;
      g.set(k, e);
    }
    return [...g.values()].sort((a, b) => b.spend - a.spend).map((e) => ({ ...e, spend: round(e.spend), discount: round(e.discount), gross: round(e.gross),
      pct: total ? Math.round(e.spend / total * 10000) / 100 : 0, discount_pct: e.gross ? Math.round(e.discount / e.gross * 10000) / 100 : 0 }));
  };
  const vendorName = (r) => (r.channel === 'online' ? String(r.provider || r.vendor || '').trim() : String(r.vendor || '').trim()) || 'Unknown';
  res.json({ month, start, end, total: round(total), purchases: inv.length,
    channels: group((r) => r.channel, (r) => ({ channel: r.channel })),
    vendors: group((r) => `${r.channel}|${norm(vendorName(r))}`, (r) => ({ channel: r.channel, vendor: vendorName(r) })) });
});

// AI stats: usage pattern per consumption type, derived from invoices (purchases), the inventory and the consumption log.
// Rule-based insights computed locally; no model call is made.
const USAGE_GROUPS = { daily: ['daily'], frequently: ['frequently', 'weekly', 'fortnightly'], monthly: ['monthly'] };
const CYCLE_DAYS = { daily: 1, frequently: 3, weekly: 7, fortnightly: 14, monthly: 30 };
const isoDay = (d) => d.toLocaleDateString('en-CA');
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 864e5);
app.get('/api/stats/usage', (req, res) => {
  const group = USAGE_GROUPS[req.query.type] ? req.query.type : 'daily', types = USAGE_GROUPS[group];
  const days = [30, 60, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 90;
  const today = isoDay(new Date()), startD = new Date(); startD.setDate(startD.getDate() - days + 1);
  const start = isoDay(startD);
  const items = db.prepare(`SELECT inv.*, c.name AS category FROM inventory inv LEFT JOIN categories c ON c.id = inv.category_id
    WHERE inv.owner = ? AND inv.consumption_type IN (${types.map(() => '?').join(',')})`).all(req.uid, ...types);
  const byId = new Map(items.map((i) => [i.id, { item: i, purchases: [] }]));
  // Attribute every purchase line in the window to its inventory item (same matching as invoice scanning).
  const cache = new Map(), spendByDow = Array(7).fill(0);
  for (const r of db.prepare(`SELECT ii.description, ii.uom, ii.quantity, ii.amount, COALESCE(i.invoice_date, substr(i.created_at, 1, 10)) AS d
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.owner = ? AND COALESCE(i.invoice_date, substr(i.created_at, 1, 10)) BETWEEN ? AND ?`).all(req.uid, start, today)) {
    const k = `${norm(r.description)}|${r.uom}`;
    if (!cache.has(k)) cache.set(k, findMatch(req.uid, r.description, r.uom)?.id ?? null);
    const e = byId.get(cache.get(k));
    if (!e) continue;
    e.purchases.push(r);
    spendByDow[new Date(r.d + 'T00:00').getDay()] += r.amount || 0;
  }
  const logQ = db.prepare('SELECT consumed_at AS d, quantity FROM consumption_log WHERE inventory_id=? AND consumed_at BETWEEN ? AND ?');
  const useByDow = Array(7).fill(0);
  const rows = [], insights = [];
  for (const { item, purchases } of byId.values()) {
    const log = logQ.all(item.id, start, today);
    for (const l of log) useByDow[new Date(l.d + 'T00:00').getDay()] += 1;
    const dates = [...new Set(purchases.map((p) => p.d))].sort();
    const first = [dates[0], log.map((l) => l.d).sort()[0]].filter(Boolean).sort()[0] || start;
    const observed = Math.max(1, dayDiff(first, today) + 1);
    const purchased = purchases.reduce((s, p) => s + (p.quantity || 0), 0), spend = purchases.reduce((s, p) => s + (p.amount || 0), 0);
    const consumed = log.reduce((s, l) => s + l.quantity, 0), perDay = consumed / observed, balance = item.quantity - item.used_qty;
    const gaps = dates.slice(1).map((d, k) => dayDiff(dates[k], d));
    const gap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : null;
    const daysLeft = perDay > 0 ? balance / perDay : null, cycle = CYCLE_DAYS[item.consumption_type];
    let status = 'OK';
    if (balance <= 0) status = 'Out of stock';
    else if (daysLeft != null && daysLeft < cycle) status = 'Restock soon';
    else if (daysLeft != null && daysLeft > cycle * 3 || (perDay === 0 && purchased > 0 && balance > 0)) status = 'Overstocked';
    else if (gap != null && gap < cycle / 2) status = 'Buying too often';
    rows.push({ description: item.description, category: item.category || 'Uncategorized', type: item.consumption_type, uom: item.uom, cycle_days: cycle,
      purchased: round(purchased), purchases: dates.length, spend: round(spend), last_purchase: dates.at(-1) || null, avg_gap_days: gap == null ? null : round(gap),
      consumed: round(consumed), per_day: round(perDay), balance: round(balance), days_left: daysLeft == null ? null : round(daysLeft), status });
  }
  rows.sort((a, b) => b.spend - a.spend);
  const total = rows.reduce((s, r) => s + r.spend, 0);
  rows.forEach((r) => { r.pct = total ? Math.round(r.spend / total * 10000) / 100 : 0; });
  const names = (st) => rows.filter((r) => r.status === st).map((r) => r.description);
  const list = (a) => a.slice(0, 5).join(', ') + (a.length > 5 ? ` and ${a.length - 5} more` : '');
  if (!rows.length) insights.push(`No items are tagged ${types.join(' / ')} in Inventory yet.`);
  else {
    if (total > 0) insights.push(`${rows[0].description} is the biggest spend in this group: ${rows[0].pct}% of ${round(total)} over the last ${days} days.`);
    for (const [st, text] of [['Out of stock', 'Out of stock'], ['Restock soon', 'Likely to run out before their next usual cycle'], ['Overstocked', 'Holding more than 3 usual cycles of stock, or bought with no logged use'], ['Buying too often', 'Bought much more often than their usual cycle']]) {
      const n = names(st);
      if (n.length) insights.push(`${text}: ${list(n)}.`);
    }
    if (rows.every((r) => !r.consumed)) insights.push('No usage has been logged for these items in this period; use the − button in Inventory to record usage and unlock days-of-stock-left.');
  }
  res.json({ type: group, types, days, start, end: today, total: round(total), rows, insights, by_weekday: { spend: spendByDow.map(round), uses: useByDow } });
});

// Probable next monthly order form: stock on hand (purchased - consumed to date) against the expected need for a month.
// Need comes from logged consumption; items with no consumption entered fall back to their average monthly stock-in of previous months.
// Items with no balance left are flagged for restocking. The form is meant to be used in the third week (days 15-21) of the month.
// ?month=YYYY-MM picks the month the order is placed in (this month up to 11 months ahead, default this month); the form is for the
// month after it. For later months, stock on hand is projected forward by the expected need of the months in between.
app.get('/api/orders/nextmonth', (req, res) => {
  const now = new Date(), today = isoDay(now), thisMonth = today.slice(0, 7);
  const monthIdx = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
  const monthAt = (n) => isoDay(new Date(now.getFullYear(), now.getMonth() + n, 1)).slice(0, 7);
  const months = Array.from({ length: 12 }, (_, k) => monthAt(k));
  const orderMonth = months.includes(req.query.month) ? req.query.month : months[0];
  const ahead = monthIdx(orderMonth) - monthIdx(thisMonth), target = monthAt(ahead + 1);
  const items = db.prepare('SELECT inv.*, c.name AS category FROM inventory inv LEFT JOIN categories c ON c.id = inv.category_id WHERE inv.owner = ? ORDER BY inv.description').all(req.uid);
  const stockIn = new Map(items.map((i) => [i.id, []])), cache = new Map();
  for (const r of db.prepare(`SELECT ii.description, ii.uom, ii.quantity, COALESCE(i.invoice_date, substr(i.created_at, 1, 10)) AS d
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.owner = ?`).all(req.uid)) {
    const k = `${norm(r.description)}|${r.uom}`;
    if (!cache.has(k)) cache.set(k, findMatch(req.uid, r.description, r.uom)?.id ?? null);
    stockIn.get(cache.get(k))?.push(r);
  }
  const logStat = db.prepare('SELECT COALESCE(SUM(quantity),0) q, MIN(consumed_at) first FROM consumption_log WHERE inventory_id=?');
  const rows = [];
  for (const it of items) {
    const balance = it.quantity - (it.used_qty || 0), log = logStat.get(it.id);
    let basis, need;
    if (log.q > 0) {
      basis = 'Consumption';
      need = log.q / Math.max(1, dayDiff(log.first, today) / 30);
    } else {
      basis = 'Stock-in pattern';
      const all = stockIn.get(it.id) || [], prev = all.filter((p) => p.d.slice(0, 7) < thisMonth), src = prev.length ? prev : all;
      const first = src.map((p) => p.d.slice(0, 7)).sort()[0];
      const months = !first ? 1 : prev.length ? Math.max(1, monthIdx(thisMonth) - monthIdx(first)) : 1;
      need = src.reduce((s, p) => s + (p.quantity || 0), 0) / months;
    }
    const projected = Math.max(0, balance - need * ahead);
    const order = Math.max(0, Math.ceil(need - projected));
    const status = projected <= 0 ? 'Restock' : order > 0 ? 'Order' : 'Sufficient';
    rows.push({ id: it.id, description: it.description, category: it.category || 'Uncategorized', uom: it.uom, basis,
      purchased: round(it.quantity), consumed: round(it.used_qty || 0), balance: round(projected), monthly_need: round(need),
      order_qty: order, est_cost: round(order * (it.avg_rate || it.last_rate || 0)), status });
  }
  const list = rows.filter((r) => r.status !== 'Sufficient').sort((a, b) => (a.status === 'Restock' ? 0 : 1) - (b.status === 'Restock' ? 0 : 1) || b.est_cost - a.est_cost);
  const day = now.getDate();
  res.json({ today, order_month: orderMonth, target_month: target, months, projected: ahead > 0, in_window: orderMonth === thisMonth && day >= 15 && day <= 21,
    window_start: `${orderMonth}-15`, window_end: `${orderMonth}-21`,
    total: round(list.reduce((s, r) => s + r.est_cost, 0)), skipped: rows.length - list.length, rows: list });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Smartscan running at http://localhost:${port}`));
