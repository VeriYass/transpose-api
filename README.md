# Transpose API — turnkey backend

A working API for the CSV/JSON/YAML/XML converter, with API key auth,
per-plan usage limits, and Stripe subscriptions wired end-to-end. Tested
locally — signup, conversion, usage tracking, and auth rejection all work.

## What's already done for you
- `POST /v1/convert` — the actual product, protected by API key + monthly limit
- `POST /api/signup-free` — issues a free-tier key instantly, no payment
- `POST /api/checkout` — creates a Stripe Checkout session for Build/Scale plans
- `POST /webhook/stripe` — listens for successful payments, issues a live API key,
  and handles upgrades/downgrades/cancellations automatically
- `GET /api/usage` — lets a customer check their own usage against their limit

## What you need to do (15–20 minutes)

### 1. Get your Stripe keys
Dashboard → Developers → API keys. Copy the **Secret key** (starts `sk_test_`
while testing, `sk_live_` when you're ready for real money).

### 2. Create two Products in Stripe
Dashboard → Product catalog → Add product, for each of:
- **Build** — $19.00/month, recurring
- **Scale** — $49.00/month, recurring

For each, copy the **Price ID** (starts `price_...`) — not the Product ID.

### 3. Set up the webhook
Dashboard → Developers → Webhooks → Add endpoint.
- Endpoint URL: `https://YOUR-DEPLOYED-URL/webhook/stripe`
- Events to send: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`
- Copy the **Signing secret** (starts `whsec_...`)

You can't fully test the webhook until this is deployed with a public URL —
Stripe needs to reach it. Use the Stripe CLI (`stripe listen --forward-to
localhost:3000/webhook/stripe`) to test locally first if you want.

### 4. Fill in your `.env`
```
cp .env.example .env
```
Then fill in the four values from steps 1–3.

### 5. Run it
```
npm install
npm start
```
Visit `http://localhost:3000/health` — should return `{"ok":true}`.

### 6. Test the flow
```bash
# Get a free key
curl -X POST localhost:3000/api/signup-free \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'

# Use it
curl -X POST localhost:3000/v1/convert \
  -H "Authorization: Bearer YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"from":"csv","to":"json","data":"name,age\nPriya,31"}'
```

### 7. Deploy it
This needs to run somewhere that stays alive and is reachable over HTTPS —
your laptop won't work for real customers. Easiest options:
- **Railway** (railway.app) — connect this repo, set your `.env` values as
  environment variables in their dashboard, done. Free tier is enough to start.
- **Render** (render.com) — same idea, similarly simple.

After deploying, go back to step 3 and point the Stripe webhook at your real
URL, and update `APP_URL` in your env vars to match.

### 8. Connect the front-end
The `converter.html` tool from earlier should call `/api/signup-free` and
`/api/checkout` on this backend instead of running everything client-side.
Point its fetch calls at your deployed URL.

## Going to production (once this has real paying customers)

The data store (`db.js`) is a JSON file — fine for launch, but it will not
survive concurrent writes at scale and Railway/Render's filesystem isn't
guaranteed persistent across deploys. Before you have more than a handful of
customers, swap it for a real database:
- Provision a Postgres instance (Railway and Render both offer one-click Postgres)
- Replace the functions in `db.js` with equivalent SQL queries — the function
  signatures (`getApiKey`, `recordUsage`, etc.) are the same, so nothing else
  in the app needs to change.

Also before taking real payments:
- Switch Stripe keys from `sk_test_...` to `sk_live_...`
- Actually email the API key to customers on signup (Resend or Postmark are
  simple) — right now it only logs to console
- Decide on a grace period for `invoice.payment_failed` instead of leaving
  the TODO in `server.js`

## File map
```
server.js       — routes: convert, signup, checkout, webhook, usage
convert.js      — the actual CSV/JSON/YAML/XML conversion logic
db.js           — data storage (JSON file; swap for Postgres later)
plans.js        — tier definitions: limits + Stripe price IDs
middleware.js   — API key auth + monthly limit enforcement
```
