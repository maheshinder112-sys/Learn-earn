// Learn and Earn server. Needs env: DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (10+ characters)
const express = require('express'), { Pool } = require('pg'), bcrypt = require('bcryptjs'), crypto = require('crypto'), path = require('path');
const DATABASE_URL = (process.env.DATABASE_URL || '').trim(), ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const AE = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!DATABASE_URL || !AE || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10) { console.error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD (at least 10 characters).'); process.exit(1); }
const PRICE = [999, 2499, 4999, 9999, 14999], DEBIT = [299, 749, 1499, 2999, 4499], COMM = [700, 1750, 3500, 7000, 10500];
const CASHBACK = [1120, 1830, 2980, 3670, 3910], CB_MIN = 5000, LEVEL = ['Marketing', 'Branding', 'Traffic', 'Influence', 'Finance']; // cashback per activated ID; it can move to the wallet once it reaches CB_MIN
const PASSIVE = PRICE.map(p => Math.round(p / 10)), ROOT = 'LRS-LEARN00001';

const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL || '') ? false : { rejectUnauthorized: false } });
const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '400kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src https://www.youtube-nocookie.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  // Block cross-site write requests (CSRF): the Origin must be this site.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Blocked.' }); } catch (e) { return res.status(403).json({ error: 'Blocked.' }); }
  }
  next();
});
// Basic rate limit: at most `max` calls per minute per IP for sensitive routes.
const hits = new Map(); setInterval(() => hits.clear(), 60000).unref();
const limit = max => (req, res, next) => { const k = req.ip + req.path, n = (hits.get(k) || 0) + 1; hits.set(k, n); n > max ? res.status(429).json({ error: 'Too many attempts. Please wait a minute.' }) : next(); };
class E extends Error { constructor(s, m) { super(m); this.s = s; } }
const w = f => (req, res) => f(req, res).catch(e => e.s ? res.status(e.s).json({ error: e.message })
  : e.code === '23505' ? res.status(409).json({ error: 'This email already has an ID.' })
  : (console.error(e), res.status(500).json({ error: 'Server error' })));
