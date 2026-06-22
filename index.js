'use strict';
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const { Pool }   = require('pg');
const { nanoid } = require('nanoid');

const app  = express();
const PORT = process.env.PORT || 10000;

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      email       TEXT UNIQUE NOT NULL,
      plan        TEXT NOT NULL DEFAULT 'basic',
      order_ref   TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ,
      notes       TEXT
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS activations (
      id           SERIAL PRIMARY KEY,
      order_ref    TEXT NOT NULL,
      email        TEXT NOT NULL,
      plan         TEXT NOT NULL,
      username     TEXT NOT NULL,
      activated_at TIMESTAMPTZ DEFAULT NOW(),
      ip           TEXT
    )
  `);
  console.log('DB ready');
}
initDB().catch(console.error);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://shepherdlab.life',
    'https://www.shepherdlab.life',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ]
}));
app.use(express.json());

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateUsername() {
  return 'user_' + nanoid(6).toLowerCase();
}
function generatePassword() {
  const words  = ['Guard','Care','Safe','Watch','Shield','Alert','Protect'];
  const nums   = Math.floor(10 + Math.random() * 89);
  const suffix = nanoid(4);
  return words[Math.floor(Math.random()*words.length)] + nums + '-' + suffix;
}
function isValidOrderRef(ref) {
  return /^[A-Z0-9a-z\-_]{6,30}$/.test(ref.trim());
}
function adminAuth(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorised' });
    return false;
  }
  return true;
}

// ── EMAIL via Resend ──────────────────────────────────────────────────────────
async function sendWelcomeEmail(email, username, password, plan, isBundle) {
  const planLabel  = plan === 'pro' ? 'Pro' : 'Basic';
  const bundleNote = isBundle
    ? '6 Months Free — Shopee Bundle'
    : planLabel + ' Plan';

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"></head>
  <body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#0D1B2A;border-radius:12px;overflow:hidden">
    <div style="background:#0D1B2A;padding:32px 32px 0">
      <h1 style="color:#fff;font-size:28px;margin:0">Welcome to FallGuard+ 🛡️</h1>
      <p style="color:#8BA0B4;margin:12px 0 24px">
        ${isBundle
          ? 'Your Shopee wheelchair purchase includes <strong style="color:#fff">6 months of FallGuard+ Basic — free</strong>. Your account is ready.'
          : 'Your account is ready.'
        }
        Here are your login credentials — save these somewhere safe.
      </p>
      <div style="display:inline-block;background:rgba(0,168,150,0.15);border:1px solid rgba(0,168,150,0.3);border-radius:6px;padding:6px 14px;margin-bottom:24px">
        <span style="color:#00A896;font-size:13px;font-weight:700">🎁 ${bundleNote}</span>
      </div>
    </div>
    <div style="background:#122030;margin:0 24px;border-radius:10px;padding:24px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="color:#8BA0B4;font-size:11px;text-transform:uppercase;letter-spacing:1px;padding-bottom:4px">USERNAME</td></tr>
        <tr><td style="color:#fff;font-size:18px;font-weight:700;font-family:monospace;background:#0D1B2A;padding:10px 14px;border-radius:6px;letter-spacing:1px">${username}</td></tr>
        <tr><td style="padding:12px 0 4px;color:#8BA0B4;font-size:11px;text-transform:uppercase;letter-spacing:1px">PASSWORD</td></tr>
        <tr><td style="color:#00A896;font-size:18px;font-weight:700;font-family:monospace;background:#0D1B2A;padding:10px 14px;border-radius:6px;letter-spacing:1px">${password}</td></tr>
        <tr><td style="padding:12px 0 4px;color:#8BA0B4;font-size:11px;text-transform:uppercase;letter-spacing:1px">PLAN</td></tr>
        <tr><td style="color:#fff;font-size:16px;font-weight:600;padding:6px 0">${planLabel}${isBundle ? ' · 6 months free' : ''}</td></tr>
      </table>
    </div>
    <div style="padding:24px 32px">
      <a href="${process.env.APK_URL || 'https://shepherdlab.life/download/fallguardplus-latest.apk'}"
         style="display:block;background:#00A896;color:#0D1B2A;text-align:center;padding:14px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none">
        ⬇ Download FallGuard+ APK
      </a>
      <p style="color:#8BA0B4;font-size:13px;text-align:center;margin-top:8px">Android only · Android 9+ · 3GB RAM minimum</p>
    </div>
    <div style="background:#0a1520;padding:20px 32px;border-top:1px solid rgba(255,255,255,0.06)">
      ${isBundle ? `<p style="background:rgba(0,168,150,0.08);border:1px solid rgba(0,168,150,0.2);border-radius:8px;padding:12px 16px;font-size:13px;color:#8BA0B4;margin:0 0 16px">
        <strong style="color:#00A896">After 6 months:</strong> Continue at SGD $15/month (Basic) or $20/month (Pro) at <a href="https://shepherdlab.life/fallguard.html" style="color:#00A896">shepherdlab.life</a>
      </p>` : ''}
      <p style="color:#8BA0B4;font-size:13px;margin:0">Need help? WhatsApp <strong style="color:#fff">+65 8835 7181</strong> or email <a href="mailto:hello@shepherdlab.life" style="color:#00A896">hello@shepherdlab.life</a></p>
    </div>
  </div>
  </body>
  </html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
    },
    body: JSON.stringify({
      from:    'FallGuard+ <noreply@shepherdforms.com>',
      to:      [email],
      subject: 'Your FallGuard+ ' + planLabel + ' credentials',
      html,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── POST /api/activate ────────────────────────────────────────────────────────
app.post('/api/activate', async (req, res) => {
  try {
    const orderRaw = req.body.orderNumber || req.body.order_ref || '';
    const email    = (req.body.email || '').trim().toLowerCase();
    const plan     = 'basic';

    if (!orderRaw || !email) {
      return res.status(400).json({ error: 'Order number and email are required.' });
    }
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    const order_ref = orderRaw.replace(/[\s\-]/g, '').toUpperCase();
    if (!isValidOrderRef(order_ref)) {
      return res.status(400).json({ error: 'Invalid order number. Please check your Shopee order.' });
    }

    // Check order already used
    const existRes = await db.query(
      'SELECT * FROM activations WHERE order_ref = $1', [order_ref]
    );
    if (existRes.rows[0]) {
      return res.status(400).json({ error: 'This order number has already been used.' });
    }

    // Check email already registered
    const emailRes = await db.query(
      'SELECT * FROM users WHERE email = $1', [email]
    );
    if (emailRes.rows[0]) {
      return res.status(400).json({ error: 'An account already exists for this email.' });
    }

    // Create account
    const username    = generateUsername();
    const rawPassword = generatePassword();
    const hashed      = await bcrypt.hash(rawPassword, 10);

    await db.query(
      `INSERT INTO users (username, password, email, plan, order_ref, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW() + INTERVAL '6 months')`,
      [username, hashed, email, plan, order_ref]
    );
    await db.query(
      'INSERT INTO activations (order_ref, email, plan, username, ip) VALUES ($1,$2,$3,$4,$5)',
      [order_ref, email, 'basic-shopee-6mo', username, req.ip]
    );

    // Send email in background
    sendWelcomeEmail(email, username, rawPassword, plan, true)
      .then(() => console.log('[email] Sent to', email))
      .catch(err => console.error('[email] Failed:', err.message));

    res.json({ success: true, message: 'Account created! Check your email.', username, plan });

  } catch(err) {
    console.error('[activate]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again or contact hello@shepherdlab.life' });
  }
});

// ── POST /api/verify-login ────────────────────────────────────────────────────
app.post('/api/verify-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required.' });
    }
    const result = await db.query(
      'SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account inactive.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ ok: true, plan: user.plan, email: user.email, expires_at: user.expires_at });
  } catch(err) {
    console.error('[verify-login]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── ADMIN: view users ─────────────────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const result = await db.query(
    'SELECT id, username, email, plan, order_ref, status, created_at, expires_at FROM users ORDER BY created_at DESC'
  );
  res.json({ count: result.rows.length, users: result.rows });
});

// ── ADMIN: view as HTML table ─────────────────────────────────────────────────
app.get('/api/admin/view', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const result = await db.query(
    'SELECT id, username, email, plan, status, created_at, expires_at FROM users ORDER BY created_at DESC'
  );
  const rows = result.rows.map(u =>
    `<tr><td>${u.id}</td><td><b>${u.username}</b></td><td>${u.email}</td><td>${u.plan}</td><td>${u.status}</td><td>${u.created_at}</td><td>${u.expires_at||'-'}</td></tr>`
  ).join('');
  res.send(`<html><body><h2>Users (${result.rows.length})</h2><table border=1 cellpadding=6 cellspacing=0>
    <tr><th>ID</th><th>Username</th><th>Email</th><th>Plan</th><th>Status</th><th>Created</th><th>Expires</th></tr>
    ${rows}</table></body></html>`);
});

// ── ADMIN: delete user ────────────────────────────────────────────────────────
app.get('/api/admin/delete-user', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  await db.query('DELETE FROM activations WHERE email = $1', [email.toLowerCase()]);
  await db.query('DELETE FROM users WHERE email = $1', [email.toLowerCase()]);
  res.json({ ok: true, deleted: email });
});

// ── ADMIN: reset user credentials ────────────────────────────────────────────
app.post('/api/admin/reset-user', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const newPassword = generatePassword();
    const hashed      = await bcrypt.hash(newPassword, 10);
    const result      = await db.query(
      'UPDATE users SET password=$1 WHERE email=$2 RETURNING username, plan',
      [hashed, email.toLowerCase()]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    sendWelcomeEmail(email, user.username, newPassword, user.plan, true)
      .then(() => console.log('[reset] Email sent to', email))
      .catch(err => console.error('[reset] Email failed:', err.message));
    res.json({ ok: true, username: user.username, newPassword, email });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: create user manually ───────────────────────────────────────────────
app.post('/api/admin/create-user', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { email, plan, order_ref, notes } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const username    = generateUsername();
  const rawPassword = generatePassword();
  const hashed      = await bcrypt.hash(rawPassword, 10);
  await db.query(
    `INSERT INTO users (username, password, email, plan, order_ref, status, notes, expires_at)
     VALUES ($1,$2,$3,$4,$5,'active',$6, NOW() + INTERVAL '6 months')`,
    [username, hashed, email.toLowerCase(), plan||'basic', order_ref||'MANUAL', notes||'']
  );
  sendWelcomeEmail(email, username, rawPassword, plan||'basic', true)
    .catch(err => console.error('[create] Email failed:', err.message));
  res.json({ ok: true, username, password: rawPassword, email });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log('ShepherdLab API running on port', PORT));
