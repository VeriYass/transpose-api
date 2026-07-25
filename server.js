// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const Stripe = require('stripe');

const db = require('./db');
const { PLANS, planForPriceId } = require('./plans');
const { requireApiKey } = require('./middleware');
const { convert, SUPPORTED_FORMATS } = require('./convert');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing');
const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Stripe webhook needs the RAW body, so it must be registered BEFORE
// express.json() runs on the rest of the app.
// ---------------------------------------------------------------------------
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const stripeCustomerId = session.customer;
        // Fetch the subscription to know which price/plan was purchased.
        stripe.subscriptions
          .retrieve(session.subscription)
          .then((sub) => {
            const priceId = sub.items.data[0].price.id;
            const plan = planForPriceId(priceId) || 'build';

            db.upsertCustomer(stripeCustomerId, {
              email: session.customer_details?.email,
              plan,
              subscriptionId: sub.id,
              status: 'active',
            });

            // Issue a fresh API key for this customer.
            const apiKey = `tp_live_${nanoid(32)}`;
            db.createApiKey(apiKey, stripeCustomerId, plan);

            // In production: email this key to the customer (Postmark/Resend/etc)
            // instead of only logging it.
            console.log(`✅ New ${plan} subscriber ${stripeCustomerId} — API key: ${apiKey}`);
          })
          .catch((err) => console.error('Failed to process checkout completion:', err));
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items.data[0].price.id;
        const plan = planForPriceId(priceId);
        if (plan) {
          db.updatePlanForCustomer(sub.customer, plan);
          console.log(`🔄 Customer ${sub.customer} moved to plan: ${plan}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        db.revokeApiKeysForCustomer(sub.customer);
        db.upsertCustomer(sub.customer, { status: 'canceled' });
        console.log(`🛑 Subscription canceled, API keys revoked for ${sub.customer}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`⚠️ Payment failed for customer ${invoice.customer}`);
        // Consider a grace period before revoking keys, rather than revoking immediately.
        break;
      }

      default:
        // Unhandled event types are fine to ignore.
        break;
    }

    res.json({ received: true });
  }
);

// ---------------------------------------------------------------------------
// Everything below this line uses normal JSON parsing.
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve the customer-facing site (public/index.html) at the root URL
app.use(express.static('public'));

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Conversion endpoint (the actual product) ----
app.post('/v1/convert', requireApiKey, (req, res) => {
  const { from, to, data } = req.body || {};

  if (!from || !to || data === undefined) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Body must include "from", "to", and "data".',
      supportedFormats: SUPPORTED_FORMATS,
    });
  }

  try {
    const result = convert(String(data), from, to);
    const used = db.recordUsage(req.apiKey);
    res.json({
      result,
      usage: { used, limit: req.planLimit, plan: req.plan },
    });
  } catch (err) {
    res.status(422).json({ error: 'conversion_failed', message: err.message });
  }
});

// ---- Free tier signup: no payment, just issue a capped key ----
// Wire this to a real email-capture form. Kept deliberately simple here.
app.post('/api/signup-free', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email_required' });

  const fakeCustomerId = `free_${nanoid(16)}`;
  const apiKey = `tp_free_${nanoid(32)}`;

  db.upsertCustomer(fakeCustomerId, { email, plan: 'free', status: 'active' });
  db.createApiKey(apiKey, fakeCustomerId, 'free');

  res.json({ apiKey, plan: 'free', monthlyLimit: PLANS.free.monthlyLimit });
});

// ---- Paid tier signup: create a Stripe Checkout session ----
app.post('/api/checkout', async (req, res) => {
  const { plan, email } = req.body || {};
  const planConfig = PLANS[plan];

  if (!planConfig || !planConfig.priceId) {
    return res.status(400).json({
      error: 'invalid_plan',
      message: `"plan" must be one of: ${Object.keys(PLANS).filter((p) => PLANS[p].priceId).join(', ')}`,
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: planConfig.priceId, quantity: 1 }],
      customer_email: email,
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/cancel`,
    });
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Checkout session creation failed:', err.message);
    res.status(500).json({ error: 'checkout_failed', message: err.message });
  }
});

// ---- After-checkout key retrieval ----
// The Stripe payment link redirects to /success?session_id={CHECKOUT_SESSION_ID}.
// The success page polls this endpoint until the webhook has issued the key.
app.get('/api/key-for-session', async (req, res) => {
  const { session_id: sessionId } = req.query || {};
  if (!sessionId || !String(sessionId).startsWith('cs_')) {
    return res.status(400).json({ error: 'bad_session_id' });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(String(sessionId));
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'not_paid' });
    }
    const apiKey = db.getApiKeyByCustomer(session.customer);
    if (!apiKey) {
      // Webhook may not have processed yet; client will retry.
      return res.status(202).json({ status: 'pending' });
    }
    res.json({ apiKey });
  } catch (err) {
    console.error('key-for-session failed:', err.message);
    res.status(500).json({ error: 'lookup_failed' });
  }
});

// ---- Look up usage for the currently-authenticated key ----
app.get('/api/usage', requireApiKey, (req, res) => {
  res.json({ plan: req.plan, used: req.usedThisMonth, limit: req.planLimit });
});

app.listen(PORT, () => {
  console.log(`Transpose API running on http://localhost:${PORT}`);
});
