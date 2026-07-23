const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const ROLES = ['viewer', 'operator', 'supervisor', 'admin'];
const ROLE_LEVEL = Object.freeze({ viewer: 1, operator: 2, supervisor: 3, admin: 4 });
const ACCESS_COOKIE = 'gp1_access';
const REFRESH_COOKIE = 'gp1_refresh';
const CSRF_COOKIE = 'gp1_csrf';

class AuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigurationError';
    this.statusCode = 503;
  }
}

function passwordResetFailure(error) {
  const status = Number(error && error.status);
  const message = String(error && error.message || '');
  const rateLimited = status === 429 || /rate limit/i.test(message);
  const failure = new Error(rateLimited
    ? 'ส่งอีเมลตั้งรหัสผ่านถี่เกินขีดจำกัดของ Supabase กรุณารอประมาณ 1 ชั่วโมงหลังอีเมลฉบับล่าสุดแล้วลองใหม่'
    : 'ไม่สามารถส่งลิงก์ตั้งรหัสผ่านใหม่ได้');
  failure.statusCode = rateLimited ? 429 : 502;
  return failure;
}

function createAuth(store) {
  const production = process.env.NODE_ENV === 'production';
  const hasDatabase = Boolean(process.env.DATABASE_URL);
  const localDisabled = process.env.AUTH_DISABLED === 'true' && !production && !hasDatabase;
  // Fail closed: authentication is disabled only by an explicit local-only bypass.
  const enabled = !localDisabled;
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const adminEmail = String(process.env.ADMIN_EMAIL || 'gp1.dailyreport@gmail.com').trim().toLowerCase();
  const configured = !enabled || Boolean(supabaseUrl && anonKey);

  const clientOptions = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  };
  const supabase = configured && enabled ? createClient(supabaseUrl, anonKey, clientOptions) : null;
  const adminClient = configured && enabled && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, clientOptions)
    : null;
  const validationCache = new Map();

  function assertConfigured() {
    if (!configured) {
      throw new AuthConfigurationError('ระบบ Login ยังตั้งค่าไม่ครบ กรุณาตั้งค่า SUPABASE_URL และ SUPABASE_ANON_KEY');
    }
  }

  function parseCookies(req) {
    const cookies = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      if (!key) continue;
      try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { cookies[key] = ''; }
    }
    return cookies;
  }

  function isSecureRequest(req) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return production || req.socket.encrypted || forwarded === 'https';
  }

  function cookie(name, value, req, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
    if (options.httpOnly !== false) parts.push('HttpOnly');
    if (isSecureRequest(req)) parts.push('Secure');
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    return parts.join('; ');
  }

  function setSessionCookies(req, res, session) {
    const csrf = crypto.randomBytes(32).toString('base64url');
    const accessMaxAge = Math.max(60, Number(session.expires_in || 3600));
    res.setHeader('Set-Cookie', [
      cookie(ACCESS_COOKIE, session.access_token, req, { maxAge: accessMaxAge }),
      cookie(REFRESH_COOKIE, session.refresh_token, req, { maxAge: 60 * 60 * 24 * 30 }),
      cookie(CSRF_COOKIE, csrf, req, { httpOnly: false, maxAge: 60 * 60 * 24 * 30 }),
    ]);
  }

  function clearSessionCookies(req, res) {
    res.setHeader('Set-Cookie', [
      cookie(ACCESS_COOKIE, '', req, { maxAge: 0 }),
      cookie(REFRESH_COOKIE, '', req, { maxAge: 0 }),
      cookie(CSRF_COOKIE, '', req, { httpOnly: false, maxAge: 0 }),
    ]);
  }

  function cacheKey(token) {
    return crypto.createHash('sha256').update(token).digest('base64url');
  }

  function readCachedIdentity(token) {
    const key = cacheKey(token);
    const cached = validationCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      validationCache.delete(key);
      return null;
    }
    return cached.identity;
  }

  function cacheIdentity(token, identity) {
    if (validationCache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of validationCache) {
        if (value.expiresAt <= now || validationCache.size > 800) validationCache.delete(key);
      }
    }
    validationCache.set(cacheKey(token), { identity, expiresAt: Date.now() + 30000 });
  }

  async function findProfile(authUserId, email) {
    const profiles = await store.readSheet('AppUsers');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return profiles.find((profile) => String(profile.AuthUserID || '') === String(authUserId || ''))
      || profiles.find((profile) => String(profile.Email || '').trim().toLowerCase() === normalizedEmail)
      || null;
  }

  function profileIsActive(profile) {
    return profile && !['false', '0', 'no', ''].includes(String(profile.Active).toLowerCase());
  }

  async function resolveAppUser(identity) {
    const email = String(identity.email || '').trim().toLowerCase();
    let profile = await findProfile(identity.id, email);
    if (!profile && email === adminEmail) {
      profile = await store.appendRow('AppUsers', {
        AuthUserID: identity.id,
        Email: email,
        DisplayName: identity.user_metadata?.display_name || 'GP1 Administrator',
        Role: 'admin',
        Active: true,
        UpdatedAt: new Date().toISOString(),
      });
    } else if (profile && !profile.AuthUserID) {
      profile = await store.updateRow('AppUsers', profile.ID, { AuthUserID: identity.id });
    }
    if (!profile || !profileIsActive(profile) || !ROLE_LEVEL[profile.Role]) return null;
    return {
      id: String(profile.ID),
      authUserId: identity.id,
      email,
      displayName: profile.DisplayName || email,
      role: profile.Role,
    };
  }

  async function validateAccessToken(token) {
    const cached = readCachedIdentity(token);
    if (cached) return cached;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    cacheIdentity(token, data.user);
    return data.user;
  }

  async function authenticate(req, res) {
    if (!enabled) {
      return {
        id: 'local-admin', authUserId: 'local-admin', email: adminEmail,
        displayName: 'Local Administrator', role: 'admin', local: true,
      };
    }
    assertConfigured();
    const cookies = parseCookies(req);
    let identity = cookies[ACCESS_COOKIE] ? await validateAccessToken(cookies[ACCESS_COOKIE]) : null;
    if (!identity && cookies[REFRESH_COOKIE]) {
      const refreshClient = createClient(supabaseUrl, anonKey, clientOptions);
      const { data, error } = await refreshClient.auth.refreshSession({ refresh_token: cookies[REFRESH_COOKIE] });
      if (!error && data.session && data.user) {
        setSessionCookies(req, res, data.session);
        identity = data.user;
        cacheIdentity(data.session.access_token, identity);
      }
    }
    if (!identity) return null;
    return resolveAppUser(identity);
  }

  async function login(req, res, email, password) {
    assertConfigured();
    if (!enabled) return authenticate(req, res);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) return null;
    const loginClient = createClient(supabaseUrl, anonKey, clientOptions);
    const { data, error } = await loginClient.auth.signInWithPassword({ email: normalizedEmail, password });
    if (error || !data.session || !data.user) return null;
    const user = await resolveAppUser(data.user);
    if (!user) {
      await loginClient.auth.signOut({ scope: 'local' });
      return null;
    }
    setSessionCookies(req, res, data.session);
    cacheIdentity(data.session.access_token, data.user);
    return user;
  }

  async function logout(req, res) {
    try {
      if (enabled && configured) {
        const cookies = parseCookies(req);
        if (cookies[ACCESS_COOKIE] && cookies[REFRESH_COOKIE]) {
          const logoutClient = createClient(supabaseUrl, anonKey, clientOptions);
          const session = await logoutClient.auth.setSession({
            access_token: cookies[ACCESS_COOKIE],
            refresh_token: cookies[REFRESH_COOKIE],
          });
          if (!session.error) await logoutClient.auth.signOut({ scope: 'local' });
          validationCache.delete(cacheKey(cookies[ACCESS_COOKIE]));
        }
      }
    } finally {
      clearSessionCookies(req, res);
    }
  }

  async function inviteUser({ email, displayName, role, redirectTo }) {
    assertConfigured();
    if (!adminClient) throw new AuthConfigurationError('ยังไม่ได้ตั้งค่า SUPABASE_SERVICE_ROLE_KEY สำหรับเชิญผู้ใช้');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !ROLES.includes(role)) throw new Error('Invalid user details');
    const existing = await findProfile('', normalizedEmail);
    if (existing) {
      const error = new Error('อีเมลนี้มีอยู่ในระบบแล้ว');
      error.statusCode = 409;
      throw error;
    }
    const options = { data: { display_name: String(displayName || '').trim(), role } };
    const finalRedirect = redirectTo || process.env.AUTH_REDIRECT_URL;
    if (finalRedirect) options.redirectTo = finalRedirect;
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, options);
    if (error || !data.user) throw new Error('ไม่สามารถส่งคำเชิญได้ กรุณาตรวจสอบอีเมลและการตั้งค่า Supabase');
    try {
      return await store.appendRow('AppUsers', {
        AuthUserID: data.user.id,
        Email: normalizedEmail,
        DisplayName: String(displayName || '').trim() || normalizedEmail,
        Role: role,
        Active: true,
        UpdatedAt: new Date().toISOString(),
      });
    } catch (storeError) {
      await adminClient.auth.admin.deleteUser(data.user.id).catch(() => {});
      throw storeError;
    }
  }

  async function acceptInvite(req, res, { accessToken, refreshToken, password }) {
    assertConfigured();
    if (!accessToken || !refreshToken || String(password || '').length < 10) return null;
    const inviteClient = createClient(supabaseUrl, anonKey, clientOptions);
    const sessionResult = await inviteClient.auth.setSession({
      access_token: String(accessToken),
      refresh_token: String(refreshToken),
    });
    if (sessionResult.error || !sessionResult.data.user || !sessionResult.data.session) return null;
    const user = await resolveAppUser(sessionResult.data.user);
    if (!user) return null;
    const updateResult = await inviteClient.auth.updateUser({ password: String(password) });
    if (updateResult.error) return null;
    setSessionCookies(req, res, sessionResult.data.session);
    cacheIdentity(sessionResult.data.session.access_token, sessionResult.data.user);
    return user;
  }

  async function sendPasswordReset(email, redirectTo) {
    assertConfigured();
    const resetClient = createClient(supabaseUrl, anonKey, clientOptions);
    const { error } = await resetClient.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), {
      redirectTo: redirectTo || process.env.AUTH_REDIRECT_URL,
    });
    if (error) throw passwordResetFailure(error);
    return true;
  }

  function sameOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const expectedProto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
      return parsed.host === forwardedHost && parsed.protocol === `${expectedProto}:`;
    } catch {
      return false;
    }
  }

  function verifyCsrf(req) {
    if (!enabled) return true;
    if (!sameOrigin(req)) return false;
    const cookieToken = parseCookies(req)[CSRF_COOKIE] || '';
    const headerToken = String(req.headers['x-csrf-token'] || '');
    if (!cookieToken || cookieToken.length !== headerToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  }

  return {
    enabled,
    configured,
    adminEmail,
    roles: ROLES,
    roleLevel: ROLE_LEVEL,
    authenticate,
    login,
    logout,
    inviteUser,
    acceptInvite,
    sendPasswordReset,
    verifyCsrf,
    sameOrigin,
    clearSessionCookies,
    parseCookies,
  };
}

module.exports = { createAuth, ROLES, ROLE_LEVEL, AuthConfigurationError, passwordResetFailure };
