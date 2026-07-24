const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp1-security-test-'));
process.env.RDF2_XLSX_PATH = path.join(tempDir, 'security.xlsx');
process.env.AUTH_DISABLED = 'true';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const store = require('../store');
const { createAuth, ROLE_LEVEL, passwordResetFailure } = require('../auth');
const { requiredRole, hasRole } = require('../authorization');
const { runWithRequestContext } = require('../request-context');
const {
  createRateLimiter, getClientIp, secureDatabaseUrl, contentSecurityPolicy, constantTimeTokenEqual,
} = require('../security');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('local development auth is explicit and role hierarchy is ordered', async () => {
  const auth = createAuth(store);
  const user = await auth.authenticate({ headers: {}, socket: {} }, {});
  assert.equal(auth.enabled, false);
  assert.equal(user.role, 'admin');
  assert.ok(ROLE_LEVEL.admin > ROLE_LEVEL.supervisor);
  assert.ok(ROLE_LEVEL.supervisor > ROLE_LEVEL.operator);
  assert.ok(ROLE_LEVEL.operator > ROLE_LEVEL.viewer);
  assert.equal(requiredRole('/api/report', 'GET'), 'viewer');
  assert.equal(requiredRole('/api/line', 'POST'), 'operator');
  assert.equal(requiredRole('/api/yield', 'POST'), 'supervisor');
  assert.equal(requiredRole('/api/line/1', 'DELETE'), 'supervisor');
  assert.equal(requiredRole('/api/security/users', 'GET'), 'admin');
  assert.equal(hasRole({ role: 'operator' }, 'viewer'), true);
  assert.equal(hasRole({ role: 'operator' }, 'supervisor'), false);
});

test('password reset rate limits return a clear retry response', () => {
  const error = passwordResetFailure({ status: 429, message: 'email rate limit exceeded' });
  assert.equal(error.statusCode, 429);
  assert.match(error.message, /1 ชั่วโมง/);
});

test('required authentication fails closed and validates CSRF origin tokens', async () => {
  const previous = {
    AUTH_DISABLED: process.env.AUTH_DISABLED,
    AUTH_REQUIRED: process.env.AUTH_REQUIRED,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  };
  try {
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_REQUIRED = 'true';
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_ANON_KEY = '';
    const unconfigured = createAuth(store);
    assert.equal(unconfigured.enabled, true);
    assert.equal(unconfigured.configured, false);
    await assert.rejects(
      () => unconfigured.authenticate({ headers: {}, socket: {} }, {}),
      /SUPABASE_URL/,
    );

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    const configured = createAuth(store);
    const request = {
      headers: {
        origin: 'https://gp1.example.com',
        host: 'gp1.example.com',
        cookie: 'gp1_csrf=expected-token',
        'x-csrf-token': 'expected-token',
      },
      socket: { encrypted: true },
    };
    assert.equal(configured.verifyCsrf(request), true);
    request.headers['x-csrf-token'] = 'wrong-tokenxxx';
    assert.equal(configured.verifyCsrf(request), false);
    request.headers.origin = 'https://attacker.example';
    request.headers['x-csrf-token'] = 'expected-token';
    assert.equal(configured.verifyCsrf(request), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('store records audit history and restores deleted data', async () => {
  const context = {
    requestId: 'security-test-request',
    ip: '127.0.0.1',
    userAgent: 'node-test',
    user: { id: '1', email: 'admin@example.com', role: 'admin' },
  };
  const created = await runWithRequestContext(context, () => store.appendRow('RevenueCustomers', {
    Name: 'Recovery Test', Active: true,
  }));
  await runWithRequestContext(context, () => store.updateRow('RevenueCustomers', created.ID, { Name: 'Recovery Test Updated' }));
  await runWithRequestContext(context, () => store.deleteRow('RevenueCustomers', created.ID));

  assert.equal((await store.readSheet('RevenueCustomers')).length, 0);
  const trash = await store.readSheet('DeletedRecords');
  assert.equal(trash.length, 1);
  assert.equal(trash[0].Snapshot.Name, 'Recovery Test Updated');
  await runWithRequestContext(context, () => store.restoreDeletedRecord(trash[0].ID));
  const restored = await store.readSheet('RevenueCustomers');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].ID, created.ID);

  const actions = (await store.readSheet('AuditLog')).map((row) => row.Action);
  assert.deepEqual(actions, ['CREATE', 'UPDATE', 'DELETE', 'RESTORE']);
  const backup = await store.exportBackup();
  assert.equal(backup.format, 'gp1-connect-backup');
  assert.equal(backup.sheets.RevenueCustomers.length, 1);
  assert.equal(backup.sheets.AuditLog.length, 4);
});

test('rate limiting and CSP enforce bounded requests and nonce scripts', () => {
  const limiter = createRateLimiter();
  assert.equal(limiter.check('test', 2, 1000).allowed, true);
  assert.equal(limiter.check('test', 2, 1000).allowed, true);
  assert.equal(limiter.check('test', 2, 1000).allowed, false);
  const policy = contentSecurityPolicy('abc123');
  assert.match(policy, /script-src 'self' 'nonce-abc123'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(getClientIp({
    headers: { 'x-forwarded-for': '203.0.113.10, render-proxy' },
    socket: { remoteAddress: '127.0.0.1' },
  }), '203.0.113.10');

  const databaseUrl = secureDatabaseUrl(
    'postgresql://runtime:secret@db.example.com/postgres?sslmode=no-verify&application_name=test',
  );
  assert.doesNotMatch(databaseUrl, /sslmode|no-verify/);
  assert.match(databaseUrl, /application_name=test/);
});

test('device tokens require a long configured secret and compare safely', () => {
  const token = '0'.repeat(64);
  assert.equal(constantTimeTokenEqual(token, token), true);
  assert.equal(constantTimeTokenEqual(`${token}x`, token), false);
  assert.equal(constantTimeTokenEqual('', token), false);
  assert.equal(constantTimeTokenEqual('short', 'short'), false);
});
