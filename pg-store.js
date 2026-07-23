// Postgres-backed storage (used instead of store.js/Excel when DATABASE_URL
// is set, e.g. deployed with a free Supabase/Postgres database so the app
// works even when no local computer is left running).
const { Pool } = require('pg');
const { getRequestContext } = require('./request-context');
const { secureDatabaseUrl } = require('./security');

function sslConfig() {
  if (process.env.DATABASE_SSL === 'false') {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_SSL=false is not allowed in production');
    return false;
  }
  const ca = String(process.env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function createPool(connectionString) {
  return new Pool({
    connectionString: secureDatabaseUrl(connectionString),
    ssl: sslConfig(),
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 10000),
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 20000),
    query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 25000),
    application_name: 'gp1-connect',
  });
}

const pool = createPool(process.env.DATABASE_URL);
const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const migrationPool = migrationUrl === process.env.DATABASE_URL ? pool : createPool(migrationUrl);

// sheetName (used throughout server.js) -> Postgres table + column mapping.
// Keeping the same PascalCase field names as the Excel version means
// server.js needs no changes at all when switching backends.
const TABLES = {
  Downtime: {
    table: 'downtime',
    columns: {
      ID: 'id', EntryDate: 'entry_date', StartTime: 'start_time', EndTime: 'end_time',
      Reason: 'reason', Note: 'note', CreatedAt: 'created_at',
    },
  },
  LineTime: {
    table: 'line_time',
    columns: {
      ID: 'id', EntryDate: 'entry_date', EventType: 'event_type', Time: 'time',
      StopType: 'stop_type', Note: 'note', CreatedAt: 'created_at',
    },
  },
  GrabCrane: {
    table: 'grab_crane',
    columns: {
      ID: 'id', ReportDate: 'report_date', DateTime: 'date_time', Weight: 'weight',
      SourceFile: 'source_file', CreatedAt: 'created_at',
    },
  },
  YieldSettings: {
    table: 'yield_settings',
    columns: {
      ID: 'id', EffectiveDate: 'effective_date', RDF2Pct: 'rdf2_pct', RDF2LGPct: 'rdf2_lg_pct',
      FineFractionPct: 'fine_fraction_pct',
      HeavyFractionPct: 'heavy_fraction_pct', MetalPct: 'metal_pct', CreatedAt: 'created_at',
    },
  },
  StockBaseline: {
    table: 'stock_baseline',
    columns: {
      ID: 'id', BaselineDate: 'baseline_date', RDF2Tons: 'rdf2_tons',
      FineFractionTons: 'fine_fraction_tons', MetalTons: 'metal_tons', CreatedAt: 'created_at',
    },
  },
  Sales: {
    table: 'sales',
    columns: {
      ID: 'id', SaleDate: 'sale_date', Material: 'material', Customer: 'customer',
      Tons: 'tons', Note: 'note', CreatedAt: 'created_at',
    },
  },
  RevenueCustomers: {
    table: 'revenue_customers',
    columns: {
      ID: 'id', Name: 'name', Active: 'active', CreatedAt: 'created_at',
    },
  },
  RevenuePrices: {
    table: 'revenue_prices',
    columns: {
      ID: 'id', EffectiveDate: 'effective_date', Customer: 'customer', Product: 'product',
      PricePerTon: 'price_per_ton', CreatedAt: 'created_at',
    },
  },
  RevenueRDF3Sales: {
    table: 'revenue_rdf3_sales',
    columns: {
      ID: 'id', SaleDate: 'sale_date', Customer: 'customer', Tons: 'tons',
      Note: 'note', CreatedAt: 'created_at',
    },
  },
  RevenueTippingSettings: {
    table: 'revenue_tipping_settings',
    columns: {
      ID: 'id', EffectiveDate: 'effective_date', RatePerTon: 'rate_per_ton',
      ExcludedCentralTons: 'excluded_central_tons', ExcludedMinTons: 'excluded_min_tons',
      ExcludedMaxTons: 'excluded_max_tons', CreatedAt: 'created_at',
    },
  },
  RevenueTippingDaily: {
    table: 'revenue_tipping_daily',
    columns: {
      ID: 'id', EntryDate: 'entry_date', MSWTons: 'msw_tons', Note: 'note', CreatedAt: 'created_at',
    },
  },
  WeeklyDeliveryPlans: {
    table: 'weekly_delivery_plans',
    columns: {
      ID: 'id', WeekStart: 'week_start', Customer: 'customer', Product: 'product',
      PlanTons: 'plan_tons', CreatedAt: 'created_at',
    },
  },
  KPIDailyHistory: {
    table: 'kpi_daily_history',
    columns: {
      ID: 'id', EntryDate: 'entry_date', RDF2Tons: 'rdf2_tons', RDF3Tons: 'rdf3_tons',
      RDF2LGTons: 'rdf2_lg_tons', FineFractionTons: 'fine_fraction_tons',
      MSWTons: 'msw_tons', Source: 'source',
      CreatedAt: 'created_at',
    },
  },
  KPIComplaints: {
    table: 'kpi_complaints',
    columns: {
      ID: 'id', EntryDate: 'entry_date', Customer: 'customer', Detail: 'detail',
      CreatedAt: 'created_at',
    },
  },
  KPITargetSettings: {
    table: 'kpi_target_settings',
    columns: {
      ID: 'id', EffectiveDate: 'effective_date', RDF2Target: 'rdf2_target',
      RDF2LGTarget: 'rdf2_lg_target', RDF3Target: 'rdf3_target', FineFractionTarget: 'fine_fraction_target',
      MSWTarget: 'msw_target', ComplaintLimit: 'complaint_limit', CreatedAt: 'created_at',
    },
  },
  AppUsers: {
    table: 'app_users',
    columns: {
      ID: 'id', AuthUserID: 'auth_user_id', Email: 'email', DisplayName: 'display_name',
      Role: 'role', Active: 'active', CreatedAt: 'created_at', UpdatedAt: 'updated_at',
    },
  },
  AuditLog: {
    table: 'audit_log',
    columns: {
      ID: 'id', Action: 'action', Entity: 'entity', RecordID: 'record_id',
      ActorUserID: 'actor_user_id', ActorEmail: 'actor_email', BeforeData: 'before_data',
      AfterData: 'after_data', RequestID: 'request_id', IPAddress: 'ip_address',
      UserAgent: 'user_agent', CreatedAt: 'created_at',
    },
  },
  DeletedRecords: {
    table: 'deleted_records',
    columns: {
      ID: 'id', Entity: 'entity', OriginalID: 'original_id', Snapshot: 'snapshot',
      DeletedBy: 'deleted_by', DeletedByEmail: 'deleted_by_email', DeletedAt: 'deleted_at',
      RestoredBy: 'restored_by', RestoredByEmail: 'restored_by_email', RestoredAt: 'restored_at',
    },
  },
};

