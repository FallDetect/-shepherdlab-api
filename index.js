require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const { nanoid } = require('nanoid');

const app    = express();
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
const db     = new Database(process.env.DB_PATH || './fallguard.db');

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://shepherdlab.life',
    'https://www.shepherdlab.life',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ]
}));
app.use(express.json());

// ── DATABASE SETUP ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'basic',
    order_ref   TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT,
    notes       TEXT
  );

  CREATE TABLE IF NOT EXISTS activations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_ref    TEXT NOT NULL,
    email        TEXT NOT NULL,
    plan         TEXT NOT NULL,
    username     TEXT NOT NULL,
    activated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip           TEXT
  );
`);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateUsername() {
  // e.g. user_k3x9p
  return 'user_' + nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
}

function generatePassword() {
  // 8-char readable password e.g. Teal4-Xk9m
  const words  = ['Teal','Care','Safe','Watch','Fall','Guard','Shield','Help'];
  const word   = words[Math.floor(Math.random() * words.length)];
  const nums   = Math.floor(Math.random() * 90 + 10);
  const suffix = nanoid(4).replace(/[^a-zA-Z0-9]/g, 'x');
  return `${word}${nums}-${suffix}`;
}

function isValidShopeeOrderRef(ref) {
  // Shopee SG order numbers: typically 18 digits or alphanumeric ~15-20 chars
  // Accept anything 8-25 chars alphanumeric (flexible for manual orders too)
  return /^[A-Z0-9a-z\-_]{8,25}$/.test(ref.trim());
}

async function sendWelcomeEmail(email, username, password, plan, isBundle=false) {
  const planLabel  = plan === 'pro' ? 'Pro' : 'Basic';
  const price      = plan === 'pro' ? '$20/month' : '$15/month';
  const bundleNote = isBundle ? '6 months free — included with your Shopee wheelchair purchase' : planLabel + ' Plan · ' + price;
  const apkUrl    = process.env.APK_URL || 'https://shepherdlab.life/download.html';

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'DM Sans', Arial, sans-serif; background: #0D1B2A; color: #E8EDF2; margin: 0; padding: 0; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
  .logo { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 32px; }
  .logo span { color: #00A896; }
  h1 { font-size: 22px; color: #fff; margin-bottom: 8px; }
  p { font-size: 15px; color: #8BA0B4; line-height: 1.7; margin: 0 0 16px; }
  .cred-box { background: #122030; border: 1px solid rgba(0,168,150,0.3); border-radius: 10px; padding: 24px; margin: 24px 0; }
  .cred-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .cred-row:last-child { border-bottom: none; }
  .cred-label { font-size: 12px; color: #8BA0B4; text-transform: uppercase; letter-spacing: 0.08em; }
  .cred-val { font-size: 15px; color: #fff; font-weight: 600; font-family: monospace; background: rgba(0,168,150,0.1); padding: 4px 10px; border-radius: 4px; }
  .btn { display: block; background: #00A896; color: #0D1B2A; text-decoration: none; text-align: center; padding: 14px 24px; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 24px 0; }
  .steps { margin: 24px 0; }
  .step { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 16px; }
  .step-num { background: rgba(0,168,150,0.15); color: #00A896; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
  .step-text { font-size: 14px; color: #8BA0B4; line-height: 1.6; }
  .step-text strong { color: #fff; }
  .plan-badge { display: inline-block; background: rgba(0,168,150,0.15); color: #00A896; border: 1px solid rgba(0,168,150,0.3); border-radius: 4px; padding: 3px 10px; font-size: 12px; font-weight: 600; }
  .footer { margin-top: 40px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 12px; color: #4a6070; line-height: 1.8; }
  a { color: #00A896; }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">Shepherd<span>Lab</span></div>

  <h1>Welcome to FallGuard+ 🛡️</h1>
  <p>${isBundle ? 'Your Shopee wheelchair purchase includes <strong>6 months of FallGuard+ Basic — free</strong>. Your account is ready. Here are your login credentials — save these somewhere safe.' : 'Your account is ready. Here are your login credentials — save these somewhere safe.'}</p>

  <span class="plan-badge">${isBundle ? "🎁 6 Months Free — Shopee Bundle" : planLabel + " Plan · " + price}</span>

  <div class="cred-box">
    <div class="cred-row">
      <span class="cred-label">Username</span>
      <span class="cred-val">${username}</span>
    </div>
    <div class="cred-row">
      <span class="cred-label">Password</span>
      <span class="cred-val">${password}</span>
    </div>
    <div class="cred-row">
      <span class="cred-label">Plan</span>
      <span class="cred-val">${planLabel}</span>
    </div>
  </div>

  <a href="${apkUrl}" class="btn">Download FallGuard+ APK →</a>

  <div class="steps">
    <p style="color:#fff;font-weight:600;margin-bottom:12px">Getting started — 3 steps:</p>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text"><strong>Download the APK</strong> from the link above and install it on your Android phone.</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text"><strong>Set up Telegram alerts</strong> — search @userinfobot for your Chat ID, then search @FallGuardPlusBot and send /start.</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text"><strong>Sign in with your credentials above</strong>, enter patient name + Chat ID, and tap Start Monitoring. AI calibrates in 30 seconds.</div>
    </div>
  </div>

  ${isBundle ? '<p style="background:rgba(0,168,150,0.08);border:1px solid rgba(0,168,150,0.2);border-radius:8px;padding:12px 16px;font-size:13px;color:#8BA0B4;line-height:1.6"><strong style="color:#00A896">After 6 months:</strong> Your free access expires. Continue at SGD $15/month (Basic) or $20/month (Pro) at <a href="https://shepherdlab.life/fallguard.html" style="color:#00A896">shepherdlab.life</a></p>' : ''}
  <p>Need help? Reply to this email or WhatsApp us at <strong>+65 88357181</strong>. We respond within 24 hours.</p>

  <div class="footer">
    ShepherdLab · NHB Industrial Pte Ltd · UEN 202542682D<br>
    5038 Ang Mo Kio Industrial Park 2, #01-409, Singapore 569541<br>
    <a href="mailto:hello@shepherdlab.life">hello@shepherdlab.life</a> · <a href="https://shepherdlab.life">shepherdlab.life</a>
  </div>
</div>
</body>
</html>`;

  return transporter.sendMail({
    from:    `"FallGuard+ ShepherdLab" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `Your FallGuard+ ${planLabel} credentials`,
    html,
  });
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── POST /api/activate ────────────────────────────────────────────────────────
// Called from download.html when buyer submits order number + email + plan
app.post('/api/activate', async (req, res) => {
  try {
    const { order_ref, email } = req.body;
    const source = 'shopee';

    // Validate inputs
    if (!order_ref || !email || !plan) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    // Shopee bundle always gives Basic for 6 months free
    const plan = 'basic';
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    if (!isValidShopeeOrderRef(order_ref)) {
      return res.status(400).json({ error: 'Invalid order reference. Please check your Shopee order number.' });
    }

    const ref = order_ref.trim().toUpperCase();

    // Check if order already activated
    const existing = db.prepare('SELECT * FROM activations WHERE order_ref = ?').get(ref);
    if (existing) {
      return res.status(409).json({
        error: 'This order has already been activated.',
        hint:  `Check ${existing.email.replace(/(.{2}).*@/, '$1***@')} for your credentials, or contact hello@shepherdlab.life`,
      });
    }

    // Check if email already has an account
    const emailExists = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (emailExists) {
      return res.status(409).json({
        error: 'An account already exists for this email.',
        hint:  'Check your email for previous credentials, or contact hello@shepherdlab.life',
      });
    }

    // Generate credentials
    const username    = generateUsername();
    const rawPassword = generatePassword();
    const hashed      = await bcrypt.hash(rawPassword, 10);

    // Store user
    db.prepare(`
      INSERT INTO users (username, password, email, plan, order_ref, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'active', date('now', '+6 months'))
    `).run(username, hashed, email.toLowerCase(), plan, ref);

    // Log activation
    db.prepare(`
      INSERT INTO activations (order_ref, email, plan, username, ip)
      VALUES (?, ?, ?, ?, ?)
    `).run(ref, email.toLowerCase(), 'basic-shopee-6mo', username, req.ip);

    // Send welcome email
    await sendWelcomeEmail(email, username, rawPassword, 'basic', true); // true = shopee bundle, 6 months

    res.json({
      success:  true,
      message:  'Account created! Check your email for credentials.',
      username,
      plan,
    });

  } catch (err) {
    console.error('[activate]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again or contact hello@shepherdlab.life' });
  }
});

// ── POST /api/verify-login ────────────────────────────────────────────────────
// Called from FallGuard+ app to verify username/password
app.post('/api/verify-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Missing credentials.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'Account is not active. Contact hello@shepherdlab.life' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
    }

    res.json({
      ok:       true,
      username: user.username,
      plan:     user.plan,
      email:    user.email,
    });

  } catch (err) {
    console.error('[verify-login]', err);
    res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Simple admin endpoint — protected by admin key
app.get('/api/admin/users', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const users = db.prepare(`
    SELECT id, username, email, plan, order_ref, status, created_at, expires_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json({ count: users.length, users });
});

