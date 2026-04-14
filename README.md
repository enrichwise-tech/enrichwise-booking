# Enrichwise — Booking Flow
## Complete Setup Guide (no prior dev experience needed)

---

## What this is

A 4-step booking flow:
1. Client enters mobile number
2. Receives OTP on WhatsApp (via WATI)
3. Selects existing corpus range
4. Redirected to the right Zoho Bookings page

---

## What you need (all free or already paid)

| Tool | What for | Cost |
|---|---|---|
| [Vercel](https://vercel.com) | Host the page + run backend | Free |
| [GitHub](https://github.com) | Store the code | Free |
| WATI | Send WhatsApp OTP | Already have it |
| Zoho Bookings | Final slot booking | Already have it |

---

## Step 1 — Set up WATI OTP template

1. Log into your WATI dashboard
2. Go to **Template Messages → Create Template**
3. Use these settings:
   - **Template name:** `otp_verification` (note this exactly)
   - **Category:** Authentication
   - **Message body:**
     ```
     Your Enrichwise verification code is *{{1}}*. Valid for {{2}}.
     ```
4. Submit for WhatsApp approval — takes a few hours
5. Once approved, note the exact template name

---

## Step 2 — Get your WATI API credentials

1. In WATI dashboard → **Settings → API**
2. Copy your **API Endpoint URL** (looks like `https://live-server-XXXXX.wati.io`)
3. Copy your **API Token**

---

## Step 3 — Set up Zoho Bookings

Create two services in Zoho Bookings:

**Service 1:** Priority Wealth Session
- For corpus: ₹1 Cr – ₹5 Cr and ₹5 Cr+
- Copy the booking URL

**Service 2:** Discovery Call
- For corpus: Under ₹50L and ₹50L – ₹1 Cr
- Copy the booking URL

---

## Step 4 — Put the code on GitHub

1. Create a free account at [github.com](https://github.com)
2. Click **New repository** → name it `wealth-booking` → Create
3. Upload all files from this folder:
   - `index.html`
   - `api/send-otp.js`
   - `api/verify-otp.js`
   - `package.json`
   - `vercel.json`

---

## Step 5 — Deploy to Vercel

1. Create a free account at [vercel.com](https://vercel.com)
2. Click **Add New Project** → Import your GitHub repo
3. Click **Deploy** (Vercel auto-detects the config)
4. After deploy, copy your Vercel URL (e.g. `https://wealth-booking.vercel.app`)

---

## Step 6 — Add environment variables in Vercel

In Vercel → Your project → **Settings → Environment Variables**, add:

| Variable name | Value |
|---|---|
| `WATI_API_URL` | Your WATI endpoint, e.g. `https://live-server-12345.wati.io` |
| `WATI_API_TOKEN` | Your WATI API token |
| `WATI_TEMPLATE_NAME` | `otp_verification` (or whatever you named it) |

After adding, go to **Deployments → Redeploy** so they take effect.

---

## Step 7 — Add Vercel KV (OTP storage)

1. In Vercel dashboard → Your project → **Storage → Create Database → KV**
2. Name it anything → Create
3. Vercel automatically links it — no extra config needed

---

## Step 8 — Update the HTML with your URLs

Open `index.html` and update these 3 lines near the bottom:

```js
var ZOHO_INSTANT_URL  = 'https://bookings.zoho.in/portal/YOUR_PORTAL/Priority-Wealth-Session';
var ZOHO_CALLBACK_URL = 'https://bookings.zoho.in/portal/YOUR_PORTAL/Discovery-Call';
var API_BASE          = 'https://YOUR_VERCEL_URL.vercel.app';
```

Replace with your actual URLs. Then push to GitHub — Vercel auto-redeploys.

---

## Step 9 — Test it

1. Open your Vercel URL
2. Enter your own mobile number
3. You should receive a WhatsApp OTP from WATI within seconds
4. Enter OTP → select corpus → confirm it redirects to Zoho

---

## How the OTP works (simply)

```
Client enters mobile
       ↓
Vercel generates random 6-digit OTP
       ↓
Stores it securely for 10 minutes (Vercel KV)
       ↓
Calls WATI API → WATI sends WhatsApp message to client
       ↓
Client enters OTP → Vercel checks it matches → lets them through
       ↓
OTP deleted immediately (can't be reused)
```

Security included:
- OTP expires in 10 minutes
- Max 3 OTP requests per number per 10 minutes
- Max 5 wrong attempts before lockout
- OTP deleted after first successful use

---

## Troubleshooting

**OTP not received?**
- Check WATI template is approved (not pending)
- Check WATI API token is correct in Vercel env vars
- Check the number is registered on WhatsApp

**"Could not send OTP" error?**
- Check WATI_API_URL doesn't have a trailing slash
- Redeploy after adding env vars

**Zoho redirect not working?**
- Make sure Zoho Bookings URLs are correct and the services are published/active

---

## That's it

Once live, share the Vercel URL with your team and add a "Book appointment" button on your website that links to it.
