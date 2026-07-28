// mailer.js
// Sends the free-signup verification email via Resend
// (https://resend.com/docs/api-reference/emails/send-email).
//
// Without RESEND_API_KEY set, this falls back to logging the link to the
// console instead of failing — same "degrade gracefully in dev, real
// behavior once the key is set" pattern as ADMIN_TOKEN elsewhere in this
// codebase. In production, RESEND_API_KEY must be set in Railway or every
// free signup silently never receives its email.
//
// Setup (one-time, manual — see README): sign up at resend.com (free tier,
// no card required), verify a sending domain (or use their shared
// onboarding@resend.dev sender for testing), copy the API key from the
// dashboard, set RESEND_API_KEY in Railway's environment variables.

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendVerificationEmail(email, verifyUrl) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[dev — RESEND_API_KEY not set] Verification link for ${email}: ${verifyUrl}`);
    return { simulated: true };
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'Transpose <onboarding@resend.dev>',
      to: email,
      subject: 'Confirm your email to get your free Transpose API key',
      html: `
        <p>Click the link below to confirm this email and continue to the (free, uncharged) card verification step:</p>
        <p><a href="${verifyUrl}">${verifyUrl}</a></p>
        <p>This link expires in 30 minutes and can only be used once. If you didn't request this, ignore it.</p>
      `,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${text}`);
  }

  return res.json();
}

module.exports = { sendVerificationEmail };
