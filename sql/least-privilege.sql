-- Run as the database owner after creating gp1_migrator and gp1_runtime
-- with separate strong passwords. Replace role names if needed.

GRANT CONNECT ON DATABASE postgres TO gp1_migrator, gp1_runtime;
GRANT USAGE ON SCHEMA public TO gp1_migrator, gp1_runtime;

-- Existing GP1 tables must be owned by the migration account. GRANT ALL alone
-- does not permit ALTER TABLE, which the startup migration requires.
DO $$
DECLARE
  object_name TEXT;
BEGIN
  FOREACH object_name IN ARRAY ARRAY[
    'downtime', 'line_time', 'grab_crane', 'yield_settings', 'stock_baseline',
    'sales', 'revenue_customers', 'revenue_prices', 'revenue_rdf3_sales',
    'revenue_tipping_settings', 'revenue_tipping_daily', 'weekly_delivery_plans',
    'kpi_daily_history', 'kpi_complaints', 'kpi_target_settings',
    'app_users', 'audit_log', 'deleted_records'
  ] LOOP
    IF to_regclass('public.' || object_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO gp1_migrator', object_name);
    END IF;
  END LOOP;

  FOR object_name IN
    SELECT sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
      AND sequence_name = ANY (ARRAY[
        'downtime_id_seq', 'line_time_id_seq', 'grab_crane_id_seq',
        'yield_settings_id_seq', 'stock_baseline_id_seq', 'sales_id_seq',
        'revenue_customers_id_seq', 'revenue_prices_id_seq',
        'revenue_rdf3_sales_id_seq', 'revenue_tipping_settings_id_seq',
        'revenue_tipping_daily_id_seq', 'weekly_delivery_plans_id_seq',
        'kpi_daily_history_id_seq', 'kpi_complaints_id_seq',
        'kpi_target_settings_id_seq', 'app_users_id_seq', 'audit_log_id_seq',
        'deleted_records_id_seq'
      ])
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO gp1_migrator', object_name);
  END LOOP;
END $$;

-- The migration account owns and updates schema objects at application startup.
GRANT CREATE ON SCHEMA public TO gp1_migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO gp1_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO gp1_migrator;

-- Runtime business data access. It cannot CREATE, ALTER or DROP schema objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  downtime, line_time, grab_crane, yield_settings, stock_baseline, sales,
  revenue_customers, revenue_prices, revenue_rdf3_sales,
  revenue_tipping_settings, revenue_tipping_daily, weekly_delivery_plans,
  kpi_daily_history, kpi_complaints, kpi_target_settings
TO gp1_runtime;

GRANT SELECT, INSERT, UPDATE ON app_users TO gp1_runtime;
GRANT SELECT, INSERT ON audit_log TO gp1_runtime;
GRANT SELECT, INSERT, UPDATE ON deleted_records TO gp1_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gp1_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE gp1_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gp1_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE gp1_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gp1_runtime;

REVOKE CREATE ON SCHEMA public FROM gp1_runtime;

-- GP1 data is server-only. Supabase Auth API roles must not reach these tables
-- through PostgREST, even though the anon key itself is public.
REVOKE ALL PRIVILEGES ON TABLE
  downtime, line_time, grab_crane, yield_settings, stock_baseline, sales,
  revenue_customers, revenue_prices, revenue_rdf3_sales,
  revenue_tipping_settings, revenue_tipping_daily, weekly_delivery_plans,
  kpi_daily_history, kpi_complaints, kpi_target_settings,
  app_users, audit_log, deleted_records
FROM PUBLIC, anon, authenticated;
