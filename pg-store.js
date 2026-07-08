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
      Note: 'note', CreatedAt: 'created_at',
    },
  },
  GrabCrane: {
    table: 'grab_crane',
    columns: {
      ID: 'id', ReportDate: 'report_date', DateTime: 'date_time', Weight: 'weight',
      SourceFile: 'source_file', CreatedAt: 'created_at',
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
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS grab_crane (
        id SERIAL PRIMARY KEY,
        report_date TEXT NOT NULL,
        date_time TEXT NOT NULL,
        weight NUMERIC NOT NULL,
        source_file TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
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
  const sql = `INSERT INTO ${table} (${dbCols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`;
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
