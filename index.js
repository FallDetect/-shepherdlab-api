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

// ══════════════════════════════════════════════════════════════════════════════
// PLAY BILLING SUBSCRIPTION ENDPOINTS (v1.1)
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
// }
//
// Returns for a NEW purchase:
//   { ok: true, existing: false, username, password, plan: 'premium', expires_at }
// Returns for an EXISTING purchase token (renewal / re-verify):
//   { ok: true, existing: true, username, plan: 'premium', expires_at }
app.post('/api/grant-premium', async (req, res) => {
  try {
    const { purchaseToken, productId, packageName, orderId } = req.body || {};

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

    // New purchase — create user
    const username    = generateUsername();
    const rawPassword = generatePassword();
    const hashed      = await bcrypt.hash(rawPassword, 10);
    // Synthetic email so we satisfy the UNIQUE NOT NULL constraint.
    // Never used for delivery — Play subs don't need it.
    const syntheticEmail = username + '@play.premium';
    const orderRefTag    = 'PLAY_' + (orderId || purchaseToken.substring(0, 20));

    const inserted = await db.query(
      `INSERT INTO users
         (username, password, email, plan, order_ref, status, expires_at, purchase_token, product_id)
       VALUES
         ($1, $2, $3, 'premium', $4, 'active',
          NOW() + INTERVAL '${EXTEND_INTERVAL}', $5, $6)
       RETURNING expires_at`,
      [username, hashed, syntheticEmail, orderRefTag, purchaseToken, productId]
    );

    notifyAdmin(
      `💳 New Play subscription!\n\n` +
      `Product: ${productId}\n` +
      `Username: ${username}\n` +
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
   
