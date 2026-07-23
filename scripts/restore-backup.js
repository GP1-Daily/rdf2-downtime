const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { gunzip } = require('node:zlib');

const gunzipAsync = promisify(gunzip);

async function readBackup(filePath) {
  let payload = await fs.readFile(filePath);
  if (filePath.toLowerCase().endsWith('.gz')) payload = await gunzipAsync(payload);
  const backup = JSON.parse(payload.toString('utf8'));
  if (backup.format !== 'gp1-connect-backup' || backup.version !== 1 || !backup.sheets) {
    throw new Error('File is not a valid GP1 Connect backup');
  }
  return backup;
}

async function main() {
  const fileArg = process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]);
  if (!fileArg) throw new Error('Usage: npm run restore -- <backup.json|backup.json.gz> [--confirm]');
  const filePath = path.resolve(fileArg);
  const backup = await readBackup(filePath);
  const counts = Object.fromEntries(Object.entries(backup.sheets).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : 0]));
  process.stdout.write(`${JSON.stringify({ file: filePath, generatedAt: backup.generatedAt, counts }, null, 2)}\n`);
  if (!process.argv.includes('--confirm')) {
    process.stdout.write('Dry run only. No database changes were made.\n');
    return;
  }
  if (!process.env.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL is required');
  if (process.env.RESTORE_CONFIRMATION !== 'RESTORE GP1 CONNECT') {
    throw new Error('Set RESTORE_CONFIRMATION="RESTORE GP1 CONNECT" to allow restore');
  }
  if (process.env.DATABASE_URL && process.env.RESTORE_DATABASE_URL === process.env.DATABASE_URL
      && process.env.ALLOW_PRODUCTION_RESTORE !== 'YES') {
    throw new Error('Refusing to overwrite DATABASE_URL without ALLOW_PRODUCTION_RESTORE=YES');
  }
  process.env.DATABASE_URL = process.env.RESTORE_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = process.env.RESTORE_MIGRATION_DATABASE_URL || process.env.RESTORE_DATABASE_URL;
  const store = require('../pg-store');
  try {
    await store.restoreBackup(backup, { confirm: true });
    process.stdout.write('Restore completed successfully.\n');
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Restore failed: ${error.message}\n`);
  process.exitCode = 1;
});
