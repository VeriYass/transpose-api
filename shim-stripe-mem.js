// Fake Stripe SDK for testing the card-verification (mode: 'setup') free
// signup flow without hitting the real Stripe API — this sandbox's egress
// allowlist blocks api.stripe.com anyway (same restriction documented for
// storage.googleapis.com/cdnjs.cloudflare.com elsewhere in this project),
// and even with network access we shouldn't be minting real Stripe
// sessions from an automated test run.
//
// This only fakes the handful of methods server.js actually calls
// (checkout.sessions.create/retrieve, setupIntents.retrieve,
// paymentMethods.retrieve, subscriptions.retrieve, webhooks.constructEvent).
// It is NOT a general Stripe mock — it exists to prove OUR dedup logic
// (card fingerprint -> existing free key) behaves correctly given whatever
// shape Stripe's real API returns, same spirit as shim-pg-mem.js proving
// our SQL against a real (if in-memory) engine rather than mocking `pg`
// method-by-method.
//
// Usage: node -r ./shim-pg-mem.js -r ./shim-stripe-mem.js <test file>

const state = {
  sessions: new Map(), // session id -> session object
  setupIntents: new Map(), // seti id -> { payment_method }
  paymentMethods: new Map(), // pm id -> { card: { fingerprint } }
  nextId: 1,
  // Set by a test right before calling checkout.sessions.create to control
  // which card fingerprint that session's setup intent resolves to — this
  // is how tests simulate "the same physical card used again".
  nextFingerprint: null,
};

function nextIdFor(prefix) {
  return `${prefix}_test_${state.nextId++}`;
}

class FakeStripe {
  constructor() {
    this.checkout = {
      sessions: {
        create: async (params) => {
          const sessionId = nextIdFor('cs');
          const customerId = nextIdFor('cus');
          const isFree = params.mode === 'setup';
          let setupIntentId = null;

          if (isFree) {
            const fingerprint = state.nextFingerprint || nextIdFor('fp');
            state.nextFingerprint = null; // consumed — one-shot per session
            const pmId = nextIdFor('pm');
            state.paymentMethods.set(pmId, { card: { fingerprint } });
            setupIntentId = nextIdFor('seti');
            state.setupIntents.set(setupIntentId, { payment_method: pmId });
          }

          const session = {
            id: sessionId,
            mode: params.mode,
            customer: customerId,
            customer_details: { email: params.customer_email },
            status: 'complete', // fake Checkout: instantly "completed"
            setup_intent: setupIntentId,
            subscription: isFree ? null : nextIdFor('sub'),
            payment_status: isFree ? undefined : 'paid',
            url: `https://checkout.stripe.test/${sessionId}`,
          };
          state.sessions.set(sessionId, session);
          return session;
        },
        retrieve: async (sessionId) => {
          const session = state.sessions.get(sessionId);
          if (!session) throw new Error('No such session: ' + sessionId);
          return session;
        },
      },
    };

    this.setupIntents = {
      retrieve: async (setupIntentId) => {
        const si = state.setupIntents.get(setupIntentId);
        if (!si) throw new Error('No such setup intent: ' + setupIntentId);
        return si;
      },
    };

    this.paymentMethods = {
      retrieve: async (pmId) => {
        const pm = state.paymentMethods.get(pmId);
        if (!pm) throw new Error('No such payment method: ' + pmId);
        return pm;
      },
    };

    this.subscriptions = {
      // Minimal shape server.js needs for the existing paid-plan webhook path.
      retrieve: async (subId) => ({
        id: subId,
        items: { data: [{ price: { id: state.nextPriceId || 'price_build_test' } }] },
      }),
    };

    this.webhooks = {
      // Bypasses real signature verification — tests POST the raw JSON
      // event body directly and get back the parsed event, matching the
      // shape a real Stripe webhook delivers.
      constructEvent: (payload) => JSON.parse(payload.toString()),
    };
  }
}

FakeStripe.__state = state; // exposed so tests can drive fingerprint reuse

const stripeMainPath = require.resolve('stripe');
delete require.cache[stripeMainPath];
require.cache[stripeMainPath] = {
  id: stripeMainPath,
  filename: stripeMainPath,
  loaded: true,
  exports: FakeStripe,
};
