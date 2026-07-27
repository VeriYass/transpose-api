// plans.js
// Single source of truth for tiers. Update the priceId values after you
// create the matching Products/Prices in the Stripe Dashboard (see README).
//
// resetPeriod matters: 'lifetime' means the limit is a flat cap that never
// renews (Free is 50 calls, ever — not 50/month); 'monthly' means it resets
// every calendar month (Build/Scale). middleware.js branches on this.

const PLANS = {
  free: {
    name: 'Free',
    // No Stripe *price* (it's $0), but it DOES go through Stripe Checkout —
    // mode: 'setup' in server.js, a card-verification session with no
    // charge. priceId stays null; server.js branches on plan === 'free'
    // before ever consulting priceId.
    priceId: null,
    limit: 50,
    resetPeriod: 'lifetime',
  },
  build: {
    name: 'Build',
    priceId: process.env.STRIPE_PRICE_BUILD || 'price_REPLACE_WITH_BUILD_PRICE_ID',
    limit: 5000,
    resetPeriod: 'monthly',
  },
  scale: {
    name: 'Scale',
    priceId: process.env.STRIPE_PRICE_SCALE || 'price_REPLACE_WITH_SCALE_PRICE_ID',
    limit: 25000,
    resetPeriod: 'monthly',
  },
};

// Reverse lookup: Stripe price ID -> plan key. Used by the webhook to know
// which plan a customer just subscribed to.
function planForPriceId(priceId) {
  return Object.entries(PLANS).find(([, p]) => p.priceId === priceId)?.[0] || null;
}

module.exports = { PLANS, planForPriceId };
