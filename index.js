'use strict';
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const { Pool }   = require('pg');
const { nanoid, customAlphabet } = require('nanoid');

const app  = express();
const PORT = process.env.PORT || 10000;

// ── Safe alphabets (avoid visually-ambiguous chars: I l 1 O 0) ────────────────
const SAFE_LOWER = 'abcdefghjkmnpqrstuvwxyz23456789';
const SAFE_MIXED = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const usernameNanoid = customAlphabet(SAFE_LOWER, 6);
const passwordNanoid = customAlphabet(SAFE_MIXED, 6);

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
  // Forgot-password rate limiting
  await db.query(`
    CREATE TABLE IF NOT EXISTS forgot_requests (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      ip         TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_forgot_email_time ON forgot_requests(email, created_at)`);

  // Migrations
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS purchase_token TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS product_id     TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_is_temporary BOOLEAN DEFAULT FALSE`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires TIMESTAMPTZ`);
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
function generateUsername() { return 'user_' + usernameNanoid(); }

// Random password only used for forgot-password temporary passwords
function generateTempPassword() {
  return 'Reset-' + passwordNanoid();
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
}
function isValidPassword(p) {
  return typeof p === 'string' && p.length >= 6;
}
function isValidOrderRef(ref) {
  return /^[A-Z0-9a-z\-_]{6,30}$/.test((ref || '').trim());
}
function adminAuth(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorised' });
    return false;
  }
  return true;
}

// Simple bearer-token auth: token IS the user's email+password hash lookup.
// For simplicity we use email+password each call (stateless). Real apps use JWT.
// We accept email+password in the body for authenticated endpoints.
async function authenticate(req) {
  const { email, password } = req.body || {};
  if (!email || !password) return null;
  const result = await db.query(
    'SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]
  );
  const user = result.rows[0];
  if (!user || user.status !== 'active') return null;
  const match = await bcrypt.compare(password, user.password);
  if (!match) return null;
  return user;
}

