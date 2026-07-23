const { createClient } = require('@supabase/supabase-js');

async function main() {
  const required = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_INITIAL_PASSWORD'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  if (process.env.ADMIN_INITIAL_PASSWORD.length < 12) throw new Error('ADMIN_INITIAL_PASSWORD must contain at least 12 characters');
  const email = String(process.env.ADMIN_EMAIL || 'gp1.dailyreport@gmail.com').trim().toLowerCase();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let authUser = null;
  for (let page = 1; page <= 10 && !authUser; page += 1) {
    const result = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (result.error) throw result.error;
    authUser = result.data.users.find((user) => String(user.email || '').toLowerCase() === email) || null;
    if (result.data.users.length < 100) break;
  }
  if (!authUser) {
    const result = await supabase.auth.admin.createUser({
      email,
      password: process.env.ADMIN_INITIAL_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: 'GP1 Administrator', role: 'admin' },
    });
    if (result.error) throw result.error;
    authUser = result.data.user;
  }
  const store = require('../pg-store');
  try {
    const profiles = await store.readSheet('AppUsers');
    const existing = profiles.find((profile) => String(profile.Email || '').trim().toLowerCase() === email);
    if (existing) {
      await store.updateRow('AppUsers', existing.ID, { AuthUserID: authUser.id, Role: 'admin', Active: true });
    } else {
      await store.appendRow('AppUsers', {
        AuthUserID: authUser.id, Email: email, DisplayName: 'GP1 Administrator',
        Role: 'admin', Active: true, UpdatedAt: new Date().toISOString(),
      });
    }
    process.stdout.write(`Administrator ready: ${email}\nRemove ADMIN_INITIAL_PASSWORD from the environment now.\n`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Admin bootstrap failed: ${error.message}\n`);
  process.exitCode = 1;
});