const SYSTEM_SHEETS = new Set(['AuditLog', 'DeletedRecords']);

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = migrationPool.query(`
      CREATE TABLE IF NOT EXISTS downtime (
        id SERIAL PRIMARY KEY,
        entry_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS line_time (
        id SERIAL PRIMARY KEY,
        entry_date TEXT NOT NULL,
        event_type TEXT NOT NULL,
        time TEXT NOT NULL,
        stop_type TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE line_time ADD COLUMN IF NOT EXISTS stop_type TEXT DEFAULT '';
      CREATE TABLE IF NOT EXISTS grab_crane (
        id SERIAL PRIMARY KEY,
        report_date TEXT NOT NULL,
        date_time TEXT NOT NULL,
        weight NUMERIC NOT NULL,
        source_file TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS grab_crane_report_datetime_idx
        ON grab_crane (report_date, date_time);
      CREATE TABLE IF NOT EXISTS yield_settings (
        id SERIAL PRIMARY KEY,
        effective_date TEXT NOT NULL,
        rdf2_pct NUMERIC NOT NULL,
        rdf2_lg_pct NUMERIC,
        fine_fraction_pct NUMERIC NOT NULL,
        heavy_fraction_pct NUMERIC NOT NULL,
        metal_pct NUMERIC NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE yield_settings
        ADD COLUMN IF NOT EXISTS rdf2_lg_pct NUMERIC;
      -- Split each legacy RDF2 yield into 70% normal grade and 30% low grade.
      -- Subtracting the rounded LG value preserves the original RDF2 total.
      UPDATE yield_settings
        SET rdf2_lg_pct = round(rdf2_pct * 0.30, 2),
            rdf2_pct = rdf2_pct - round(rdf2_pct * 0.30, 2)
        WHERE rdf2_lg_pct IS NULL;
      ALTER TABLE yield_settings
        ALTER COLUMN rdf2_lg_pct SET DEFAULT 0;
      ALTER TABLE yield_settings
        ALTER COLUMN rdf2_lg_pct SET NOT NULL;
      CREATE TABLE IF NOT EXISTS stock_baseline (
        id SERIAL PRIMARY KEY,
        baseline_date TEXT NOT NULL,
        rdf2_tons NUMERIC NOT NULL DEFAULT 0,
        fine_fraction_tons NUMERIC NOT NULL DEFAULT 0,
        metal_tons NUMERIC NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        sale_date TEXT NOT NULL,
        material TEXT NOT NULL,
        customer TEXT DEFAULT '',
        tons NUMERIC NOT NULL,
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS revenue_customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS revenue_customers_name_idx
        ON revenue_customers (lower(name));
      CREATE TABLE IF NOT EXISTS revenue_prices (
        id SERIAL PRIMARY KEY,
        effective_date TEXT NOT NULL,
        customer TEXT NOT NULL,
        product TEXT NOT NULL,
        price_per_ton NUMERIC NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS revenue_prices_key_idx
        ON revenue_prices (effective_date, lower(customer), product);
      CREATE TABLE IF NOT EXISTS revenue_rdf3_sales (
        id SERIAL PRIMARY KEY,
        sale_date TEXT NOT NULL,
        customer TEXT NOT NULL,
        tons NUMERIC NOT NULL,
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS revenue_tipping_settings (
        id SERIAL PRIMARY KEY,
        effective_date TEXT NOT NULL,
        rate_per_ton NUMERIC NOT NULL DEFAULT 250,
        excluded_central_tons NUMERIC NOT NULL DEFAULT 180,
        excluded_min_tons NUMERIC NOT NULL DEFAULT 160,
        excluded_max_tons NUMERIC NOT NULL DEFAULT 200,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS revenue_tipping_settings_date_idx
        ON revenue_tipping_settings (effective_date);
      CREATE TABLE IF NOT EXISTS revenue_tipping_daily (
        id SERIAL PRIMARY KEY,
        entry_date TEXT NOT NULL,
        msw_tons NUMERIC NOT NULL,
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS revenue_tipping_daily_date_idx
        ON revenue_tipping_daily (entry_date);
      CREATE TABLE IF NOT EXISTS weekly_delivery_plans (
        id SERIAL PRIMARY KEY,
        week_start TEXT NOT NULL,
        customer TEXT NOT NULL,
        product TEXT NOT NULL,
        plan_tons NUMERIC NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS weekly_delivery_plans_key_idx
        ON weekly_delivery_plans (week_start, lower(customer), product);
      CREATE TABLE IF NOT EXISTS kpi_daily_history (
        id SERIAL PRIMARY KEY,
        entry_date TEXT NOT NULL,
        rdf2_tons NUMERIC NOT NULL DEFAULT 0,
        rdf2_lg_tons NUMERIC NOT NULL DEFAULT 0,
        rdf3_tons NUMERIC NOT NULL DEFAULT 0,
        fine_fraction_tons NUMERIC NOT NULL DEFAULT 0,
        msw_tons NUMERIC NOT NULL DEFAULT 0,
        source TEXT DEFAULT 'xlsx',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS kpi_daily_history_date_idx
        ON kpi_daily_history (entry_date);
      ALTER TABLE kpi_daily_history
        ADD COLUMN IF NOT EXISTS rdf2_lg_tons NUMERIC NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS kpi_complaints (
        id SERIAL PRIMARY KEY,
        entry_date TEXT NOT NULL,
        customer TEXT DEFAULT '',
        detail TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS kpi_target_settings (
        id SERIAL PRIMARY KEY,
        effective_date TEXT NOT NULL,
        rdf2_target NUMERIC NOT NULL DEFAULT 1000,
        rdf2_lg_target NUMERIC NOT NULL DEFAULT 0,
        rdf3_target NUMERIC NOT NULL DEFAULT 800,
        fine_fraction_target NUMERIC NOT NULL DEFAULT 800,
        msw_target NUMERIC NOT NULL DEFAULT 8000,
        complaint_limit NUMERIC NOT NULL DEFAULT 2,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS kpi_target_settings_date_idx
        ON kpi_target_settings (effective_date);
      ALTER TABLE kpi_target_settings
        ADD COLUMN IF NOT EXISTS rdf2_lg_target NUMERIC NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS app_users (
        id SERIAL PRIMARY KEY,
        auth_user_id TEXT,
        email TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'operator', 'supervisor', 'admin')),
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS app_users_auth_user_idx
        ON app_users (auth_user_id) WHERE auth_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_idx
        ON app_users (lower(email));

      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        record_id TEXT DEFAULT '',
        actor_user_id TEXT DEFAULT '',
        actor_email TEXT DEFAULT '',
        before_data JSONB,
        after_data JSONB,
        request_id TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, record_id);

      CREATE TABLE IF NOT EXISTS deleted_records (
        id BIGSERIAL PRIMARY KEY,
        entity TEXT NOT NULL,
        original_id TEXT NOT NULL,
        snapshot JSONB NOT NULL,
        deleted_by TEXT DEFAULT '',
        deleted_by_email TEXT DEFAULT '',
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        restored_by TEXT DEFAULT '',
        restored_by_email TEXT DEFAULT '',
        restored_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS deleted_records_active_idx
        ON deleted_records (deleted_at DESC) WHERE restored_at IS NULL;

      -- All RDF2 shipped to TPI is low grade. Keep this migration idempotent
      -- so old sales, prices and delivery plans are corrected on deployment.
      UPDATE sales
        SET material = 'RDF2LG'
        WHERE material = 'RDF2'
          AND (lower(trim(customer)) = 'tpi' OR lower(trim(customer)) LIKE 'tpi %');

      DELETE FROM revenue_prices old_price
        USING revenue_prices lg_price
        WHERE old_price.product = 'RDF2'
          AND (lower(trim(old_price.customer)) = 'tpi' OR lower(trim(old_price.customer)) LIKE 'tpi %')
          AND lg_price.product = 'RDF2LG'
          AND lg_price.effective_date = old_price.effective_date
          AND lower(trim(lg_price.customer)) = lower(trim(old_price.customer));
      UPDATE revenue_prices
        SET product = 'RDF2LG'
        WHERE product = 'RDF2'
          AND (lower(trim(customer)) = 'tpi' OR lower(trim(customer)) LIKE 'tpi %');

      DELETE FROM weekly_delivery_plans old_plan
        USING weekly_delivery_plans lg_plan
        WHERE old_plan.product = 'RDF2'
          AND (lower(trim(old_plan.customer)) = 'tpi' OR lower(trim(old_plan.customer)) LIKE 'tpi %')
          AND lg_plan.product = 'RDF2LG'
          AND lg_plan.week_start = old_plan.week_start
          AND lower(trim(lg_plan.customer)) = lower(trim(old_plan.customer));
      UPDATE weekly_delivery_plans
        SET product = 'RDF2LG'
        WHERE product = 'RDF2'
          AND (lower(trim(customer)) = 'tpi' OR lower(trim(customer)) LIKE 'tpi %');

      -- The browser never accesses business tables through Supabase PostgREST.
      -- Remove default API-role grants so the public anon key cannot read or
      -- mutate GP1 data even when a project was created with broad defaults.
      REVOKE ALL PRIVILEGES ON TABLE
        downtime, line_time, grab_crane, yield_settings, stock_baseline, sales,
        revenue_customers, revenue_prices, revenue_rdf3_sales,
        revenue_tipping_settings, revenue_tipping_daily, weekly_delivery_plans,
        kpi_daily_history, kpi_complaints, kpi_target_settings,
        app_users, audit_log, deleted_records
      FROM PUBLIC;
      DO $gp1_security$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE downtime, line_time, grab_crane, yield_settings, stock_baseline, sales, revenue_customers, revenue_prices, revenue_rdf3_sales, revenue_tipping_settings, revenue_tipping_daily, weekly_delivery_plans, kpi_daily_history, kpi_complaints, kpi_target_settings, app_users, audit_log, deleted_records FROM anon';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE downtime, line_time, grab_crane, yield_settings, stock_baseline, sales, revenue_customers, revenue_prices, revenue_rdf3_sales, revenue_tipping_settings, revenue_tipping_daily, weekly_delivery_plans, kpi_daily_history, kpi_complaints, kpi_target_settings, app_users, audit_log, deleted_records FROM authenticated';
        END IF;
      END
      $gp1_security$;
    `);
  }
  return schemaReady;
}