// ── EMAIL via Resend ──────────────────────────────────────────────────────────
async function sendResendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
    },
    body: JSON.stringify({
      from:    'ShepherdCare <noreply@shepherdforms.com>',
      to:      [to],
      subject, html,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

function baseEmailTemplate(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#0D1B2A;border-radius:12px;overflow:hidden">
  <div style="background:#0D1B2A;padding:32px 32px 8px">
    <h1 style="color:#fff;font-size:26px;margin:0 0 8px">${title}</h1>
  </div>
  <div style="padding:0 32px 24px;color:#8BA0B4;font-size:14px;line-height:1.7">
    ${bodyHtml}
  </div>
  <div style="background:#0a1520;padding:20px 32px;border-top:1px solid rgba(255,255,255,0.06)">
    <p style="color:#8BA0B4;font-size:13px;margin:0">Need help? WhatsApp <strong style="color:#fff">+65 8835 7181</strong> or email <a href="mailto:hello@shepherdlab.life" style="color:#00A896">hello@shepherdlab.life</a></p>
  </div>
</div></body></html>`;
}

// Welcome email — user chose their own password so we don't include it
async function sendWelcomeEmail(email, plan) {
  const planLabel = plan === 'premium' ? 'Premium' : (plan === 'pro' ? 'Pro' : 'Basic');
  const body = `
    <p>Welcome to ShepherdCare 🛡️. Your <strong style="color:#fff">${planLabel}</strong> account is active.</p>
    <p>Sign in with the email and password you chose during sign-up.</p>
    <div style="background:#122030;border-radius:10px;padding:20px;margin:20px 0">
      <p style="color:#8BA0B4;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px">Signed-in email</p>
      <p style="color:#fff;font-size:16px;font-family:monospace;margin:0">${email}</p>
    </div>
    <p style="color:#fff;margin:20px 0 8px"><strong>ShepherdCare includes two AI monitoring modes:</strong></p>
    <ul style="padding-left:20px;line-height:1.7">
      <li><strong style="color:#fff">Fall Detection</strong> — for wheelchair users</li>
      <li><strong style="color:#fff">Bed Exit Alert</strong> — for fall-risk patients</li>
    </ul>
    <p style="margin-top:20px">Forgot your password later? Tap "Forgot password?" on the sign-in screen.</p>
  `;
  return sendResendEmail(email, `Welcome to ShepherdCare ${planLabel}`, baseEmailTemplate(`Welcome to ShepherdCare 🛡️`, body));
}

// Forgot password — send temporary password
async function sendForgotPasswordEmail(email, tempPassword) {
  const body = `
    <p>Someone (hopefully you) asked to reset the ShepherdCare password for this email.</p>
    <p>Use this temporary password to sign in. The app will ask you to set a new password right away.</p>
    <div style="background:#122030;border-radius:10px;padding:20px;margin:20px 0">
      <p style="color:#8BA0B4;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px">Temporary password</p>
      <p style="color:#00A896;font-size:20px;font-weight:700;font-family:monospace;background:#0D1B2A;padding:10px 14px;border-radius:6px;margin:0">${tempPassword}</p>
    </div>
    <p style="color:#fbbf24;font-size:12px">This temporary password expires in 24 hours. If you didn't request this, you can ignore this email — your existing password still works.</p>
  `;
  return sendResendEmail(email, 'ShepherdCare — temporary password', baseEmailTemplate('Password reset 🔐', body));
}

// Password changed confirmation
async function sendPasswordChangedEmail(email) {
  const body = `
    <p>Your ShepherdCare password was just changed.</p>
    <p>If you did this — great, nothing more to do.</p>
    <p style="color:#fbbf24">If you did NOT change your password, contact us immediately at <a href="mailto:hello@shepherdlab.life" style="color:#00A896">hello@shepherdlab.life</a>.</p>
  `;
  return sendResendEmail(email, 'ShepherdCare — password changed', baseEmailTemplate('Password changed ✓', body));
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

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: '1.2.3' });
});

// ── POST /api/verify-login ────────────────────────────────────────────────────
// Body: { email, password }
// Returns: { ok, plan, expires_at, password_is_temporary }
app.post('/api/verify-login', async (req, res) => {
  try {
    const email    = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required.' });
    }
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account inactive. Contact hello@shepherdlab.life' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    // Check if temporary password has expired
    if (user.password_is_temporary && user.temp_password_expires && new Date(user.temp_password_expires) < new Date()) {
      return res.status(401).json({ error: 'This temporary password has expired. Please request a new one.' });
    }

    res.json({
      ok: true,
      email: user.email,
      plan: user.plan,
      expires_at: user.expires_at,
      password_is_temporary: user.password_is_temporary || false,
    });
  } catch(err) {
    console.error('[verify-login]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/grant-premium ───────────────────────────────────────────────────
// Called after Play Billing purchase.
// Body: { purchaseToken, productId, packageName, orderId, email, password }
// email + password are USER-CHOSEN and required for new purchases.
app.post('/api/grant-premium', async (req, res) => {
  try {
    const { purchaseToken, productId, packageName, orderId } = req.body || {};
    const email    = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!purchaseToken || !productId) {
      return res.status(400).json({ error: 'purchaseToken and productId are required.' });
    }

    const EXTEND_INTERVAL = "35 days";

    // Idempotency: existing purchase token → just extend expiry
    const existing = await db.query(
      'SELECT username, email, plan, expires_at FROM users WHERE purchase_token = $1',
      [purchaseToken]
    );

    if (existing.rows[0]) {
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
        email:      user.email,
        plan:       'premium',
        expires_at: updated.rows[0].expires_at,
      });
    }

    // New purchase — validate user-chosen credentials
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required for new subscriptions.' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Check email not already taken
    const emailCheck = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (emailCheck.rows[0]) {
      return res.status(409).json({ error: 'This email already has an account. Please sign in, or use a different email.' });
    }

    const username = generateUsername();
    const hashed   = await bcrypt.hash(password, 10);
    const orderRefTag = 'PLAY_' + (orderId || purchaseToken.substring(0, 20));

    const inserted = await db.query(
      `INSERT INTO users
         (username, password, email, plan, order_ref, status, expires_at, purchase_token, product_id, password_is_temporary)
       VALUES
         ($1, $2, $3, 'premium', $4, 'active',
          NOW() + INTERVAL '${EXTEND_INTERVAL}', $5, $6, FALSE)
       RETURNING expires_at`,
      [username, hashed, email, orderRefTag, purchaseToken, productId]
    );

    // Send welcome email (no credentials — user chose their own)
    sendWelcomeEmail(email, 'premium')
      .then(() => console.log('[grant-premium] Welcome email sent to', email))
      .catch(err => console.error('[grant-premium] Welcome email failed:', err.message));

    notifyAdmin(
      `💳 New ShepherdCare Premium subscription!\n\n` +
      `Product: ${productId}\n` +
      `Email: ${email}\n` +
      `Order: ${orderId || '(no order ID)'}\n` +
      `Package: ${packageName || '(no package)'}`
    );

    res.json({
      ok:         true,
      existing:   false,
      email,
      plan:       'premium',
      expires_at: inserted.rows[0].expires_at,
    });

  } catch(err) {
    console.error('[grant-premium]', err);
    res.status(500).json({ error: 'Failed to grant premium access. Please try again.' });
  }
});

// ── POST /api/verify-subscription ─────────────────────────────────────────────
app.post('/api/verify-subscription', async (req, res) => {
  try {
    const { purchaseToken } = req.body || {};
    if (!purchaseToken) return res.status(400).json({ error: 'purchaseToken required.' });
    const result = await db.query(
      'SELECT username, email, plan, status, expires_at FROM users WHERE purchase_token = $1',
      [purchaseToken]
    );
    const user = result.rows[0];
    if (!user) return res.json({ ok: true, active: false, reason: 'not_found' });
    const active = user.status === 'active'
                && user.expires_at
                && new Date(user.expires_at) > new Date();
    res.json({ ok: true, active, plan: user.plan, expires_at: user.expires_at, email: user.email });
  } catch(err) {
    console.error('[verify-subscription]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/account ─────────────────────────────────────────────────────────
// Returns current user info. Requires email+password in body.
app.post('/api/account', async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({
      ok: true,
      email: user.email,
      plan: user.plan,
      status: user.status,
      expires_at: user.expires_at,
      created_at: user.created_at,
      password_is_temporary: user.password_is_temporary || false,
    });
  } catch(err) {
    console.error('[account]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/change-password ─────────────────────────────────────────────────
// Body: { email, password (current), newPassword }
app.post('/api/change-password', async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: 'Current password is incorrect.' });

    const newPassword = req.body.newPassword || '';
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    if (newPassword === (req.body.password || '')) {
      return res.status(400).json({ error: 'New password must be different from the current password.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.query(
      `UPDATE users
         SET password = $1,
             password_is_temporary = FALSE,
             temp_password_expires = NULL
       WHERE id = $2`,
      [hashed, user.id]
    );

    sendPasswordChangedEmail(user.email)
      .catch(err => console.error('[change-password] confirmation email failed:', err.message));

    res.json({ ok: true, message: 'Password updated.' });
  } catch(err) {
    console.error('[change-password]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/forgot-password ─────────────────────────────────────────────────
// Body: { email }
// Rate-limited: max 3 per hour per email. Always returns success message
// (to prevent email enumeration).
app.post('/api/forgot-password', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email.' });
    }

    // Rate limit
    const recentCount = await db.query(
      `SELECT COUNT(*)::int AS n FROM forgot_requests
       WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [email]
    );
    if (recentCount.rows[0].n >= 3) {
      return res.status(429).json({ error: 'Too many password reset requests. Please wait an hour and try again.' });
    }

    // Log the request regardless of whether email exists (rate limit prevents enumeration)
    await db.query(
      'INSERT INTO forgot_requests (email, ip) VALUES ($1, $2)',
      [email, req.ip || null]
    );

    // Check if email exists
    const userRes = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];

    if (user) {
      // Generate temp password, save it, email it
      const tempPassword = generateTempPassword();
      const hashed = await bcrypt.hash(tempPassword, 10);
      await db.query(
        `UPDATE users
           SET password = $1,
               password_is_temporary = TRUE,
               temp_password_expires = NOW() + INTERVAL '24 hours'
         WHERE id = $2`,
        [hashed, user.id]
      );
      sendForgotPasswordEmail(email, tempPassword)
        .then(() => console.log('[forgot] Sent to', email))
        .catch(err => console.error('[forgot] Email failed:', err.message));
    }

    // Always return same message (prevents email enumeration)
    res.json({
      ok: true,
      message: 'If that email is registered, we\'ve sent a temporary password. Check your inbox (and Spam folder).',
    });
  } catch(err) {
    console.error('[forgot-password]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SHOPEE ACTIVATE / REDEEM
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/activate (Shopee bundle) ────────────────────────────────────────
// Body: { orderNumber, email, password }
app.post('/api/activate', async (req, res) => {
  try {
    const orderRaw = req.body.orderNumber || req.body.order_ref || '';
    const email    = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const plan     = 'basic';

    if (!orderRaw || !email || !password) {
      return res.status(400).json({ error: 'Order number, email and password are all required.' });
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const order_ref = orderRaw.replace(/[\s\-]/g, '').toUpperCase();
    if (!isValidOrderRef(order_ref)) return res.status(400).json({ error: 'Invalid order number.' });

    const existRes = await db.query('SELECT * FROM activations WHERE order_ref = $1', [order_ref]);
    if (existRes.rows[0]) return res.status(400).json({ error: 'This order number has already been used.' });

    const emailRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (emailRes.rows[0]) return res.status(409).json({ error: 'An account already exists for this email.' });

    const username = generateUsername();
    const hashed   = await bcrypt.hash(password, 10);

    await db.query(
      `INSERT INTO users (username, password, email, plan, order_ref, status, expires_at, password_is_temporary)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW() + INTERVAL '6 months', FALSE)`,
      [username, hashed, email, plan, order_ref]
    );
    await db.query(
      'INSERT INTO activations (order_ref, email, plan, username, ip) VALUES ($1,$2,$3,$4,$5)',
      [order_ref, email, 'basic-shopee-6mo', username, req.ip]
    );

    sendWelcomeEmail(email, 'basic')
      .catch(err => console.error('[activate email]', err.message));

    res.json({ success: true, email, plan });
  } catch(err) {
    console.error('[activate]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── POST /api/redeem ──────────────────────────────────────────────────────────
// Body: { code, email, password }
app.post('/api/redeem', async (req, res) => {
  try {
    const codeRaw  = (req.body.code || '').trim().toUpperCase().replace(/[\s\-]/g, '');
    const email    = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!codeRaw) return res.status(400).json({ error: 'Please enter your code.' });
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const codeRes = await db.query('SELECT * FROM redeem_codes WHERE code = $1', [codeRaw]);
    const codeRow = codeRes.rows[0];
    if (!codeRow) return res.status(404).json({ error: 'Invalid code. Please check and try again.' });
    if (codeRow.status === 'redeemed') return res.status(400).json({ error: 'This code has already been used.' });

    const emailCheck = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (emailCheck.rows[0]) return res.status(409).json({ error: 'This email already has an account. Please sign in or use a different email.' });

    const username = generateUsername();
    const hashed   = await bcrypt.hash(password, 10);

    await db.query(
      `INSERT INTO users (username, password, email, plan, order_ref, status, expires_at, password_is_temporary)
       VALUES ($1,$2,$3,'basic',$4,'active', NOW() + ($5 || ' months')::interval, FALSE)`,
      [username, hashed, email, 'CODE_' + codeRaw, String(codeRow.months)]
    );
    await db.query(
      `UPDATE redeem_codes SET status='redeemed', redeemed_by=$1, redeemed_at=NOW(), username=$2 WHERE code=$3`,
      [email, username, codeRaw]
    );

    sendWelcomeEmail(email, 'basic')
      .catch(err => console.error('[redeem email]', err.message));

    notifyAdmin(
      `🎟️ Code redeemed!\n\n` +
      `Code: ${codeRaw}\n` +
      `Months: ${codeRow.months}\n` +
      `Email: ${email}`
    );

    res.json({ ok: true, email, plan: 'basic', months: codeRow.months });
  } catch(err) {
    console.error('[redeem]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const result = await db.query(
    'SELECT id, username, email, plan, order_ref, status, created_at, expires_at, password_is_temporary FROM users ORDER BY created_at DESC'
  );
  res.json({ count: result.rows.length, users: result.rows });
});

app.get('/api/admin/view', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const result = await db.query(
    'SELECT id, username, email, plan, status, created_at, expires_at FROM users ORDER BY created_at DESC'
  );
  const rows = result.rows.map(u =>
    `<tr><td>${u.id}</td><td>${u.email}</td><td>${u.plan}</td><td>${u.status}</td><td>${u.created_at}</td><td>${u.expires_at||'-'}</td></tr>`
  ).join('');
  res.send(`<html><body><h2>Users (${result.rows.length})</h2><table border=1 cellpadding=6 cellspacing=0>
    <tr><th>ID</th><th>Email</th><th>Plan</th><th>Status</th><th>Created</th><th>Expires</th></tr>
    ${rows}</table></body></html>`);
});

app.get('/api/admin/delete-user', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  await db.query('DELETE FROM activations WHERE email = $1', [email.toLowerCase()]);
  await db.query('DELETE FROM users WHERE email = $1', [email.toLowerCase()]);
  res.json({ ok: true, deleted: email });
});

// ── ADMIN: WIPE ALL TEST DATA (v1.2.3 clean slate) ────────────────────────────
// Requires ?confirm=YES_WIPE_ALL query param + admin key.
// Deletes ALL users, activations, and redeem code redemptions.
app.post('/api/admin/wipe-all-users', async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (req.query.confirm !== 'YES_WIPE_ALL') {
    return res.status(400).json({ error: 'Missing confirmation. Add ?confirm=YES_WIPE_ALL to the URL.' });
  }
  try {
    const usersBefore = await db.query('SELECT COUNT(*)::int AS n FROM users');
    await db.query('DELETE FROM activations');
    await db.query(`UPDATE redeem_codes SET status='unused', redeemed_by=NULL, redeemed_at=NULL, username=NULL WHERE status='redeemed'`);
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM forgot_requests');
    res.json({
      ok: true,
      message: `Wiped ${usersBefore.rows[0].n} users, all activations, all forgot-password logs. Redeem codes reset to unused.`,
    });
  } catch (err) {
    console.error('[wipe]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-user', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const newPassword = generateTempPassword();
    const hashed      = await bcrypt.hash(newPassword, 10);
    const result      = await db.query(
      `UPDATE users
         SET password=$1, password_is_temporary=TRUE, temp_password_expires=NOW()+INTERVAL '24 hours'
       WHERE email=$2 RETURNING username, plan`,
      [hashed, email.toLowerCase()]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    sendForgotPasswordEmail(email, newPassword)
      .catch(err => console.error('[reset email]', err.message));
    res.json({ ok: true, email, tempPassword: newPassword, note: 'Temp password sent by email; expires in 24 hours.' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/create-user', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { email, password, plan, order_ref, notes } = req.body;
  const months = parseInt(req.body.months) || 6;
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'valid email required' });
  const pass = password && isValidPassword(password) ? password : generateTempPassword();
  const isTemp = !password;
  const username = generateUsername();
  const hashed   = await bcrypt.hash(pass, 10);
  await db.query(
    `INSERT INTO users (username, password, email, plan, order_ref, status, notes, expires_at, password_is_temporary, temp_password_expires)
     VALUES ($1,$2,$3,$4,$5,'active',$6, NOW() + ($7 || ' months')::interval, $8, ${isTemp ? "NOW()+INTERVAL '24 hours'" : "NULL"})`,
    [username, hashed, email.toLowerCase(), plan||'basic', order_ref||'MANUAL', notes||'', String(months), isTemp]
  );
  if (isTemp) {
    sendForgotPasswordEmail(email, pass).catch(err => console.error('[create email]', err.message));
  } else {
    sendWelcomeEmail(email, plan||'basic').catch(err => console.error('[create email]', err.message));
  }
  res.json({ ok: true, email, tempPassword: isTemp ? pass : null });
});

// ── Stay Where ah? visits (unchanged) ────────────────────────────────────────
app.post('/api/visit', async (req, res) => {
  try { await db.query('INSERT INTO sw_visits DEFAULT VALUES'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/api/admin/stats', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
  try {
    const v  = await db.query('SELECT COUNT(*)::int AS n FROM sw_visits');
    const vt = await db.query("SELECT COUNT(*)::int AS n FROM sw_visits WHERE created_at >= date_trunc('day', now())");
    const l  = await db.query('SELECT COUNT(*)::int AS n FROM sw_leads');
    res.json({ ok: true, visits: v.rows[0].n, visits_today: vt.rows[0].n, leads: l.rows[0].n });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.post('/api/lead', async (req, res) => {
  try {
    const email  = String((req.body && req.body.email)  || '').trim().toLowerCase();
    const source = String((req.body && req.body.source) || 'report').slice(0, 40);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
    await db.query('INSERT INTO sw_leads (email, source) VALUES ($1, $2)', [email, source]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/api/admin/leads', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
  try {
    const r = await db.query('SELECT email, source, created_at FROM sw_leads ORDER BY created_at DESC');
    res.json({ ok: true, count: r.rows.length, leads: r.rows });
  } catch (e) { res.status(500).json({ ok: false }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// REDEEM CODE ADMIN
// ══════════════════════════════════════════════════════════════════════════════
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

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

app.get('/api/admin/codes', async (req, res) => {
  if ((req.headers['x-admin-key'] || req.query.key) !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const result = await db.query('SELECT code, months, batch, status, redeemed_by, redeemed_at, created_at FROM redeem_codes ORDER BY created_at DESC LIMIT 1000');
  const unused   = result.rows.filter(r => r.status === 'unused').length;
  const redeemed = result.rows.filter(r => r.status === 'redeemed').length;
  res.json({ total: result.rows.length, unused, redeemed, codes: result.rows });
});

app.listen(PORT, () => console.log('ShepherdLab API v1.2.3 running on port', PORT));
