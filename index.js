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
  await db.query(`
    CREATE TABLE IF NOT EXISTS sw_leads (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      source     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sw_visits (
      id         SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id          SERIAL PRIMARY KEY,
      code        TEXT UNIQUE NOT NULL,
      months      INTEGER NOT NULL DEFAULT 6,
      batch       TEXT,
      status      TEXT NOT NULL DEFAULT 'unused',
      redeemed_by TEXT,
      redeemed_at TIMESTAMPTZ,
      username    TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── v1.1 migration: Play Billing purchase tracking columns ────────────────
  // Safe to run repeatedly — ADD COLUMN IF NOT EXISTS is idempotent.
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS purchase_token TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS product_id     TEXT`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_purchase_token
    ON users(purchase_token) WHERE purchase_token IS NOT NULL
  `);

  console.log('DB ready');
}
initDB().catch(console.error);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://shepherdlab.life',
    'https://www.shepherdlab.life',
    'https://staywhere.sg',
    'https://www.staywhere.sg',
    'https://staywhere.onrender.com',
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
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
  const planLabel  = plan === 'pro' ? 'Pro' : (plan === 'premium' ? 'Premium' : 'Basic');
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
      <h1 style="color:#fff;font-size:28px;margin:0">Welcome to ShepherdCare 🛡️</h1>
      <p style="color:#8BA0B4;margin:12px 0 24px">
        ${isBundle
          ? 'Your Shopee wheelchair purchase includes <strong style="color:#fff">6 months of ShepherdCare Basic — free</strong>. Your account is ready.'
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
      <p style="color:#8BA0B4;font-size:14px;line-height:1.6;margin:0 0 16px">
        ShepherdCare includes two AI monitoring modes:
      </p>
      <ul style="color:#8BA0B4;font-size:13px;line-height:1.7;margin:0 0 16px;padding-left:20px">
        <li><strong style="color:#fff">Fall Detection</strong> — for wheelchair users, detects falls in real time</li>
        <li><strong style="color:#fff">Bed Exit Alert</strong> — for fall-risk patients, alerts when patient leaves bed</li>
      </ul>
      <a href="${process.env.APK_URL || 'https://play.google.com/store/apps/details?id=com.caroguard.plusv2'}"
         style="display:block;background:#00A896;color:#0D1B2A;text-align:center;padding:14px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none">
        ⬇ Get ShepherdCare on Google Play
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
      from:    'ShepherdCare <noreply@shepherdforms.com>',
      to:      [email],
      subject: 'Your ShepherdCare ' + planLabel + ' credentials',
      html,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Telegram admin notification helper ────────────────────────────────────────
function notifyAdmin(text) {
  if (!process.env.ADMIN_TELEGRAM_CHAT_ID || !process.env.TELEGRAM_BOT_TOKEN) return;
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.ADMIN_TELEGRAM_CHAT_ID, text }),
  }).catch(() => {});
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
    if (!isValidEmail(email)) {
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

// ══════════════════════════════════════════════════════════════════════════════
// PLAY BILLING SUBSCRIPTION ENDPOINTS (v1.1 + v1.2)
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/grant-premium ───────────────────────────────────────────────────
// Called by the app after a successful Google Play subscription purchase.
// Idempotent: safe to call multiple times with the same purchase token.
//
// Body: {
//   purchaseToken: string  (required) - from Google Play purchase result
//   productId:     string  (required) - e.g. 'premium_monthly'
//   packageName:   string  (optional) - e.g. 'com.caroguard.plusv2'
//   orderId:       string  (optional) - Google Play order ID, for admin reference
//   email:         string  (OPTIONAL, NEW in v1.2) - user's email for credential backup
// }
//
// If email is provided AND valid AND not already taken:
//   - Uses real email in users table
//   - Sends welcome email with credentials to that address
// Else:
//   - Uses synthetic email (username@play.premium)
//   - No email sent
//
// Returns for a NEW purchase:
//   { ok: true, existing: false, username, password, plan: 'premium', expires_at, emailSent }
// Returns for an EXISTING purchase token (renewal / re-verify):
//   { ok: true, existing: true, username, plan: 'premium', expires_at }
app.post('/api/grant-premium', async (req, res) => {
  try {
    const { purchaseToken, productId, packageName, orderId, email } = req.body || {};

    if (!purchaseToken || !productId) {
      return res.status(400).json({ error: 'purchaseToken and productId are required.' });
    }

    // Rolling 35-day window (30-day billing cycle + 5-day grace)
    const EXTEND_INTERVAL = "35 days";

    // Check if this purchase token has been seen before
    const existing = await db.query(
      'SELECT username, plan, expires_at FROM users WHERE purchase_token = $1',
      [purchaseToken]
    );

    if (existing.rows[0]) {
      // Repeat call — extend the window, don't rotate credentials
      const user = existing.rows[0];
      const updated = await db.query(
        `UPDATE users
           SET expires_at = NOW() + INTERVAL '${EXTEND_INTERVAL}',
               status     = 'active',
               plan       = 'premium'
         WHERE purchase_token = $1
         RETURNING expires_at`,
        [purchaseToken]
      );
      return res.json({
        ok:         true,
        existing:   true,
        username:   user.username,
        plan:       'premium',
        expires_at: updated.rows[0].expires_at,
      });
    }

    // Validate optional email
    const providedEmail = (email || '').trim().toLowerCase();
    const hasValidEmail = providedEmail && isValidEmail(providedEmail);

    // New purchase — create user
    const username    = generateUsername();
    const rawPassword = generatePassword();
    const hashed      = await bcrypt.hash(rawPassword, 10);
    const syntheticEmail = username + '@play.premium';
    const orderRefTag    = 'PLAY_' + (orderId || purchaseToken.substring(0, 20));

    // Decide which email to store: real email if valid and not taken, else synthetic
    let storedEmail = syntheticEmail;
    if (hasValidEmail) {
      const emailCheck = await db.query('SELECT id FROM users WHERE email = $1', [providedEmail]);
      if (!emailCheck.rows[0]) {
        storedEmail = providedEmail;
      }
      // else: real email is already in use by another account; store synthetic to avoid
      // UNIQUE constraint conflict. Still send welcome email to the provided address.
    }

    const inserted = await db.query(
      `INSERT INTO users
         (username, password, email, plan, order_ref, status, expires_at, purchase_token, product_id)
       VALUES
         ($1, $2, $3, 'premium', $4, 'active',
          NOW() + INTERVAL '${EXTEND_INTERVAL}', $5, $6)
       RETURNING expires_at`,
      [username, hashed, storedEmail, orderRefTag, purchaseToken, productId]
    );

    // Send welcome email to the real address (background, non-blocking)
    let emailSent = false;
    if (hasValidEmail) {
      emailSent = true;
      sendWelcomeEmail(providedEmail, username, rawPassword, 'premium', false)
        .then(() => console.log('[grant-premium] Email sent to', providedEmail))
        .catch(err => console.error('[grant-premium] Email failed:', err.message));
    }

    notifyAdmin(
      `💳 New ShepherdCare Premium subscription!\n\n` +
      `Product: ${productId}\n` +
      `Username: ${username}\n` +
      `Email: ${hasValidEmail ? providedEmail : '(not provided)'}\n` +
      `Order: ${orderId || '(no order ID)'}\n` +
      `Package: ${packageName || '(no package)'}`
    );

    res.json({
      ok:         true,
      existing:   false,
      username,
      password:   rawPassword,
      plan:       'premium',
      expires_at: inserted.rows[0].expires_at,
      emailSent,
    });

  } catch(err) {
    console.error('[grant-premium]', err);
    res.status(500).json({ error: 'Failed to grant premium access. Please try again.' });
  }
});

// ── POST /api/verify-subscription ─────────────────────────────────────────────
// Called by the app on launch (for premium users) to check the sub is still valid.
// Body: { purchaseToken }
// Returns: { ok: true, active: boolean, expires_at, plan }
app.post('/api/verify-subscription', async (req, res) => {
  try {
    const { purchaseToken } = req.body || {};
    if (!purchaseToken) {
      return res.status(400).json({ error: 'purchaseToken required.' });
    }
    const result = await db.query(
      'SELECT username, plan, status, expires_at FROM users WHERE purchase_token = $1',
      [purchaseToken]
    );
    const user = result.rows[0];
    if (!user) {
      return res.json({ ok: true, active: false, reason: 'not_found' });
    }
    const active = user.status === 'active'
                && user.expires_at
                && new Date(user.expires_at) > new Date();
    res.json({
      ok:         true,
      active,
      plan:       user.plan,
      expires_at: user.expires_at,
      username:   user.username,
    });
  } catch(err) {
    console.error('[verify-subscription]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════

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
  const months = parseInt(req.body.months) || 6;
  if (!email) return res.status(400).json({ error: 'email required' });
  const username    = generateUsername();
  const rawPassword = generatePassword();
  const hashed      = await bcrypt.hash(rawPassword, 10);
  await db.query(
    `INSERT INTO users (username, password, email, plan, order_ref, status, notes, expires_at)
     VALUES ($1,$2,$3,$4,$5,'active',$6, NOW() + ($7 || ' months')::interval)`,
    [username, hashed, email.toLowerCase(), plan||'basic', order_ref||'MANUAL', notes||'', String(months)]
  );
  sendWelcomeEmail(email, username, rawPassword, plan||'basic', true)
    .catch(err => console.error('[create] Email failed:', err.message));
  res.json({ ok: true, username, password: rawPassword, email });
});

// ── Stay Where ah? visits ────────────────────────────────────────────────────
app.post('/api/visit', async (req, res) => {
  try {
    await db.query('INSERT INTO sw_visits DEFAULT VALUES');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
  try {
    const v  = await db.query('SELECT COUNT(*)::int AS n FROM sw_visits');
    const vt = await db.query("SELECT COUNT(*)::int AS n FROM sw_visits WHERE created_at >= date_trunc('day', now())");
    const l  = await db.query('SELECT COUNT(*)::int AS n FROM sw_leads');
    res.json({
      ok: true,
      visits: v.rows[0].n,
      visits_today: vt.rows[0].n,
      leads: l.rows[0].n
    });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ── Stay Where ah? report leads ───────────────────────────────────────────────
app.post('/api/lead', async (req, res) => {
  try {
    const email  = String((req.body && req.body.email)  || '').trim().toLowerCase();
    const source = String((req.body && req.body.source) || 'report').slice(0, 40);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'invalid email' });
    }
    await db.query('INSERT INTO sw_leads (email, source) VALUES ($1, $2)', [email, source]);
    res.json({ ok: true });
  } catch (e) {
    console.error('lead error', e.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/api/admin/leads', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
  try {
    const r = await db.query('SELECT email, source, created_at FROM sw_leads ORDER BY created_at DESC');
    res.json({ ok: true, count: r.rows.length, leads: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// REDEEM CODES
// ══════════════════════════════════════════════════════════════════════════════
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Admin: generate a batch of codes
app.post('/api/admin/generate-codes', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const count  = Math.min(parseInt(req.body.count) || 1, 500);
  const months = parseInt(req.body.months) || 6;
  const batch  = req.body.batch || ('batch_' + Date.now());
  const codes = [];
  try {
    for (let i = 0; i < count; i++) {
      let code, ok = false, tries = 0;
      while (!ok && tries < 10) {
        code = generateCode();
        try {
          await db.query('INSERT INTO redeem_codes (code, months, batch) VALUES ($1,$2,$3)', [code, months, batch]);
          ok = true;
        } catch(e) { tries++; }
      }
      if (ok) codes.push(code);
    }
    res.json({ ok: true, batch, months, count: codes.length, codes });
  } catch(err) {
    console.error('[generate-codes]', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: list codes
app.get('/api/admin/codes', async (req, res) => {
  if ((req.headers['x-admin-key'] || req.query.key) !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const result = await db.query('SELECT code, months, batch, status, redeemed_by, redeemed_at, created_at FROM redeem_codes ORDER BY created_at DESC LIMIT 1000');
  const unused   = result.rows.filter(r => r.status === 'unused').length;
  const redeemed = result.rows.filter(r => r.status === 'redeemed').length;
  res.json({ total: result.rows.length, unused, redeemed, codes: result.rows });
});

// App: redeem a code
app.post('/api/redeem', async (req, res) => {
  try {
    const codeRaw = (req.body.code || '').trim().toUpperCase().replace(/[\s\-]/g, '');
    const email   = (req.body.email || '').trim().toLowerCase();
    if (!codeRaw) return res.status(400).json({ error: 'Please enter your code.' });

    const codeRes = await db.query('SELECT * FROM redeem_codes WHERE code = $1', [codeRaw]);
    const codeRow = codeRes.rows[0];
    if (!codeRow) return res.status(404).json({ error: 'Invalid code. Please check and try again.' });
    if (codeRow.status === 'redeemed') return res.status(400).json({ error: 'This code has already been used.' });

    const username    = generateUsername();
    const rawPassword = generatePassword();
    const hashed      = await bcrypt.hash(rawPassword, 10);
    const userEmail   = email || (username + '@redeem.fallguard');

    await db.query(
      `INSERT INTO users (username, password, email, plan, order_ref, status, expires_at)
       VALUES ($1,$2,$3,'basic',$4,'active', NOW() + ($5 || ' months')::interval)`,
      [username, hashed, userEmail, 'CODE_' + codeRaw, String(codeRow.months)]
    );
    await db.query(
      `UPDATE redeem_codes SET status='redeemed', redeemed_by=$1, redeemed_at=NOW(), username=$2 WHERE code=$3`,
      [userEmail, username, codeRaw]
    );

    if (email) {
      sendWelcomeEmail(email, username, rawPassword, 'basic', true)
        .catch(err => console.error('[redeem email]', err.message));
    }
    notifyAdmin(
      `🎟️ Code redeemed!\n\n` +
      `Code: ${codeRaw}\n` +
      `Months: ${codeRow.months}\n` +
      `Username: ${username}\n` +
      `Email: ${email || '(none)'}`
    );

    res.json({ ok: true, username, password: rawPassword, plan: 'basic', months: codeRow.months });
  } catch(err) {
    console.error('[redeem]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.listen(PORT, () => console.log('ShepherdLab API running on port', PORT));
