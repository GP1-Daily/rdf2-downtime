// Postgres-backed storage (used instead of store.js/Excel when DATABASE_URL
// is set, e.g. deployed with a free Supabase/Postgres database so the app
// works even when no local computer is left running).
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
};

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
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

async function appendRow(sheetName, data) {
  await ensureSchema();
  const { table, columns } = TABLES[sheetName];
  const jsKeys = Object.keys(columns).filter((k) => k !== 'ID' && k !== 'CreatedAt' && data[k] !== undefined);
  const dbCols = jsKeys.map((k) => columns[k]);
  const values = jsKeys.map((k) => data[k]);
  const placeholders = values.map((_, i) => `$${i + 1}`);
  let sql = `INSERT INTO ${table} (${dbCols.join(',')}) VALUES (${placeholders.join(',')})`;
  if (sheetName === 'GrabCrane') {
    // Re-importing the same file (same report_date + date_time) updates the
    // existing row instead of creating a duplicate, regardless of whether
    // "replace existing data" was used on import.
    sql += ` ON CONFLICT (report_date, date_time) DO UPDATE SET weight = EXCLUDED.weight, source_file = EXCLUDED.source_file`;
  }
  sql += ` RETURNING *`;
  const res = await pool.query(sql, values);
  return rowToObj(columns, res.rows[0]);
}

async function appendRows(sheetName, dataArr) {
  const results = [];
  for (const data of dataArr) {
    results.push(await appendRow(sheetName, data));
  }
  return results;
}

async function updateRow(sheetName, id, patch) {
  await ensureSchema();
  const { table, columns } = TABLES[sheetName];
  const jsKeys = Object.keys(columns).filter((k) => k !== 'ID' && k !== 'CreatedAt' && patch[k] !== undefined);
  if (jsKeys.length === 0) {
    const res = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return res.rows[0] ? rowToObj(columns, res.rows[0]) : null;
  }
  const setClauses = jsKeys.map((k, i) => `${columns[k]} = $${i + 1}`);
  const values = jsKeys.map((k) => patch[k]);
  values.push(id);
  const sql = `UPDATE ${table} SET ${setClauses.join(',')} WHERE id = $${values.length} RETURNING *`;
  const res = await pool.query(sql, values);
  return res.rows[0] ? rowToObj(columns, res.rows[0]) : null;
}

async function deleteRow(sheetName, id) {
  await ensureSchema();
  const { table } = TABLES[sheetName];
  const res = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

async function deleteRowsByReportDate(sheetName, dateField, dateValue) {
  await ensureSchema();
  const { table, columns } = TABLES[sheetName];
  const dbCol = columns[dateField];
  const res = await pool.query(`DELETE FROM ${table} WHERE ${dbCol} = $1`, [dateValue]);
  return res.rowCount;
}

module.exports = {
  XLSX_PATH: null,
  readSheet, appendRow, appendRows, updateRow, deleteRow, deleteRowsByReportDate,
};
