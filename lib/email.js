// Thin wrapper over Resend - every call site (password reset, email
// verification, and whatever future transactional email this app grows)
// goes through sendEmail() below rather than touching the Resend SDK
// directly, so provider swaps or a dry-run mode stay a one-file change.
const { Resend } = require('resend');

let client = null;
function resendClient() {
  if (!client && process.env.RESEND_API_KEY) {
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

const FROM = 'Ahead <noreply@aheadt1d.com>';

async function sendEmail(to, subject, html) {
  const c = resendClient();
  if (!c) {
    console.log(`[Local Email] To: ${to} | Subject: ${subject}`);
    const linkMatch = html.match(/href="([^"]+)"/);
    if (linkMatch) {
      console.log(`[Local Email Link]: ${linkMatch[1]}`);
    }
    return { id: 'local-send' };
  }
  const result = await c.emails.send({ from: FROM, to, subject, html });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message || result.error.name || 'unknown error'}`);
  }
  return result.data;
}

// Shared wrapper, not a full templating system - two emails total exist in
// this app right now. If a third or fourth shows up, revisit.
function emailShell(bodyHtml) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0D0618;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0618;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:420px;background:#160D27;border:1px solid #2A1A4A;border-radius:20px;padding:28px;">
        <tr><td>
          <p style="margin:0 0 20px;color:#A78BFA;font-size:13px;font-weight:bold;letter-spacing:0.15em;text-transform:uppercase;">Ahead</p>
          ${bodyHtml}
        </td></tr>
      </table>
      <p style="margin:20px 0 0;color:#7C6FA0;font-size:11px;">If you didn't request this, you can safely ignore this email.</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function buttonHtml(href, label) {
  return `<a href="${href}" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#8B5CF6;color:#FFFFFF;text-decoration:none;border-radius:14px;font-weight:bold;font-size:14px;">${label}</a>`;
}

async function sendPasswordResetEmail(to, resetUrl) {
  const html = emailShell(`
    <p style="margin:0 0 4px;color:#E2D9F3;font-size:18px;font-weight:bold;">Reset your password</p>
    <p style="margin:0;color:#7C6FA0;font-size:13px;line-height:1.5;">Someone (hopefully you) asked to reset the password on this account. This link expires in 30 minutes and only works once.</p>
    ${buttonHtml(resetUrl, 'Reset password')}
  `);
  await sendEmail(to, 'Reset your Ahead password', html);
}

async function sendVerificationEmail(to, verifyUrl) {
  const html = emailShell(`
    <p style="margin:0 0 4px;color:#E2D9F3;font-size:18px;font-weight:bold;">Verify your email</p>
    <p style="margin:0;color:#7C6FA0;font-size:13px;line-height:1.5;">Confirming this address lets other people safely share their glucose data with your account. This link expires in 24 hours.</p>
    ${buttonHtml(verifyUrl, 'Verify email')}
  `);
  await sendEmail(to, 'Verify your Ahead email', html);
}

async function sendPasswordChangedEmail(to) {
  const html = emailShell(`
    <p style="margin:0 0 4px;color:#E2D9F3;font-size:18px;font-weight:bold;">Your password was changed</p>
    <p style="margin:0;color:#7C6FA0;font-size:13px;line-height:1.5;">The password for your Ahead account was just changed. All existing app sessions and device keys have been signed out as a precaution.</p>
    <p style="margin:16px 0 0;color:#7C6FA0;font-size:13px;line-height:1.5;">If you did not make this change, reset your password immediately or contact support.</p>
  `);
  await sendEmail(to, 'Your Ahead password was changed', html);
}

module.exports = { sendEmail, sendPasswordResetEmail, sendVerificationEmail, sendPasswordChangedEmail };
