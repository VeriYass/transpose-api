// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const Stripe = require('stripe');

const db = require('./db');
const { PLANS, planForPriceId } = require('./plans');
const { requireApiKey, authenticateApiKey } = require('./middleware');
const { convert, SUPPORTED_FORMATS } = require('./convert');
const mailer = require('./mailer');

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

    // We respond to Stripe immediately (res.json below) rather than waiting
    // on these DB writes to finish — Stripe expects a fast ack and will
    // retry on timeout. Errors are logged, not surfaced to the webhook caller.
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const stripeCustomerId = session.customer;

        // ---------------------------------------------------------------
        // Free tier: a $0 card-verification session (mode: 'setup'), no
        // subscription attached. We still require a card on file so the
        // same person can't stack up unlimited 50-call allowances just by
        // reusing a new email address each time — the card's Stripe
        // "fingerprint" is stable across signups even when the email,
        // name, and Stripe customer object are all different.
        // ---------------------------------------------------------------
        if (session.mode === 'setup') {
          (async () => {
            try {
              const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);
              const paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method);
              const fingerprint = paymentMethod.card?.fingerprint || null;
              const email = session.customer_details?.email;

              // Two independent checks, because neither alone is reliable:
              // fingerprint catches the same card under a different email,
              // but Apple Pay/Google Pay tokenize to a device-specific DPAN
              // and can legitimately produce a different fingerprint for
              // the *same physical card* (confirmed in Stripe's own docs).
              // Email catches that case. This is also the authoritative
              // guard against a race with the /api/checkout short-circuit
              // above (two concurrent signups for the same email).
              const existingCustomerId =
                (fingerprint ? await db.getCustomerIdByCardFingerprint(fingerprint) : null) ||
                (email ? await db.getCustomerIdByEmail(email, 'free') : null);

              if (existingCustomerId) {
                // Same card OR same email already has a free key under a
                // different customer id. Record this new customer id (so we
                // have an audit trail of the attempt) but do NOT mint a
                // second key — /api/key-for-session falls back to both
                // lookups so this session still resolves to the ORIGINAL key.
                await db.upsertCustomer(stripeCustomerId, {
                  email,
                  plan: 'free',
                  status: 'duplicate_signup',
                  cardFingerprint: fingerprint,
                });
                console.log(`⚠️  Free signup ${stripeCustomerId} (${email || 'no email'}) matches existing free customer ${existingCustomerId} — no new key issued.`);
                return;
              }

              await db.upsertCustomer(stripeCustomerId, {
                email: session.customer_details?.email,
                plan: 'free',
                status: 'active',
                cardFingerprint: fingerprint,
              });
              const apiKey = `tp_free_${nanoid(32)}`;
              await db.createApiKey(apiKey, stripeCustomerId, 'free');
              console.log(`✅ New free subscriber ${stripeCustomerId} (card verified) — API key: ${apiKey}`);
            } catch (err) {
              console.error('Failed to process free card verification:', err);
            }
          })();
          break;
        }

        // ---------------------------------------------------------------
        // Paid tiers: real subscription.
        // ---------------------------------------------------------------
        stripe.subscriptions
          .retrieve(session.subscription)
          .then(async (sub) => {
            const priceId = sub.items.data[0].price.id;
            const plan = planForPriceId(priceId) || 'build';

            await db.upsertCustomer(stripeCustomerId, {
              email: session.customer_details?.email,
              plan,
              subscriptionId: sub.id,
              status: 'active',
            });

            // Issue a fresh API key for this customer.
            const apiKey = `tp_live_${nanoid(32)}`;
            await db.createApiKey(apiKey, stripeCustomerId, plan);

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
          db.updatePlanForCustomer(sub.customer, plan)
            .then(() => console.log(`🔄 Customer ${sub.customer} moved to plan: ${plan}`))
            .catch((err) => console.error('Failed to update plan:', err));
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        Promise.all([
          db.revokeApiKeysForCustomer(sub.customer),
          db.upsertCustomer(sub.customer, { status: 'canceled' }),
        ])
          .then(() => console.log(`🛑 Subscription canceled, API keys revoked for ${sub.customer}`))
          .catch((err) => console.error('Failed to process cancellation:', err));
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

// Serve the customer-facing site (public/index.html) at the root URL.
// { extensions: ['html'] } makes /success resolve to public/success.html,
// since Stripe redirects to a clean path with no .html suffix.
app.use(express.static('public', { extensions: ['html'] }));

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Conversion endpoint (the actual product) ----
app.post('/v1/convert', requireApiKey, async (req, res) => {
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
    await db.recordUsage(req.apiKey);
    // req.used was computed by requireApiKey BEFORE this request's own
    // recordUsage() call, so the true post-request total is req.used + 1.
    // (The old code used recordUsage's return value here, which is only
    // today's per-day bucket count — not the running total the limit is
    // actually enforced against. That made the number shown after every
    // conversion wrong, e.g. "3 calls used" on someone's 47th call.)
    res.json({
      result,
      usage: { used: req.used + 1, limit: req.planLimit, plan: req.plan },
    });
  } catch (err) {
    res.status(422).json({ error: 'conversion_failed', message: err.message });
  }
});

// ---- Signup / upgrade: create a Stripe Checkout session ----
// Free and paid plans both go through Stripe now. Free uses mode: 'setup' —
// a $0 session that verifies a real card without charging it, so the same
// person can't stack up multiple 50-call allowances by reusing a fresh
// email each time (see the webhook handler's fingerprint-dedup logic).
// Paid plans use the normal mode: 'subscription' flow, unchanged.
app.post('/api/checkout', async (req, res) => {
  const { plan, email } = req.body || {};

  if (plan === 'free') {
    if (!email) return res.status(400).json({ error: 'email_required' });
    try {
      // Fix (spotted by Yasser): the fingerprint dedup in the webhook below
      // only catches repeats when Stripe can compute the fingerprint from
      // the real card number. For Apple Pay / Google Pay, Stripe computes it
      // from a device-specific tokenized number (DPAN) instead — Stripe's
      // own docs confirm the same physical card re-added or used from a
      // different device can produce a DIFFERENT fingerprint. So a wallet
      // payer resubmitting this form with the same email could keep getting
      // a fresh 50-call allowance forever, fingerprint check or not.
      // getCustomerIdByEmail already existed in db.js (built + unit tested)
      // but was never actually called here — this wires it in as the
      // primary, payment-method-independent check, with fingerprint as a
      // secondary backstop (see the webhook handler) against the same card
      // being used under several different emails.
      const existingCustomerId = await db.getCustomerIdByEmail(email, 'free');
      if (existingCustomerId) {
        const existingKey = await db.getApiKeyByCustomer(existingCustomerId);
        if (existingKey) {
          const used = await db.getUsageTotal(existingKey);
          const cap = PLANS.free.limit;
          return res.json({
            apiKey: existingKey,
            existing: true,
            used,
            cap,
            capReached: used >= cap,
            message: used >= cap
              ? `This email's free key has used all ${cap} lifetime calls — upgrade to keep converting.`
              : "This email already has a free Transpose key — reusing it instead of issuing a new one.",
          });
        }
      }

      // Controlled gate (Yasser): no Stripe card-verification session gets
      // created here anymore. Instead, we email a one-time confirmation
      // link — clicking it is the ONLY path that reaches
      // stripe.checkout.sessions.create for the free plan (see GET
      // /verify-email below). This closes the "just type any email, real
      // or not" gap the dedup checks above can't close on their own.
      const token = await db.createEmailVerification(email, 'free');
      const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify-email?token=${token}`;
      await mailer.sendVerificationEmail(email, verifyUrl);
      return res.json({
        pendingVerification: true,
        message: `Check ${email} for a confirmation link — click it to continue to card verification. The link expires in 30 minutes.`,
      });
    } catch (err) {
      console.error('Free signup verification-email step failed:', err.message);
      return res.status(500).json({ error: 'verification_failed', message: err.message });
    }
  }

  const planConfig = PLANS[plan];
  if (!planConfig || !planConfig.priceId) {
    return res.status(400).json({
      error: 'invalid_plan',
      message: `"plan" must be one of: free, ${Object.keys(PLANS).filter((p) => PLANS[p].priceId).join(', ')}`,
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

// ---- Controlled gate: the ONLY route that creates a free-plan Stripe
// checkout session. Reached exclusively by clicking the link sent in
// /api/checkout's verification email — there is no other path to it. A
// token consumes itself on first use (see db.consumeEmailVerification),
// so replaying an old email link can't spawn a second session.
app.get('/verify-email', async (req, res) => {
  const { token } = req.query || {};
  if (!token) return res.status(400).send('Missing verification token.');

  const result = await db.consumeEmailVerification(String(token));
  if (!result) {
    return res.status(400).send(
      'This verification link is invalid, expired, or has already been used. ' +
      'Go back to the site and request a new one.'
    );
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      payment_method_types: ['card'],
      customer_email: result.email,
      customer_creation: 'always',
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}&plan=free`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/cancel`,
    });
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Post-verification checkout session creation failed:', err.message);
    return res.status(500).send('Could not start card verification. Go back to the site and try again.');
  }
});

// ---- After-checkout key retrieval ----
// Stripe redirects to /success?session_id={CHECKOUT_SESSION_ID}[&plan=free].
// The success page polls this endpoint until the webhook has issued the key.
app.get('/api/key-for-session', async (req, res) => {
  const { session_id: sessionId } = req.query || {};
  if (!sessionId || !String(sessionId).startsWith('cs_')) {
    return res.status(400).json({ error: 'bad_session_id' });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(String(sessionId));

    if (session.mode === 'setup') {
      // Free tier: "paid" isn't a concept here — completion is what matters.
      if (session.status !== 'complete') {
        return res.status(402).json({ error: 'not_completed' });
      }
      let apiKey = await db.getApiKeyByCustomer(session.customer);
      if (!apiKey) {
        // No key under THIS session's customer id — either the webhook
        // hasn't run yet, or (duplicate-signup case) the key actually lives
        // under an earlier customer id. Try resolving by card fingerprint
        // first, then by email (fingerprint alone misses Apple Pay/Google
        // Pay repeats — see the webhook handler's comment) before giving up
        // and telling the client to keep polling.
        try {
          const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent);
          const paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method);
          const fingerprint = paymentMethod.card?.fingerprint;
          if (fingerprint) {
            const existingCustomerId = await db.getCustomerIdByCardFingerprint(fingerprint);
            if (existingCustomerId) apiKey = await db.getApiKeyByCustomer(existingCustomerId);
          }
          if (!apiKey && session.customer_details?.email) {
            const existingCustomerId = await db.getCustomerIdByEmail(session.customer_details.email, 'free');
            if (existingCustomerId) apiKey = await db.getApiKeyByCustomer(existingCustomerId);
          }
        } catch (lookupErr) {
          console.error('Duplicate-signup fallback lookup failed:', lookupErr.message);
        }
      }
      if (!apiKey) return res.status(202).json({ status: 'pending' });
      return res.json({ apiKey, plan: 'free' });
    }

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'not_paid' });
    }
    const apiKey = await db.getApiKeyByCustomer(session.customer);
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
app.get('/api/usage', authenticateApiKey, (req, res) => {
  res.json({ plan: req.plan, used: req.used, limit: req.planLimit });
});

// ---------------------------------------------------------------------------
// Boot: schema must exist before we accept traffic. If Postgres is
// unreachable or DATABASE_URL is missing, this throws/rejects and the
// process exits rather than serving requests against a broken store.
// ---------------------------------------------------------------------------
async function start() {
  await db.initSchema();
  app.listen(PORT, () => {
    console.log(`Transpose API running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('FATAL: failed to start server:', err.message);
  process.exit(1);
});

module.exports = app;