// GET /api/admin/activations
app.get('/api/admin/activations', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const rows = db.prepare('SELECT * FROM activations ORDER BY activated_at DESC').all();
  res.json({ count: rows.length, activations: rows });
});

// POST /api/admin/create-user (manual account creation for beta testers)
app.post('/api/admin/create-user', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const { email, plan, order_ref, notes } = req.body;
    const username    = generateUsername();
    const rawPassword = generatePassword();
    const hashed      = await bcrypt.hash(rawPassword, 10);

    db.prepare(`
      INSERT INTO users (username, password, email, plan, order_ref, status, notes)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(username, hashed, email.toLowerCase(), plan || 'basic', order_ref || 'MANUAL', notes || '');

    if (email && email.includes('@')) {
      await sendWelcomeEmail(email, username, rawPassword, plan || 'basic');
    }

    res.json({ ok: true, username, password: rawPassword, plan: plan || 'basic' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`ShepherdLab API running on port ${PORT}`));

// ══════════════════════════════════════════════════════════════════════════════
// STRIPE INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Stripe webhook needs raw body — must be before express.json() middleware
// We handle this with a separate raw body parser on the webhook route only
const getRawBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => data += chunk);
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

// ── POST /api/stripe/create-checkout ─────────────────────────────────────────
// Called when visitor clicks "Pay by Card" on the website
// Returns a Stripe Checkout URL to redirect to
app.post('/api/stripe/create-checkout', async (req, res) => {
  try {
    const { plan, email } = req.body;

    if (!['basic', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan.' });
    }

    // Stripe Price IDs — set these in env vars after creating products in Stripe dashboard
    const priceId = plan === 'pro'
      ? process.env.STRIPE_PRICE_PRO    // e.g. price_1Pxxxxxxxxxxxxxxxx
      : process.env.STRIPE_PRICE_BASIC; // e.g. price_1Pxxxxxxxxxxxxxxxx

    if (!priceId) {
      return res.status(500).json({ error: 'Payment not configured yet. Please contact hello@shepherdlab.life' });
    }

    const session = await stripe.checkout.sessions.create({
      mode:                'subscription',
      payment_method_types: ['card'],
      customer_email:      email || undefined,
      line_items: [{
        price:    priceId,
        quantity: 1,
      }],
      metadata: { plan },
      success_url: `https://shepherdlab.life/download.html?session={CHECKOUT_SESSION_ID}&source=stripe`,
      cancel_url:  `https://shepherdlab.life/fallguard.html?cancelled=1`,
      // Allow promo codes
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('[stripe/create-checkout]', err);
    res.status(500).json({ error: 'Could not create checkout session. Please try again.' });
  }
});

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
// Stripe calls this after successful payment
// Creates account + sends welcome email automatically
app.post('/api/stripe/webhook', async (req, res) => {
  let event;
  const sig = req.headers['stripe-signature'];

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful subscription creation
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email   = session.customer_details?.email || session.customer_email;
    const plan    = session.metadata?.plan || 'basic';
    const ref     = 'STRIPE_' + session.id.slice(-12).toUpperCase();

    try {
      // Check if already activated (idempotency)
      const existing = db.prepare('SELECT * FROM activations WHERE order_ref = ?').get(ref);
      if (existing) {
        console.log('[webhook] Already activated:', ref);
        return res.json({ received: true });
      }

      // Check if email already has account
      const emailExists = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
      if (emailExists) {
        console.log('[webhook] Email already exists:', email);
        return res.json({ received: true });
      }

      // Generate credentials
      const username    = generateUsername();
      const rawPassword = generatePassword();
      const hashed      = await bcrypt.hash(rawPassword, 10);

      // Save user
      db.prepare(`
        INSERT INTO users (username, password, email, plan, order_ref, status, expires_at)
        VALUES (?, ?, ?, ?, ?, 'active', date('now', '+1 month'))
      `).run(username, hashed, email.toLowerCase(), plan, ref);

      // Log activation
      db.prepare(`
        INSERT INTO activations (order_ref, email, plan, username, ip)
        VALUES (?, ?, ?, ?, ?)
      `).run(ref, email.toLowerCase(), plan, username, 'stripe-webhook');

      // Send welcome email
      await sendWelcomeEmail(email, username, rawPassword, 'basic', true); // true = shopee bundle, 6 months

      // Notify admin on Telegram
      if (process.env.ADMIN_TELEGRAM_CHAT_ID && process.env.TELEGRAM_BOT_TOKEN) {
        const msg = `💳 New Stripe payment!\n\n` +
          `Plan: ${plan.toUpperCase()}\nEmail: ${email}\n` +
          `Username: ${username}\nRef: ${ref}\n` +
          `Time: ${new Date().toLocaleString('en-SG')}`;
        fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: process.env.ADMIN_TELEGRAM_CHAT_ID, text: msg }),
        }).catch(() => {});
      }

      console.log(`[webhook] Activated ${plan} for ${email} → ${username}`);

    } catch (err) {
      console.error('[webhook] Account creation failed:', err);
      // Don't return 500 — Stripe will retry. Log and move on.
    }
  }

  // Handle subscription renewal (extend expiry)
  if (event.type === 'invoice.payment_succeeded') {
    const invoice    = event.data.object;
    const customerId = invoice.customer;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      const email    = customer.email;
      if (email) {
        db.prepare(`
          UPDATE users SET expires_at = date(expires_at, '+1 month')
          WHERE email = ? AND status = 'active'
        `).run(email.toLowerCase());
        console.log(`[webhook] Renewed subscription for ${email}`);
      }
    } catch (err) {
      console.error('[webhook] Renewal error:', err);
    }
  }

  // Handle subscription cancellation
  if (event.type === 'customer.subscription.deleted') {
    const sub        = event.data.object;
    const customerId = sub.customer;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      const email    = customer.email;
      if (email) {
        db.prepare(`UPDATE users SET status = 'cancelled' WHERE email = ?`)
          .run(email.toLowerCase());
        console.log(`[webhook] Cancelled subscription for ${email}`);
      }
    } catch (err) {
      console.error('[webhook] Cancellation error:', err);
    }
  }

  res.json({ received: true });
});

// ── GET /api/stripe/session-status ───────────────────────────────────────────
// download.html calls this after Stripe redirects back with ?session=xxx
// Returns plan so the page knows what the customer bought
app.get('/api/stripe/session-status', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    const plan    = session.metadata?.plan || 'basic';
    const email   = session.customer_details?.email || '';
    const paid    = session.payment_status === 'paid';

    res.json({ paid, plan, email });
  } catch (err) {
    console.error('[session-status]', err);
    res.status(500).json({ error: 'Could not retrieve session.' });
  }
});
