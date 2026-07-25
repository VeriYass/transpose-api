// middleware.js

const db = require('./db');
const { PLANS } = require('./plans');

function requireApiKey(req, res, next) {
  const header = req.headers['authorization'] || '';
  const apiKey = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!apiKey) {
    return res.status(401).json({
      error: 'missing_api_key',
      message: 'Include your key as: Authorization: Bearer YOUR_KEY',
    });
  }

  const record = db.getApiKey(apiKey);
  if (!record || !record.active) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'This key is invalid or has been revoked.',
    });
  }

  const plan = PLANS[record.plan] || PLANS.free;
  const usedThisMonth = db.getUsageThisMonth(apiKey);

  if (usedThisMonth >= plan.monthlyLimit) {
    return res.status(429).json({
      error: 'monthly_limit_reached',
      message: `You've used ${usedThisMonth}/${plan.monthlyLimit} calls on the ${plan.name} plan this month. Upgrade at /api/checkout.`,
    });
  }

  req.apiKey = apiKey;
  req.plan = record.plan;
  req.usedThisMonth = usedThisMonth;
  req.planLimit = plan.monthlyLimit;
  next();
}

module.exports = { requireApiKey };
