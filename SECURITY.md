# GP1 Connect Security Operations

## Production configuration

1. Configure every variable shown in `.env.example` in Render. Never commit real secrets.
2. Keep `AUTH_DISABLED` unset in Render. Production refuses this development bypass.
3. Disable public user sign-up in Supabase Auth. Accounts must be created only from the GP1 Connect Security page.
4. Add the production Site URL and `/accept-invite.html` redirect URL in Supabase Auth URL configuration.
5. Use separate `DATABASE_URL` and `MIGRATION_DATABASE_URL` accounts. Apply `sql/least-privilege.sql` as the database owner after the schema exists; the script transfers ownership of GP1 tables to the migration account.
6. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only. It must never appear in HTML or browser JavaScript.
7. Create `gp1-backups` as a private Supabase Storage bucket. The backup script also refuses a public bucket.

## First administrator

Set `ADMIN_INITIAL_PASSWORD` temporarily, run `npm run bootstrap-admin`, then remove that variable immediately. The default admin email is `gp1.dailyreport@gmail.com` and can be changed with `ADMIN_EMAIL`.

## Scheduled backup

Run `npm run backup` once per day from a Render Cron Job. Backups are gzip-compressed, uploaded over TLS, and expired after `BACKUP_RETENTION_DAYS` (35 days by default). Test a restore to a separate database every month.

The application backup contains GP1 database records, including user roles and audit history. Supabase Auth passwords are managed by Supabase and are not included; keep the Supabase project recovery controls available or re-invite users after a full project recovery. Keep an additional periodic copy outside the production Supabase project.

## Restore procedure

1. Download a backup from the private Storage bucket.
2. Run `npm run restore -- path/to/backup.json.gz` for validation and row counts. This is a dry run.
3. Set `RESTORE_DATABASE_URL` to a separate recovery database and set `RESTORE_CONFIRMATION=RESTORE GP1 CONNECT`.
4. Run `npm run restore -- path/to/backup.json.gz --confirm`.
5. Validate reports and record counts before changing the production connection.

The restore command blocks overwriting the current `DATABASE_URL` unless `ALLOW_PRODUCTION_RESTORE=YES` is also explicitly set.

## Roles

- `viewer`: dashboards and reports only.
- `operator`: operational entries, imports, daily sales and complaints.
- `supervisor`: settings, plans, targets and deletes.
- `admin`: users, audit log, recovery and backup.

Deleted business records are copied to `deleted_records` before deletion and can be restored by an admin. Every create, update, delete and restore operation is recorded in `audit_log`.
