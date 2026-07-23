const { promisify } = require('node:util');
const { gzip } = require('node:zlib');
const { createClient } = require('@supabase/supabase-js');

const gzipAsync = promisify(gzip);

async function main() {
  const required = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const bucket = process.env.BACKUP_BUCKET || 'gp1-backups';
  const retentionDays = Math.max(7, Number(process.env.BACKUP_RETENTION_DAYS || 35));
  const store = require('../pg-store');
  try {
    const backup = await store.exportBackup();
    const payload = await gzipAsync(Buffer.from(JSON.stringify(backup)));
    const stamp = backup.generatedAt.replace(/[:.]/g, '-');
    const objectPath = `database/gp1-connect-${stamp}.json.gz`;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const bucketResult = await supabase.storage.getBucket(bucket);
    if (bucketResult.error) {
      const created = await supabase.storage.createBucket(bucket, { public: false });
      if (created.error) throw created.error;
    } else if (bucketResult.data.public) {
      throw new Error(`Backup bucket ${bucket} must be private`);
    }
    const upload = await supabase.storage.from(bucket).upload(objectPath, payload, {
      contentType: 'application/gzip',
      cacheControl: '0',
      upsert: false,
    });
    if (upload.error) throw upload.error;

    const listed = await supabase.storage.from(bucket).list('database', { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });
    if (!listed.error) {
      const cutoff = Date.now() - retentionDays * 86400000;
      const expired = listed.data
        .filter((item) => item.name.startsWith('gp1-connect-') && new Date(item.created_at).getTime() < cutoff)
        .map((item) => `database/${item.name}`);
      if (expired.length) {
        const removed = await supabase.storage.from(bucket).remove(expired);
        if (removed.error) throw removed.error;
      }
    }
    process.stdout.write(`Backup uploaded: ${bucket}/${objectPath} (${payload.length} bytes)\n`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Backup failed: ${error.message}\n`);
  process.exitCode = 1;
});
