// plans.js
// Single source of truth for tiers. Update the priceId values after you
// create the matching Products/Prices in the Stripe Dashboard (see README).

const PLANS = {
  free: {
    name: 'Free',
    priceId: null, // no Stripe price — issued directly, no checkout needed
    monthlyLimit: 100,
  },
  build: {
    name: 'Build',
    priceId: process.env.STRIPE_PRICE_BUILD || 'price_REPLACE_WITH_BUILD_PRICE_ID',
    monthlyLimit: 5000,
  },
  scale: {
    name: 'Scale',
    priceId: process.env.STRIPE_PRICE_SCALE || 'price_REPLACE_WITH_SCALE_PRICE_ID',
    monthlyLimit: 25000,
  },
};

// Reverse lookup: Stripe price ID -> plan key. Used by the webhook to know
// which plan a customer just subscribed to.
function planForPriceId(priceId) {
  return Object.entries(PLANS).find(([, p]) => p.priceId === priceId)?.[0] || null;
}

module.exports = { PLANS, planForPriceId };