function rowToObj(cols, dbRow) {
  const obj = {};
  for (const [jsKey, dbCol] of Object.entries(cols)) {
    let v = dbRow[dbCol];
    if (v instanceof Date) v = v.toISOString();
    obj[jsKey] = v === null || v === undefined ? '' : v;
  }
  return obj;
}

async function readSheet(sheetName) {
  await ensureSchema();
  const { table, columns } = TABLES[sheetName];
  const res = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
  return res.rows.map((r) => rowToObj(columns, r));
}

function actorFields() {
  const context = getRequestContext();
  const user = context.user || {};
  return {
    actorUserId: user.id || user.authUserId || 'system',
    actorEmail: user.email || 'system',
    requestId: context.requestId || 'system',
    ipAddress: context.ip || '',
    userAgent: context.userAgent || '',
  };
}

async function writeAudit(client, action, entity, recordId, beforeData, afterData) {
  if (SYSTEM_SHEETS.has(entity)) return;
  const actor = actorFields();
  await client.query(`
    INSERT INTO audit_log (
      action, entity, record_id, actor_user_id, actor_email,
      before_data, after_data, request_id, ip_address, user_agent
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    action, entity, recordId === undefined || recordId === null ? '' : String(recordId),
    actor.actorUserId, actor.actorEmail, beforeData || null, afterData || null,
    actor.requestId, actor.ipAddress, actor.userAgent,
  ]);
}

async function writeDeletedRecord(client, entity, snapshot) {
  const actor = actorFields();
  await client.query(`
    INSERT INTO deleted_records (
      entity, original_id, snapshot, deleted_by, deleted_by_email
    ) VALUES ($1,$2,$3,$4,$5)
  `, [entity, String(snapshot.ID), snapshot, actor.actorUserId, actor.actorEmail]);
}

async function insertRecord(client, sheetName, data, includeId = false) {
  const { table, columns } = TABLES[sheetName];
  const jsKeys = Object.keys(columns).filter((key) => {
    if (!includeId && (key === 'ID' || key === 'CreatedAt')) return false;
    return data[key] !== undefined && data[key] !== '';
  });
  const dbCols = jsKeys.map((key) => columns[key]);
  const values = jsKeys.map((key) => data[key]);
  const placeholders = values.map((_, index) => `$${index + 1}`);
  let sql = `INSERT INTO ${table} (${dbCols.join(',')}) VALUES (${placeholders.join(',')})`;
  if (sheetName === 'GrabCrane' && !includeId) {
    sql += ` ON CONFLICT (report_date, date_time) DO UPDATE SET weight = EXCLUDED.weight, source_file = EXCLUDED.source_file`;
  }
  sql += ' RETURNING *';
  const result = await client.query(sql, values);
  return rowToObj(columns, result.rows[0]);
}

async function appendRow(sheetName, data) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const record = await insertRecord(client, sheetName, data);
    await writeAudit(client, 'CREATE', sheetName, record.ID, null, record);
    await client.query('COMMIT');
    return record;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function appendRows(sheetName, dataArr) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const data of dataArr) results.push(await insertRecord(client, sheetName, data));
    await writeAudit(client, 'BULK_UPSERT', sheetName, '', null, {
      count: results.length,
      ids: results.map((record) => record.ID),
    });
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateRow(sheetName, id, patch) {
  await ensureSchema();
  const { table, columns } = TABLES[sheetName];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const beforeResult = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!beforeResult.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const before = rowToObj(columns, beforeResult.rows[0]);
    const jsKeys = Object.keys(columns).filter((key) => (
      key !== 'ID' && key !== 'CreatedAt' && key !== 'UpdatedAt' && patch[key] !== undefined
    ));
    if (columns.UpdatedAt) patch.UpdatedAt = new Date().toISOString();
    if (columns.UpdatedAt) jsKeys.push('UpdatedAt');
    if (jsKeys.length === 0) {
      await client.query('COMMIT');
      return before;
    }
    const setClauses = jsKeys.map((key, index) => `${columns[key]} = $${index + 1}`);
    const values = jsKeys.map((key) => patch[key]);
    values.push(id);
    const result = await client.query(
      `UPDATE ${table} SET ${setClauses.join(',')} WHERE id = $${values.length} RETURNING *`, values,
    );
    const after = rowToObj(columns, result.rows[0]);
    await writeAudit(client, 'UPDATE', sheetName, id, before, after);
    await client.query('COMMIT');
    return after;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteRow(sheetName, id) {
  await ensureSchema();
  if (SYSTEM_SHEETS.has(sheetName)) throw new Error('System records cannot be deleted directly');
  const { table, columns } = TABLES[sheetName];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    const snapshot = rowToObj(columns, found.rows[0]);
    await writeDeletedRecord(client, sheetName, snapshot);
    await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    await writeAudit(client, 'DELETE', sheetName, id, snapshot, null);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteRowsByReportDate(sheetName, dateField, dateValue) {
  await ensureSchema();
  const { table, columns } = TABLES[sheetName];
  const dbCol = columns[dateField];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT * FROM ${table} WHERE ${dbCol} = $1 FOR UPDATE`, [dateValue]);
    const snapshots = found.rows.map((row) => rowToObj(columns, row));
    for (const snapshot of snapshots) await writeDeletedRecord(client, sheetName, snapshot);
    const result = await client.query(`DELETE FROM ${table} WHERE ${dbCol} = $1`, [dateValue]);
    if (result.rowCount) {
      await writeAudit(client, 'BULK_DELETE', sheetName, '', { [dateField]: dateValue, records: snapshots }, null);
    }
    await client.query('COMMIT');
    return result.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function restoreDeletedRecord(id) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM deleted_records WHERE id = $1 AND restored_at IS NULL FOR UPDATE', [id],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const deleted = found.rows[0];
    const sheetName = deleted.entity;
    if (!TABLES[sheetName] || SYSTEM_SHEETS.has(sheetName)) throw new Error('Unsupported restore entity');
    const snapshot = deleted.snapshot;
    const restored = await insertRecord(client, sheetName, snapshot, true);
    const actor = actorFields();
    await client.query(`
      UPDATE deleted_records
      SET restored_by = $1, restored_by_email = $2, restored_at = now()
      WHERE id = $3
    `, [actor.actorUserId, actor.actorEmail, id]);
    await writeAudit(client, 'RESTORE', sheetName, snapshot.ID, null, restored);
    await client.query('COMMIT');
    return restored;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readRecentAudit({ limit = 150, entity = '', action = '' } = {}) {
  await ensureSchema();
  const values = [];
  const where = [];
  if (entity) {
    values.push(entity);
    where.push(`entity = $${values.length}`);
  }
  if (action) {
    values.push(action);
    where.push(`action = $${values.length}`);
  }
  values.push(Math.min(500, Math.max(1, Number(limit))));
  const result = await pool.query(
    `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => rowToObj(TABLES.AuditLog.columns, row));
}

async function readActiveDeleted(limit = 150) {
  await ensureSchema();
  const result = await pool.query(
    'SELECT * FROM deleted_records WHERE restored_at IS NULL ORDER BY deleted_at DESC LIMIT $1',
    [Math.min(500, Math.max(1, Number(limit)))],
  );
  return result.rows.map((row) => rowToObj(TABLES.DeletedRecords.columns, row));
}

async function exportBackup() {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sheets = {};
    for (const [sheetName, definition] of Object.entries(TABLES)) {
      const result = await client.query(`SELECT * FROM ${definition.table} ORDER BY id`);
      sheets[sheetName] = result.rows.map((row) => rowToObj(definition.columns, row));
    }
    await client.query('COMMIT');
    return { format: 'gp1-connect-backup', version: 1, generatedAt: new Date().toISOString(), sheets };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function restoreBackup(backup, options = {}) {
  if (!options.confirm) throw new Error('Restore requires explicit confirmation');
  if (!backup || backup.format !== 'gp1-connect-backup' || !backup.sheets) throw new Error('Invalid GP1 Connect backup');
  await ensureSchema();
  const client = await pool.connect();
  const definitions = Object.entries(TABLES);
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${definitions.map(([, value]) => value.table).join(',')} RESTART IDENTITY CASCADE`);
    for (const [sheetName] of definitions) {
      for (const record of backup.sheets[sheetName] || []) await insertRecord(client, sheetName, record, true);
    }
    for (const [, definition] of definitions) {
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence($1, 'id'),
          COALESCE((SELECT MAX(id) FROM ${definition.table}), 1),
          (SELECT MAX(id) IS NOT NULL FROM ${definition.table})
        )
      `, [definition.table]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
  if (migrationPool !== pool) await migrationPool.end();
}

module.exports = {
  XLSX_PATH: null,
  TABLES, readSheet, appendRow, appendRows, updateRow, deleteRow, deleteRowsByReportDate,
  restoreDeletedRecord, readRecentAudit, readActiveDeleted, exportBackup, restoreBackup, close,
};
