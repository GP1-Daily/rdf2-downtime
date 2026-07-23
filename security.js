const crypto = require('node:crypto');

function createRateLimiter() {
  const buckets = new Map();

  function check(key, limit, windowMs) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      resetAt: bucket.resetAt,
    };
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  const timer = setInterval(cleanup, 60000);
  timer.unref();
  return { check, cleanup, size: () => buckets.size };
}

function getClientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  // Render places the real client address first in this list.
  const forwarded = chain[0] || '';
  return (forwarded || req.socket.remoteAddress || '').slice(0, 128);
}

function secureDatabaseUrl(connectionString) {
  let parsed;
  try {
    parsed = new URL(String(connectionString || ''));
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgresql protocol');
  }
  // pg parses SSL query parameters after the explicit client config. Remove
  // them so a URL cannot override rejectUnauthorized=true.
  [
    'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslca',
    'sslnegotiation', 'uselibpqcompat',
  ].forEach((name) => parsed.searchParams.delete(name));
  return parsed.toString();
}

function createRequestId(req) {
  const supplied = String(req.headers['x-request-id'] || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'none'",
    "upgrade-insecure-requests",
  ].join('; ');
}

function securityHeaders(nonce) {
  const headers = {
    'Content-Security-Policy': contentSecurityPolicy(nonce),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  return headers;
}

function applySecurityHeaders(res, nonce = crypto.randomBytes(18).toString('base64url')) {
  for (const [name, value] of Object.entries(securityHeaders(nonce))) res.setHeader(name, value);
  return nonce;
}

module.exports = {
  createRateLimiter,
  getClientIp,
  createRequestId,
  secureDatabaseUrl,
  contentSecurityPolicy,
  securityHeaders,
  applySecurityHeaders,
};
