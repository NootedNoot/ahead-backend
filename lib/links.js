// Base URL for links that go out in emails (verification + password reset).
//
// SITE_BASE_URL (e.g. https://aheadt1d.com), when set, wins: emailed links
// point at the marketing site, which serves the /reset-password.html and
// /verify-email.html pages.
//
// When it is unset (or unusable) this falls back to EXACTLY what the code
// did before SITE_BASE_URL existed: the service's own Railway hostname
// (RAILWAY_PUBLIC_DOMAIN, no protocol), or http://localhost:3000 for anyone
// running outside Railway. So deploying this code with SITE_BASE_URL unset
// changes nothing.
//
// Everything reads process.env at CALL time (not module load) so the
// behaviour is testable; in production the values never change at runtime,
// so this is equivalent to the old load-time constant.

function publicBaseUrl(env = process.env) {
  return env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
    : 'http://localhost:3000';
}

let warnedAboutBadSiteUrl = false;

// Returns the normalised SITE_BASE_URL (trimmed, no trailing slash) or null
// when it is unset/blank/invalid. A value without http:// or https:// would
// produce a relative, broken link in an email, so it is ignored (falling
// back to the old behaviour) rather than used - with one loud log line so a
// typo in the Railway variable is noticed.
function siteBaseUrl(env = process.env) {
  const raw = env.SITE_BASE_URL;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const cleaned = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(cleaned)) {
    if (!warnedAboutBadSiteUrl) {
      warnedAboutBadSiteUrl = true;
      console.error('SITE_BASE_URL is set but is not an http(s) URL - ignoring it and using the default email link base.');
    }
    return null;
  }
  return cleaned;
}

function emailLinkBase(env = process.env) {
  return siteBaseUrl(env) || publicBaseUrl(env);
}

// Paths are fixed: the static pages the emails point at.
function verifyEmailLink(rawToken, env = process.env) {
  return `${emailLinkBase(env)}/verify-email.html?token=${rawToken}`;
}

function resetPasswordLink(rawToken, env = process.env) {
  return `${emailLinkBase(env)}/reset-password.html?token=${rawToken}`;
}

module.exports = { publicBaseUrl, siteBaseUrl, emailLinkBase, verifyEmailLink, resetPasswordLink };