async function tx(f) { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await f(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }
const q = (c, s, p) => c.query(s, p).then(r => r.rows);
const num = Number, normCode = c => String(c || '').trim().toUpperCase().replace(/^TRS-/, 'LRS-'), newCode = () => 'LRS-' + Array.from({ length: 10 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
const addTx = (c, uid, type, amt, bal, why) => c.query('INSERT INTO txns(uid,type,amt,bal,why) VALUES($1,$2,$3,$4,$5)', [uid, type, amt, bal, why]);
// Every newly activated ID gets cashback according to its own package level.
async function giveCashback(c, uid, pkg) {
  const [cb] = await q(c, 'UPDATE users SET cashback=cashback+$1 WHERE id=$2 RETURNING cashback', [CASHBACK[pkg], uid]);
  await c.query("INSERT INTO cb_log(uid,type,amt,bal,why) VALUES($1,'credit',$2,$3,$4)", [uid, CASHBACK[pkg], cb.cashback, 'Cashback: ' + LEVEL[pkg] + ' course ID activated']);
}
const earn = (c, uid, amt, why) => c.query('INSERT INTO ledger(uid,amt,why) VALUES($1,$2,$3)', [uid, amt, why]);
// Passive income: credit the sponsor's wallet and their earnings.
async function passive(c, code, amt, why) {
  if (!code || !(amt > 0)) return;
  const [p] = await q(c, "UPDATE users SET wallet=wallet+$1 WHERE code=$2 AND status='active' RETURNING id,wallet", [amt, code]);
  if (!p) return; await addTx(c, p.id, 'credit', amt, p.wallet, why); await earn(c, p.id, amt, why);
}

async function init() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT NOT NULL,pw TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,sponsor TEXT,pkg SMALLINT NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',avatar TEXT,
    wallet NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(wallet>=0),cashback NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(cashback>=0),vip BOOLEAN NOT NULL DEFAULT false,fails INT NOT NULL DEFAULT 0,locked TIMESTAMPTZ,at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,uid INT NOT NULL REFERENCES users(id),exp TIMESTAMPTZ NOT NULL);
  CREATE TABLE IF NOT EXISTS cb_log(id SERIAL PRIMARY KEY,uid INT REFERENCES users(id),type TEXT NOT NULL,amt NUMERIC(12,2) NOT NULL,bal NUMERIC(12,2) NOT NULL,why TEXT,at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS admin_log(id SERIAL PRIMARY KEY,admin INT,action TEXT,target INT,at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS ledger(id SERIAL PRIMARY KEY,uid INT REFERENCES users(id),amt NUMERIC(12,2) NOT NULL,why TEXT,at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS txns(id SERIAL PRIMARY KEY,uid INT REFERENCES users(id),type TEXT NOT NULL,amt NUMERIC(12,2) NOT NULL,bal NUMERIC(12,2) NOT NULL,why TEXT,at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS reqs(id SERIAL PRIMARY KEY,sponsor TEXT NOT NULL,uid INT UNIQUE REFERENCES users(id),pkg SMALLINT NOT NULL,status TEXT DEFAULT 'pending',at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS pwreq(id SERIAL PRIMARY KEY,uid INT REFERENCES users(id),phone TEXT,note TEXT,status TEXT NOT NULL DEFAULT 'pending',at TIMESTAMPTZ DEFAULT now(),done TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS pays(id SERIAL PRIMARY KEY,uid INT REFERENCES users(id),kind TEXT NOT NULL,amt NUMERIC(12,2) NOT NULL CHECK(amt>0),app TEXT,pkg SMALLINT,status TEXT DEFAULT 'pending',at TIMESTAMPTZ DEFAULT now());`);
  // Upgrade tables made by older versions of this server.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS fails INT NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN IF NOT EXISTS locked TIMESTAMPTZ; ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS cashback NUMERIC(12,2) NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN IF NOT EXISTS vip BOOLEAN NOT NULL DEFAULT false;');
  // UTR (UPI transaction number) for every UPI payment. The same UTR cannot be used twice.
  await pool.query("ALTER TABLE pays ADD COLUMN IF NOT EXISTS utr TEXT; CREATE UNIQUE INDEX IF NOT EXISTS pays_utr_once ON pays(utr) WHERE utr IS NOT NULL AND status<>'rejected';");
  // Referral codes moved from TRS- to LRS-. Old codes (and every sponsor link) are converted together, once.
  await pool.query("UPDATE users SET code='LRS-'||substr(code,5) WHERE code LIKE 'TRS-%'; UPDATE users SET sponsor='LRS-'||substr(sponsor,5) WHERE sponsor LIKE 'TRS-%'; UPDATE reqs SET sponsor='LRS-'||substr(sponsor,5) WHERE sponsor LIKE 'TRS-%';");
  setInterval(() => pool.query('DELETE FROM sessions WHERE exp<now()').catch(() => {}), 3600000).unref();
  // The admin account always matches ADMIN_EMAIL / ADMIN_PASSWORD from Render (so a forgotten password can be reset there).
  await pool.query("INSERT INTO users(name,email,phone,pw,code,pkg,status) VALUES('Admin',$1,'0000000000',$2,$3,0,'active') ON CONFLICT (email) DO UPDATE SET pw=EXCLUDED.pw,status='active',fails=0,locked=NULL", [AE, await bcrypt.hash(ADMIN_PASSWORD, 10), ROOT]);
}

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const getSid = req => ((req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/) || [])[1];
const setCookie = (req, res, t, maxAge) => res.append('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}${maxAge != null ? '; Max-Age=' + maxAge : ''}`);
async function startSession(req, res, uid) {
  const t = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO sessions(h,uid,exp) VALUES($1,$2,now()+interval '24 hours')", [sha(t), uid]);
  setCookie(req, res, t); // session cookie: ends when the browser closes, unless the user chooses "stay signed in"
}
const auth = async (req, res, next) => {
  try { const t = getSid(req); if (!t) throw 0;
    const [u] = await q(pool, "SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.h=$1 AND s.exp>now() AND u.status='active'", [sha(t)]); if (!u) throw 0;
    req.u = u; req.sid = t; req.admin = u.email === AE; next();
  } catch (e) { res.status(401).json({ error: 'Please sign in.' }); }
};
const adm = (req, res, next) => req.admin ? next() : res.status(403).json({ error: 'Admin only.' });

app.get('/api/verify', limit(30), w(async (req, res) => {
  const [s] = await q(pool, "SELECT name FROM users WHERE code=$1 AND status='active'", [normCode(req.query.code)]);
  if (!s) throw new E(404, 'Referral code not found.'); res.json({ name: s.name });
}));

// Sign up / direct buy. method 'wallet' = sponsor approves from wallet. 'upi' = pays our QR, admin verifies.
app.get('/api/available', limit(30), w(async (req, res) => {
  if ((await q(pool, 'SELECT 1 FROM users WHERE email=$1', [String(req.query.email || '').toLowerCase()])).length) throw new E(409, 'This email already has an ID. Sign in instead.');
  res.json({ ok: true });
}));
app.post('/api/register', limit(10), w(async (req, res) => {
  const { name, email, phone, password, sponsor, pkg, method, app: ap } = req.body, k = +pkg;
  if (!name || !email || !phone || !password || !(k >= 0 && k < 5)) throw new E(400, 'Fill in all fields.');
  if (String(password).length < 6 || String(password).length > 72) throw new E(400, 'Password needs 6 to 72 characters.');
  if (String(name).length > 60 || String(email).length > 120 || String(phone).length > 20) throw new E(400, 'One of the fields is too long.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new E(400, 'Enter a valid email.');
  if (String(phone).replace(/\D/g, '').length < 10) throw new E(400, 'Enter a 10-digit phone number.');
  if (!['wallet', 'upi'].includes(method)) throw new E(400, 'Choose a payment method.');
  const utr = method === 'upi' ? UTR(req.body.utr) : null;
  const hash = await bcrypt.hash(String(password), 10);
  await tx(async c => {
    if (utr) await utrUsed(c, utr);
    let sp = normCode(sponsor);
    if (sp) { if (!(await q(c, "SELECT 1 FROM users WHERE code=$1 AND status='active'", [sp])).length) throw new E(404, 'LRS code not found.'); }
    else if (method === 'wallet') throw new E(400, 'LRS code is required for Wallet payment.');
    else { const [a] = await q(c, 'SELECT code FROM users WHERE email=$1', [AE]); sp = a ? a.code : ROOT; }
    const [u] = await q(c, 'INSERT INTO users(name,email,phone,pw,code,sponsor,pkg) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [name.trim(), email.toLowerCase(), phone, hash, newCode(), sp, k]);
    if (method === 'wallet') await c.query('INSERT INTO reqs(sponsor,uid,pkg) VALUES($1,$2,$3)', [sp, u.id, k]);
    else await c.query("INSERT INTO pays(uid,kind,amt,app,pkg,utr) VALUES($1,'buy',$2,$3,$4,$5)", [u.id, PRICE[k], String(ap || 'UPI').slice(0, 30), k, utr]);
  });
  res.status(201).json({ ok: true, method });
}));

const UTR = v => { const u = String(v || '').replace(/\s/g, ''); if (!/^\d{12}$/.test(u)) throw new E(400, 'Enter the 12-digit UTR number from your UPI app.'); return u; };
const utrUsed = async (c, u) => { if ((await q(c, "SELECT 1 FROM pays WHERE utr=$1 AND status<>'rejected'", [u])).length) throw new E(409, 'This UTR number has already been used.'); };
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);
app.post('/api/login', limit(60), w(async (req, res) => {
  const [u] = await q(pool, 'SELECT id,pw,status,locked FROM users WHERE email=$1', [String(req.body.email || '').toLowerCase().slice(0, 120)]);
  const ok = await bcrypt.compare(String(req.body.password || '').slice(0, 72), u ? u.pw : DUMMY);
  if (!u || !ok) {
    throw new E(401, 'Email or password is wrong.');
  }
  if (u.status === 'suspended') throw new E(403, 'Your account is suspended. Please contact support.');
  if (u.status !== 'active') throw new E(403, 'Your account is waiting for approval.');
  await pool.query('UPDATE users SET fails=0,locked=NULL WHERE id=$1', [u.id]);
  await startSession(req, res, u.id); res.json({ ok: true });
}));
// Forgot password: the member sends a request; the admin checks it and sets a new password.
// The reply is always the same, so nobody can use this page to find out which emails have an ID.
const digits = p => String(p || '').replace(/\D/g, '').slice(-10);
app.post('/api/forgot', limit(5), w(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120), phone = String(req.body.phone || '').trim().slice(0, 20), note = String(req.body.note || '').trim().slice(0, 200);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new E(400, 'Enter a valid email.');
  if (digits(phone).length < 10) throw new E(400, 'Enter your 10-digit phone number.');
  const [u] = await q(pool, "SELECT id FROM users WHERE email=$1 AND email<>$2 AND status IN ('active','suspended')", [email, AE]);
  if (u) await tx(async c => {
    await c.query("DELETE FROM pwreq WHERE uid=$1 AND status='pending'", [u.id]); // keep only the newest request
    await c.query('INSERT INTO pwreq(uid,phone,note) VALUES($1,$2,$3)', [u.id, phone, note || null]);
  });
  res.json({ ok: true });
}));
app.post('/api/logout', w(async (req, res) => {
  const t = getSid(req); if (t) await pool.query('DELETE FROM sessions WHERE h=$1', [sha(t)]);
  setCookie(req, res, '', 0); res.json({ ok: true });
}));
app.post('/api/remember', auth, w(async (req, res) => {
  await pool.query("UPDATE sessions SET exp=now()+interval '30 days' WHERE h=$1", [sha(req.sid)]);
  setCookie(req, res, req.sid, 30 * 86400); res.json({ ok: true });
}));

const IST = "now() AT TIME ZONE 'Asia/Kolkata'";
app.get('/api/me', auth, w(async (req, res) => {
  const u = req.u;
  const [e] = await q(pool, `SELECT
    COALESCE(SUM(amt) FILTER (WHERE at >= (date_trunc('day',${IST})) AT TIME ZONE 'Asia/Kolkata'),0) AS today,
    COALESCE(SUM(amt) FILTER (WHERE at > now()-interval '7 days'),0) AS d7,
    COALESCE(SUM(amt) FILTER (WHERE at > now()-interval '30 days'),0) AS d30,
    COALESCE(SUM(amt),0) AS total FROM ledger WHERE uid=$1`, [u.id]);
  const chart = await q(pool, `SELECT to_char(d,'DD') AS l, COALESCE(SUM(l.amt),0) AS v
    FROM generate_series((${IST})::date-6,(${IST})::date,'1 day') d
    LEFT JOIN ledger l ON l.uid=$1 AND (l.at AT TIME ZONE 'Asia/Kolkata')::date=d::date GROUP BY d ORDER BY d`, [u.id]);
  const [t] = await q(pool, "SELECT count(*)::int AS n FROM users WHERE sponsor=$1 AND status='active'", [u.code]);
  // Newest pending item ids, so the app can show a red dot until the member has looked at it.
  const [n] = await q(pool, `SELECT (SELECT COALESCE(MAX(r.id),0) FROM reqs r JOIN users x ON x.id=r.uid WHERE r.sponsor=$1 AND r.status='pending' AND x.status='pending')::int AS rq,
    ${req.admin ? "(SELECT COALESCE(MAX(p.id),0) FROM pays p JOIN users x ON x.id=p.uid WHERE p.status='pending' AND x.status<>'rejected')::int" : '0'} AS pay,
    ${req.admin ? "(SELECT COALESCE(MAX(id),0) FROM users WHERE status='pending')::int" : '0'} AS mem,
    ${req.admin ? "(SELECT COALESCE(MAX(id),0) FROM pwreq WHERE status='pending')::int" : '0'} AS rs`, [u.code]);
  const [up] = await q(pool, "SELECT pkg FROM pays WHERE uid=$1 AND kind='upgrade' AND status='pending' ORDER BY id DESC LIMIT 1", [u.id]);
  res.json({ name: u.name, email: u.email, phone: u.phone, code: u.code, pkg: u.pkg, avatar: u.avatar, wallet: num(u.wallet), cashback: num(u.cashback), vip: !!u.vip, admin: req.admin,
    earn: { today: num(e.today), d7: num(e.d7), d30: num(e.d30), total: num(e.total) }, chart: chart.map(r => ({ l: r.l, v: num(r.v) })), team: t.n, upg: up ? up.pkg : null, nt: { rq: n.rq, pay: n.pay, mem: n.mem, rs: n.rs } });
}));
app.put('/api/me', auth, w(async (req, res) => {
  const n = String(req.body.name || '').trim(), p = String(req.body.phone || '').trim(), pw = String(req.body.password || '');
  if (!n || n.length > 60 || p.length > 20 || p.replace(/\D/g, '').length < 10) throw new E(400, 'Enter a valid name and phone.');
  if (pw && (pw.length < 6 || pw.length > 72)) throw new E(400, 'New password needs 6 to 72 characters.');
  await pool.query('UPDATE users SET name=$1,phone=$2 WHERE id=$3', [n, p, req.u.id]);
  if (pw) { // new password: save it and sign out every other device
    await pool.query('UPDATE users SET pw=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), req.u.id]);
    await pool.query('DELETE FROM sessions WHERE uid=$1 AND h<>$2', [req.u.id, sha(req.sid)]);
  }
  res.json({ ok: true, password: !!pw });
}));
app.put('/api/me/avatar', auth, w(async (req, res) => {
  const d = String(req.body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d) || d.length > 300000) throw new E(400, 'Please use a JPG, PNG or WebP image.');
  await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [d, req.u.id]); res.json({ ok: true });
}));
app.delete('/api/me/avatar', auth, w(async (req, res) => { await pool.query('UPDATE users SET avatar=NULL WHERE id=$1', [req.u.id]); res.json({ ok: true }); }));

app.get('/api/team', auth, w(async (req, res) =>
  res.json(await q(pool, "SELECT id,name,vip,phone,email,pkg,at,(avatar IS NOT NULL) AS av FROM users WHERE sponsor=$1 AND status='active' ORDER BY id DESC", [req.u.code]))));
// The mentor (sponsor) who referred the signed-in member.
app.get('/api/mentor', auth, w(async (req, res) => {
  if (!req.u.sponsor) return res.json({ mentor: null });
  const [m] = await q(pool, "SELECT id,name,email,phone,code,status,vip,(avatar IS NOT NULL) AS av FROM users WHERE code=$1", [req.u.sponsor]);
  res.json({ mentor: m && m.status !== 'rejected' ? m : null });
}));
// Profile photo. Visible to the member, their sponsor, the admin, and (for today's top 10) to signed-in members on the leaderboard.
app.get('/api/avatar/:id', auth, w(async (req, res) => {
  const [u] = await q(pool, 'SELECT id,code,sponsor,avatar FROM users WHERE id=$1', [+req.params.id || 0]);
  if (!u || !u.avatar) throw new E(404, 'Not found.');
  if (!(u.id === req.u.id || u.sponsor === req.u.code || u.code === req.u.sponsor || req.admin || (await topToday()).some(r => r.id === u.id))) throw new E(404, 'Not found.');
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(u.avatar);
  if (!m) throw new E(404, 'Not found.');
  res.set('Content-Type', m[1]); res.set('Cache-Control', 'private, max-age=600'); res.send(Buffer.from(m[2], 'base64'));
}));
// Today's top 10 earners (all members). "Today" resets at midnight India time.
// Today's top 10 earners (shared by the leaderboard and its photos). Cached for 30 seconds.
let TOP = { at: 0, rows: [] };
async function topToday() {
  if (Date.now() - TOP.at < 30000) return TOP.rows;
  const rows = await q(pool, `SELECT u.id,u.name,u.vip,(u.avatar IS NOT NULL) AS av,SUM(l.amt) AS amt FROM ledger l JOIN users u ON u.id=l.uid
    WHERE u.status='active' AND u.email<>$1 AND l.at >= (date_trunc('day',${IST})) AT TIME ZONE 'Asia/Kolkata'
    GROUP BY u.id ORDER BY amt DESC, u.id LIMIT 10`, [AE]);
  TOP = { at: Date.now(), rows }; return rows;
}
app.get('/api/leaderboard', auth, w(async (req, res) => {
  res.json((await topToday()).map(r => ({ id: r.id, name: r.name, vip: r.vip, av: !!r.av, amt: num(r.amt) })));
}));

// Upgrade a team member to a higher package. Wallet pays the price difference.
app.post('/api/team/:id/upgrade', auth, w(async (req, res) => {
  const k = +req.body.pkg; if (!(k >= 0 && k < 5)) throw new E(400, 'Invalid package.');
  res.json(await tx(async c => {
    const [me] = await q(c, 'SELECT id,code,sponsor,wallet,name,pkg FROM users WHERE id=$1 FOR UPDATE', [req.u.id]);
    const [m] = await q(c, "SELECT id,name,pkg FROM users WHERE id=$1 AND sponsor=$2 AND status='active' FOR UPDATE", [req.params.id, me.code]);
    if (!m) throw new E(404, 'Member not found.');
    if (k <= m.pkg) throw new E(400, 'You can only upgrade to a higher package.');
    // A member cannot upgrade a team member above their own course. The admin is not limited.
    if (!req.admin && k > me.pkg) throw new E(403, 'The ' + LEVEL[k] + ' course is higher than your course. Upgrade your own course to ' + LEVEL[k] + ' or higher first.');
    const d = DEBIT[k] - DEBIT[m.pkg];
    if (num(me.wallet) < d) throw new E(402, 'Insufficient wallet balance. Please recharge your wallet.');
    const [nw] = await q(c, 'UPDATE users SET wallet=wallet-$1 WHERE id=$2 RETURNING wallet', [d, me.id]);
    await addTx(c, me.id, 'debit', d, nw.wallet, 'Upgrade ' + m.name);
    if (COMM[k] - COMM[m.pkg] > 0) await earn(c, me.id, COMM[k] - COMM[m.pkg], 'Upgrade ' + m.name);
    await c.query('UPDATE users SET pkg=$1 WHERE id=$2', [k, m.id]);
    await passive(c, me.sponsor, PASSIVE[k] - PASSIVE[m.pkg], 'Passive income: ' + me.name + ' upgraded ' + m.name);
    return { wallet: num(nw.wallet) };
  }));
}));

app.get('/api/wallet', auth, w(async (req, res) => res.json({
  balance: num(req.u.wallet), cashback: num(req.u.cashback),
  txns: await q(pool, 'SELECT type,amt,bal,why,at FROM txns WHERE uid=$1 ORDER BY id DESC LIMIT 100', [req.u.id]),
  cb: await q(pool, 'SELECT type,amt,bal,why,at FROM cb_log WHERE uid=$1 ORDER BY id DESC LIMIT 100', [req.u.id]) })));
// Cashback can be moved to the wallet only when it has reached CB_MIN. The whole balance moves.
app.post('/api/wallet/cashback/transfer', auth, w(async (req, res) => {
  res.json(await tx(async c => {
    const [me] = await q(c, 'SELECT id,cashback FROM users WHERE id=$1 FOR UPDATE', [req.u.id]);
    if (num(me.cashback) < CB_MIN) throw new E(400, 'Cashback can be transferred only when it reaches \u20b95,000 or more.');
    const amt = num(me.cashback);
    const [u] = await q(c, 'UPDATE users SET cashback=0, wallet=wallet+$1 WHERE id=$2 RETURNING wallet', [amt, me.id]);
    await addTx(c, me.id, 'credit', amt, u.wallet, 'Cashback transferred to wallet');
    await c.query("INSERT INTO cb_log(uid,type,amt,bal,why) VALUES($1,'transfer',$2,0,'Transferred to wallet')", [me.id, amt]);
    return { wallet: num(u.wallet) };
  }));
}));
app.post('/api/wallet/recharge', auth, limit(20), w(async (req, res) => {
  const a = num(req.body.amount); if (!(a > 0 && a <= 1e6)) throw new E(400, 'Enter a valid amount.');
  if ((await q(pool, "SELECT 1 FROM pays WHERE uid=$1 AND status='pending' AND kind='recharge' OFFSET 4", [req.u.id])).length) throw new E(429, 'You already have several pending recharges. Please wait for them to be verified.');
  const utr = UTR(req.body.utr);
  await tx(async c => { await utrUsed(c, utr); await c.query("INSERT INTO pays(uid,kind,amt,app,utr) VALUES($1,'recharge',$2,$3,$4)", [req.u.id, a, String(req.body.app || 'UPI').slice(0, 30), utr]); });
  res.status(201).json({ ok: true });
}));
app.get('/api/wallet/requests', auth, w(async (req, res) =>
  res.json(await q(pool, "SELECT r.id,r.pkg,r.status,r.at,u.name,u.vip,u.email,u.phone FROM reqs r JOIN users u ON u.id=r.uid WHERE r.sponsor=$1 AND u.status<>'rejected' ORDER BY (r.status='pending') DESC,r.id DESC", [req.u.code]))));

// Approve a wallet account request: wallet debit, activate, earning, passive income. One transaction.
// Reject an account request: the ID is removed everywhere (pending / active / all) and is not counted.
app.post('/api/wallet/requests/:id/reject', auth, w(async (req, res) => {
  res.json(await tx(async c => {
    const [me] = await q(c, 'SELECT id,code FROM users WHERE id=$1', [req.u.id]);
    const [r] = await q(c, "SELECT id,uid FROM reqs WHERE id=$1 AND sponsor=$2 AND status='pending' FOR UPDATE", [req.params.id, me.code]);
    if (!r) throw new E(404, 'Request not found or already handled.');
    await c.query("UPDATE reqs SET status='rejected' WHERE id=$1", [r.id]);
    await c.query("UPDATE users SET status='rejected', email='rejected-'||id||'@removed.invalid' WHERE id=$1 AND status='pending'", [r.uid]);
    await c.query('DELETE FROM sessions WHERE uid=$1', [r.uid]);
    return { ok: true };
  }));
}));

app.post('/api/wallet/requests/:id/approve', auth, w(async (req, res) => {
  res.json(await tx(async c => {
    const [me] = await q(c, 'SELECT id,code,sponsor,wallet,name,pkg FROM users WHERE id=$1 FOR UPDATE', [req.u.id]);
    const [r] = await q(c, "SELECT r.id,r.uid,r.pkg,u.name FROM reqs r JOIN users u ON u.id=r.uid WHERE r.id=$1 AND r.sponsor=$2 AND r.status='pending' FOR UPDATE OF r", [req.params.id, me.code]);
    if (!r) throw new E(404, 'Request not found or already approved.');
    // A member can only approve a course at or below their own course. The admin is not limited.
    if (!req.admin && r.pkg > me.pkg) throw new E(403, 'This request is for the ' + LEVEL[r.pkg] + ' course, which is higher than your course. Upgrade your course to ' + LEVEL[r.pkg] + ' or higher to approve it.');
    if (num(me.wallet) < DEBIT[r.pkg]) throw new E(402, 'Insufficient wallet balance. Please recharge your wallet.');
    const [nw] = await q(c, 'UPDATE users SET wallet=wallet-$1 WHERE id=$2 RETURNING wallet', [DEBIT[r.pkg], me.id]);
    await addTx(c, me.id, 'debit', DEBIT[r.pkg], nw.wallet, 'Account activation: ' + r.name);
    await c.query("UPDATE users SET status='active' WHERE id=$1", [r.uid]);
    await c.query("UPDATE reqs SET status='approved' WHERE id=$1", [r.id]);
    await earn(c, me.id, COMM[r.pkg], 'Activation: ' + r.name);
    await passive(c, me.sponsor, PASSIVE[r.pkg], 'Passive income: ' + me.name + ' activated ' + r.name);
    await giveCashback(c, r.uid, r.pkg);
    return { wallet: num(nw.wallet) };
  }));
}));

// Admin: verify UPI payments after checking the money arrived.
// Admin only: totals from the database (the admin's own account is not counted as a member).
// A member upgrades their own course by UPI. The admin checks the UTR in Verification; on confirm the course is upgraded.
app.post('/api/upgrade', auth, limit(10), w(async (req, res) => {
  const k = +req.body.pkg; if (!(k >= 0 && k < 5)) throw new E(400, 'Invalid course.');
  const utr = UTR(req.body.utr);
  await tx(async c => {
    const [me] = await q(c, "SELECT id,pkg,status FROM users WHERE id=$1 FOR UPDATE", [req.u.id]);
    if (me.status !== 'active') throw new E(403, 'Your ID is not active.');
    if (k <= me.pkg) throw new E(400, 'You can only upgrade to a higher course.');
    if ((await q(c, "SELECT 1 FROM pays WHERE uid=$1 AND kind='upgrade' AND status='pending'", [me.id])).length) throw new E(409, 'You already have an upgrade waiting for verification.');
    await utrUsed(c, utr);
    await c.query("INSERT INTO pays(uid,kind,amt,app,pkg,utr) VALUES($1,'upgrade',$2,$3,$4,$5)", [me.id, PRICE[k] - PRICE[me.pkg], String(req.body.app || 'UPI').slice(0, 30), k, utr]);
  });
  res.status(201).json({ ok: true });
}));
// A member upgrades their own course from their own wallet. The price difference is deducted and the course changes at once.
app.post('/api/upgrade/wallet', auth, limit(10), w(async (req, res) => {
  const k = +req.body.pkg; if (!(k >= 0 && k < 5)) throw new E(400, 'Invalid course.');
  res.json(await tx(async c => {
    const [me] = await q(c, 'SELECT id,pkg,status,wallet FROM users WHERE id=$1 FOR UPDATE', [req.u.id]);
    if (me.status !== 'active') throw new E(403, 'Your ID is not active.');
    if (k <= me.pkg) throw new E(400, 'You can only upgrade to a higher course.');
    if ((await q(c, "SELECT 1 FROM pays WHERE uid=$1 AND kind='upgrade' AND status='pending'", [me.id])).length) throw new E(409, 'You already have an upgrade waiting for verification.');
    const d = PRICE[k] - PRICE[me.pkg];
    if (num(me.wallet) < d) throw new E(402, 'Insufficient wallet balance. Please add funds to your wallet.');
    const [u] = await q(c, 'UPDATE users SET wallet=wallet-$1,pkg=$2 WHERE id=$3 RETURNING wallet', [d, k, me.id]);
    await addTx(c, me.id, 'debit', d, u.wallet, 'Course upgrade to ' + LEVEL[k]);
    return { wallet: num(u.wallet), pkg: k };
  }));
}));
app.get('/api/admin/stats', auth, adm, w(async (req, res) => {
  const [m] = await q(pool, "SELECT count(*)::int AS n FROM users WHERE status='active' AND email<>$1", [AE]);
  const [e] = await q(pool, "SELECT COALESCE(SUM(l.amt),0) AS t FROM ledger l JOIN users u ON u.id=l.uid WHERE u.email<>$1", [AE]);
  res.json({ members: m.n, earnings: num(e.t) });
}));
// Admin only: every member with package and status. Suspend / un-suspend, and VIP on / off.
app.get('/api/admin/members', auth, adm, w(async (req, res) =>
  res.json(await q(pool, `SELECT u.id,u.name,u.email,u.phone,u.code,u.pkg,u.status,u.vip,u.at,u.sponsor,u.wallet,u.cashback,s.name AS sname,
    EXISTS(SELECT 1 FROM reqs r WHERE r.uid=u.id) AS wal,
    (SELECT p.app FROM pays p WHERE p.uid=u.id AND p.kind='buy' ORDER BY p.id DESC LIMIT 1) AS upi,
    (SELECT p.amt FROM pays p WHERE p.uid=u.id AND p.kind='buy' ORDER BY p.id DESC LIMIT 1) AS upiamt
    FROM users u LEFT JOIN users s ON s.code=u.sponsor WHERE u.email<>$1 AND u.status<>'rejected' ORDER BY u.id DESC LIMIT 1000`, [AE]))));
// Admin: everything about one member: balances, earnings, team and latest wallet entries.
app.get('/api/admin/members/:id/full', auth, adm, w(async (req, res) => {
  const [m] = await q(pool, "SELECT id,code,wallet,cashback FROM users WHERE id=$1 AND email<>$2 AND status<>'rejected'", [+req.params.id || 0, AE]);
  if (!m) throw new E(404, 'Member not found.');
  const [e] = await q(pool, `SELECT
    COALESCE(SUM(amt) FILTER (WHERE at >= (date_trunc('day',${IST})) AT TIME ZONE 'Asia/Kolkata'),0) AS today,
    COALESCE(SUM(amt) FILTER (WHERE at > now()-interval '7 days'),0) AS d7,
    COALESCE(SUM(amt) FILTER (WHERE at > now()-interval '30 days'),0) AS d30,
    COALESCE(SUM(amt),0) AS total FROM ledger WHERE uid=$1`, [m.id]);
  const [t] = await q(pool, "SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='pending')::int AS pending FROM users WHERE sponsor=$1", [m.code]);
  const txns = await q(pool, 'SELECT type,amt,bal,why,at FROM txns WHERE uid=$1 ORDER BY id DESC LIMIT 15', [m.id]);
  res.json({ wallet: num(m.wallet), cashback: num(m.cashback), earn: { today: num(e.today), d7: num(e.d7), d30: num(e.d30), total: num(e.total) }, team: t, txns });
}));
// Admin: add money to / deduct money from a member's wallet. Every change is written to the member's wallet log.
app.post('/api/admin/members/:id/wallet', auth, adm, w(async (req, res) => {
  const t = req.body.type, a = Math.round(num(req.body.amount) * 100) / 100, why = String(req.body.reason || '').trim().slice(0, 120);
  if (!['add', 'deduct'].includes(t)) throw new E(400, 'Choose add or deduct.');
  if (!(a > 0 && a <= 1e7)) throw new E(400, 'Enter a valid amount.');
  res.json(await tx(async c => {
    const [m] = await q(c, "SELECT id,wallet FROM users WHERE id=$1 AND email<>$2 AND status<>'rejected' FOR UPDATE", [+req.params.id || 0, AE]);
    if (!m) throw new E(404, 'Member not found.');
    if (t === 'deduct' && a > num(m.wallet)) throw new E(400, 'The wallet has only \u20b9' + num(m.wallet).toLocaleString('en-IN') + '. You cannot deduct more than that.');
    const [u] = await q(c, 'UPDATE users SET wallet=wallet' + (t === 'add' ? '+' : '-') + '$1 WHERE id=$2 RETURNING wallet', [a, m.id]);
    await addTx(c, m.id, t === 'add' ? 'credit' : 'debit', a, u.wallet, (t === 'add' ? 'Added by admin' : 'Deducted by admin') + (why ? ': ' + why : ''));
    await c.query('INSERT INTO admin_log(admin,action,target) VALUES($1,$2,$3)', [req.u.id, 'wallet ' + t + ' ' + a, m.id]);
    return { wallet: num(u.wallet) };
  }));
}));
// Admin: add to / deduct from a member's EARNINGS (not the wallet).
// today -> counts in Today, 7 days, 30 days and All time; week -> 7 days, 30 days, All time;
// month -> 30 days and All time; total -> All time only. The entry is dated so it lands in the right boxes.
const EARN_AT = { today: 'now()', week: `(date_trunc('day',${IST}) AT TIME ZONE 'Asia/Kolkata') - interval '1 hour'`, month: "now() - interval '8 days'", total: "now() - interval '31 days'" };
const EARN_KEY = { today: 'today', week: 'd7', month: 'd30', total: 'total' };
const earnOf = async (c, id) => { const [e] = await q(c, `SELECT
    COALESCE(SUM(amt) FILTER (WHERE at >= (date_trunc('day',${IST})) AT TIME ZONE 'Asia/Kolkata'),0) AS today,
    COALESCE(SUM(amt) FILTER (WHERE at > now()-interval '7 days'),0) AS d7,
    COALESCE(SUM(amt) FILTER (WHERE at > now()-interval '30 days'),0) AS d30,
    COALESCE(SUM(amt),0) AS total FROM ledger WHERE uid=$1`, [id]);
  return { today: num(e.today), d7: num(e.d7), d30: num(e.d30), total: num(e.total) }; };
app.post('/api/admin/members/:id/earn', auth, adm, w(async (req, res) => {
  const b = req.body.bucket, t = req.body.type, a = Math.round(num(req.body.amount) * 100) / 100;
  if (!EARN_AT[b]) throw new E(400, 'Choose Today, Weekly, Monthly or Total.');
  if (!['add', 'deduct'].includes(t)) throw new E(400, 'Choose add or deduct.');
  if (!(a > 0 && a <= 1e7)) throw new E(400, 'Enter a valid amount.');
  res.json(await tx(async c => {
    const [m] = await q(c, "SELECT id FROM users WHERE id=$1 AND email<>$2 AND status<>'rejected' FOR UPDATE", [+req.params.id || 0, AE]);
    if (!m) throw new E(404, 'Member not found.');
    const cur = await earnOf(c, m.id), have = cur[EARN_KEY[b]];
    if (t === 'deduct' && a > have) throw new E(400, 'This box has only \u20b9' + have.toLocaleString('en-IN') + '. You cannot deduct more than that.');
    await c.query(`INSERT INTO ledger(uid,amt,why,at) VALUES($1,$2,$3,${EARN_AT[b]})`, [m.id, t === 'add' ? a : -a, 'Earning ' + (t === 'add' ? 'added' : 'deducted') + ' by admin']);
    await c.query('INSERT INTO admin_log(admin,action,target) VALUES($1,$2,$3)', [req.u.id, 'earn ' + t + ' ' + b + ' ' + a, m.id]);
    TOP.at = 0; // refresh the leaderboard
    return { earn: await earnOf(c, m.id) };
  }));
}));
// Admin only: move a member (with their whole team) under a different sponsor.
// Past earnings stay where they are; only future commissions follow the new sponsor.
app.post('/api/admin/members/:id/sponsor', auth, adm, w(async (req, res) => {
  const code = normCode(req.body.code);
  if (!/^LRS-[A-Z0-9]{5,20}$/.test(code)) throw new E(400, 'Enter a valid LRS code.');
  res.json(await tx(async c => {
    const [m] = await q(c, "SELECT id,name,code,sponsor FROM users WHERE id=$1 AND email<>$2 AND status<>'rejected' FOR UPDATE", [+req.params.id || 0, AE]);
    if (!m) throw new E(404, 'Member not found.');
    if (code === m.code) throw new E(400, 'A member cannot be their own sponsor.');
    if (code === m.sponsor) throw new E(400, 'This member is already under that sponsor.');
    const [s] = await q(c, "SELECT id,name,code,status FROM users WHERE code=$1", [code]);
    if (!s) throw new E(404, 'No member has this LRS code.');
    if (s.status !== 'active') throw new E(400, 'The new sponsor\'s ID is not active.');
    // Block loops: the new sponsor must not be inside this member's own team.
    const [loop] = await q(c, `WITH RECURSIVE up(code, sponsor, d) AS (
        SELECT code, sponsor, 0 FROM users WHERE code=$1
        UNION ALL SELECT u.code, u.sponsor, up.d+1 FROM users u JOIN up ON u.code=up.sponsor WHERE up.d < 500)
      SELECT 1 AS x FROM up WHERE code=$2 LIMIT 1`, [code, m.code]);
    if (loop) throw new E(400, 'That person is in ' + m.name + '\'s own team, so they cannot become the sponsor.');
    await c.query('UPDATE users SET sponsor=$1 WHERE id=$2', [code, m.id]);
    await c.query("UPDATE reqs SET sponsor=$1 WHERE uid=$2 AND status='pending'", [code, m.id]);
    await c.query('INSERT INTO admin_log(admin,action,target) VALUES($1,$2,$3)', [req.u.id, 'sponsor ' + (m.sponsor || '-') + ' -> ' + code, m.id]);
    return { ok: true, sponsor: code, sname: s.name };
  }));
}));
app.post('/api/admin/members/:id/:act', auth, adm, w(async (req, res) => {
  const a = req.params.act, on = !!req.body.on;
  if (!['vip', 'suspend', 'remove'].includes(a)) throw new E(400, 'Bad action.');
  await tx(async c => {
    const [m] = await q(c, 'SELECT id,status FROM users WHERE id=$1 AND email<>$2 FOR UPDATE', [req.params.id, AE]);
    if (!m) throw new E(404, 'Member not found.');
    if (a === 'vip') await c.query('UPDATE users SET vip=$1 WHERE id=$2', [on, m.id]);
    else if (a === 'remove') { // delete a pending ID: it disappears everywhere and its email is freed
      if (m.status !== 'pending') throw new E(400, 'Only pending IDs can be deleted.');
      await c.query("UPDATE users SET status='rejected', email='rejected-'||id||'@removed.invalid' WHERE id=$1", [m.id]);
      await c.query("UPDATE reqs SET status='rejected' WHERE uid=$1 AND status='pending'", [m.id]);
      await c.query("UPDATE pays SET status='rejected' WHERE uid=$1 AND status='pending'", [m.id]);
      await c.query('DELETE FROM sessions WHERE uid=$1', [m.id]);
    }
    else if (on) {
      if (m.status !== 'active') throw new E(400, 'Only active members can be suspended.');
      await c.query("UPDATE users SET status='suspended' WHERE id=$1", [m.id]);
      await c.query('DELETE FROM sessions WHERE uid=$1', [m.id]); // sign them out everywhere
    } else {
      if (m.status !== 'suspended') throw new E(400, 'This member is not suspended.');
      await c.query("UPDATE users SET status='active' WHERE id=$1", [m.id]);
    }
    await c.query('INSERT INTO admin_log(admin,action,target) VALUES($1,$2,$3)', [req.u.id, a === 'remove' ? 'delete pending id' : a + (on ? ' on' : ' off'), m.id]);
  });
  res.json({ ok: true });
}));
app.get('/api/admin/pays', auth, adm, w(async (req, res) =>
  res.json(await q(pool, "SELECT p.id,p.kind,p.amt,p.app,p.pkg,p.utr,p.status,p.at,u.name,u.vip,u.email FROM pays p JOIN users u ON u.id=p.uid WHERE u.status<>'rejected' ORDER BY (p.status='pending') DESC,p.id DESC LIMIT 200"))));
app.post('/api/admin/pays/:id/:act', auth, adm, w(async (req, res) => {
  if (!['confirm', 'reject'].includes(req.params.act)) throw new E(400, 'Bad action.');
  await tx(async c => {
    const [p] = await q(c, "SELECT * FROM pays WHERE id=$1 AND status='pending' FOR UPDATE", [req.params.id]);
    if (!p) throw new E(404, 'Payment not found or already handled.');
    if (req.params.act === 'confirm') {
      if (p.kind === 'recharge') { const [u] = await q(c, 'UPDATE users SET wallet=wallet+$1 WHERE id=$2 RETURNING wallet', [p.amt, p.uid]); await addTx(c, p.uid, 'credit', p.amt, u.wallet, 'Wallet recharge via ' + p.app); }
      else if (p.kind === 'upgrade') await c.query('UPDATE users SET pkg=GREATEST(pkg,$1) WHERE id=$2', [p.pkg, p.uid]);
      else { await c.query("UPDATE users SET status='active' WHERE id=$1", [p.uid]); await giveCashback(c, p.uid, p.pkg); }
    }
    await c.query('UPDATE pays SET status=$1 WHERE id=$2', [req.params.act === 'confirm' ? 'confirmed' : 'rejected', p.id]);
    // A rejected sign-up ID disappears everywhere (pending / active / all). The email is released so the person can sign up again.
    if (req.params.act === 'reject' && p.kind === 'buy') {
      await c.query("UPDATE users SET status='rejected', email='rejected-'||id||'@removed.invalid' WHERE id=$1 AND status='pending'", [p.uid]);
      await c.query('DELETE FROM sessions WHERE uid=$1', [p.uid]);
    }
    await c.query('INSERT INTO admin_log(admin,action,target) VALUES($1,$2,$3)', [req.u.id, req.params.act + ' payment', p.id]);
  });
  res.json({ ok: true });
}));

// Admin: password requests. The admin checks the phone number and sets a new password.
app.get('/api/admin/resets', auth, adm, w(async (req, res) => {
  const rows = await q(pool, `SELECT r.id,r.phone,r.note,r.status,r.at,u.name,u.vip,u.email,u.phone AS rphone FROM pwreq r JOIN users u ON u.id=r.uid
    WHERE u.status<>'rejected' ORDER BY (r.status='pending') DESC,r.id DESC LIMIT 100`);
  res.json(rows.map(r => ({ ...r, match: digits(r.phone) === digits(r.rphone) })));
}));
app.post('/api/admin/resets/:id/:act', auth, adm, w(async (req, res) => {
  const a = req.params.act; if (!['set', 'dismiss'].includes(a)) throw new E(400, 'Bad action.');
  const pw = String(req.body.password || '');
  if (a === 'set' && (pw.length < 6 || pw.length > 72)) throw new E(400, 'Password needs 6 to 72 characters.');
  const hash = a === 'set' ? await bcrypt.hash(pw, 10) : null;
  await tx(async c => {
    const [r] = await q(c, "SELECT id,uid FROM pwreq WHERE id=$1 AND status='pending' FOR UPDATE", [+req.params.id || 0]);
    if (!r) throw new E(404, 'Request not found or already handled.');
    if (a === 'set') {
      await c.query('UPDATE users SET pw=$1,fails=0,locked=NULL WHERE id=$2 AND email<>$3', [hash, r.uid, AE]);
      await c.query('DELETE FROM sessions WHERE uid=$1', [r.uid]); // sign the member out everywhere
    }
    await c.query('UPDATE pwreq SET status=$1,done=now() WHERE id=$2', [a === 'set' ? 'done' : 'dismissed', r.id]);
    await c.query('INSERT INTO admin_log(admin,action,target) VALUES($1,$2,$3)', [req.u.id, a === 'set' ? 'reset password' : 'dismiss password request', r.uid]);
  });
  res.json({ ok: true });
}));

// Open /api/health in the browser to see which server version is live.
app.get('/api/health', (req, res) => res.json({ ok: true, version: '2026-11-03-c' }));
// Every page (/courses, /about, /login ...) is the same app file; the app reads the address and shows the right page.
app.get('*', (req, res) => req.path.startsWith('/api/') ? res.status(404).json({ error: 'Not found' }) : res.sendFile(path.join(__dirname, 'index.html')));
init().then(() => app.listen(process.env.PORT || 3000, () => console.log('Server running'))).catch(e => { console.error(e); process.exit(1); });
