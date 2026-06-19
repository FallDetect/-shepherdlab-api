# ShepherdLab API — Render Deployment Guide

## What this is
A small Express API that handles FallGuard+ activation from Shopee purchases.
Buyers enter their Shopee order number → get APK link + credentials by email.

## Files structure
```
shepherdlab-api/          ← Deploy this as a Render Web Service
  server.js
  package.json
  .env.example

shepherdlab-main/         ← Deploy this as a Render Static Site (already exists)
  download.html           ← NEW — add this to your existing repo
  fallguard.html          ← UPDATED — pricing buttons now link to download.html
  (all other existing files unchanged)
```

---

## Step 1 — Push the new files to GitHub

In your existing `FallDetect/shepherdlab` repo:
```bash
# Add download.html
git add download.html fallguard.html
git commit -m "Add Shopee activation page + update pricing CTAs"
git push
```

Create a NEW repo for the API:
```bash
# Create FallDetect/shepherdlab-api on GitHub
# Then push:
cd shepherdlab-api
git init
git add .
git commit -m "Initial commit — FallGuard+ activation API"
git remote add origin https://github.com/FallDetect/shepherdlab-api.git
git push -u origin main
```

---

## Step 2 — Create PostgreSQL database on Render

1. Go to render.com → New → PostgreSQL
2. Name: `shepherdlab-db`
3. Plan: Free (sufficient for early stage)
4. Click Create Database
5. Copy the **External Database URL** — you'll need it in Step 3

---

## Step 3 — Deploy API as Render Web Service

1. Go to render.com → New → Web Service
2. Connect your `FallDetect/shepherdlab-api` repo
3. Settings:
   - Name: `shepherdlab-api`
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `node server.js`
   - Plan: Free (or Starter $7/mo for no sleep)

4. Add Environment Variables:
```
DATABASE_URL          = (paste from Step 2)
RESEND_API_KEY        = re_xxxxxxxxxxxxxxxxxxxxxxxx
APK_DOWNLOAD_URL      = https://shepherdlab.life/download/fallguardplus-latest.apk
ADMIN_SECRET          = (pick any long random string, e.g. SLab2026xK9mNpQ)
TELEGRAM_BOT_TOKEN    = (your FallGuardPlusBot token from BotFather)
ADMIN_TELEGRAM_CHAT_ID = 865161378 (your personal Telegram Chat ID)
```

5. Click Deploy

Your API will be live at: `https://shepherdlab-api.onrender.com`

---

## Step 4 — Host the APK file

Option A — Render Static Site (simplest):
1. Create a `/download/` folder in your shepherdlab repo
2. Add `fallguardplus-latest.apk` to it
3. Push to GitHub → Render deploys automatically
4. APK URL: `https://shepherdlab.life/download/fallguardplus-latest.apk`

Option B — Google Drive:
1. Upload APK to Google Drive
2. Right-click → Share → Anyone with link → Copy link
3. Convert to direct download: replace `/file/d/FILE_ID/view` with `/uc?export=download&id=FILE_ID`
4. Set `APK_DOWNLOAD_URL` to this URL

---

## Step 5 — Update download.html API URL

In `download.html`, find:
```js
var res = await fetch('https://shepherdlab-api.onrender.com/api/activate', {
```
This is already set correctly. No change needed if your Render service is named `shepherdlab-api`.

---

## Step 6 — Update Shopee listing

In your Shopee listing description, add:
```
After purchase:
1. Go to shepherdlab.life/download.html
2. Enter your Shopee order number and email
3. Check your inbox for your download link and login credentials
```

---

## Step 7 — Test end to end

1. Go to https://shepherdlab.life/download.html
2. Enter a fake order number like `TEST250430ABC123`
3. Enter your email
4. Select a plan
5. Click Activate
6. Check your inbox

---

## Admin — view all orders

GET https://shepherdlab-api.onrender.com/api/admin/orders
Header: x-admin-secret: (your ADMIN_SECRET value)

Or use curl:
```bash
curl https://shepherdlab-api.onrender.com/api/admin/orders \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

---

## Update the app login (future)

When you're ready to replace abc/123 with real logins, update LoginScreen.js:

```js
// Replace the BETA_USERS check with:
async function handleLogin() {
  const res = await fetch('https://shepherdlab-api.onrender.com/api/verify-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (data.ok) {
    // Save session, proceed to setup
    onLogin(data.username, data.plan);
  } else {
    setError(data.error);
  }
}
```

---

## Resend setup

1. Go to resend.com → sign up
2. Add domain `shepherdlab.life` (verify DNS — same as you did for shepherdforms.com)
3. Create API key → copy to RESEND_API_KEY env var
4. Emails will come from `hello@shepherdlab.life`
