const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { getRequestContext } = require('./request-context');

const XLSX_PATH = process.env.RDF2_XLSX_PATH
  ? path.resolve(process.env.RDF2_XLSX_PATH)
  : path.join(__dirname, 'RDF2_Downtime.xlsx');

const SHEETS = {
  Downtime: ['ID', 'EntryDate', 'StartTime', 'EndTime', 'Reason', 'Note', 'CreatedAt'],
  LineTime: ['ID', 'EntryDate', 'EventType', 'Time', 'Note', 'CreatedAt', 'StopType'],
  GrabCrane: ['ID', 'ReportDate', 'DateTime', 'Weight', 'SourceFile', 'CreatedAt'],
  YieldSettings: ['ID', 'EffectiveDate', 'RDF2Pct', 'FineFractionPct', 'HeavyFractionPct', 'MetalPct', 'CreatedAt', 'RDF2LGPct'],
  StockBaseline: ['ID', 'BaselineDate', 'RDF2Tons', 'FineFractionTons', 'MetalTons', 'CreatedAt'],
  Sales: ['ID', 'SaleDate', 'Material', 'Customer', 'Tons', 'Note', 'CreatedAt'],
  RevenueCustomers: ['ID', 'Name', 'Active', 'CreatedAt'],
  RevenuePrices: ['ID', 'EffectiveDate', 'Customer', 'Product', 'PricePerTon', 'CreatedAt'],
  RevenueRDF3Sales: ['ID', 'SaleDate', 'Customer', 'Tons', 'Note', 'CreatedAt'],
  RevenueTippingSettings: ['ID', 'EffectiveDate', 'RatePerTon', 'ExcludedCentralTons', 'ExcludedMinTons', 'ExcludedMaxTons', 'CreatedAt'],
  RevenueTippingDaily: ['ID', 'EntryDate', 'MSWTons', 'Note', 'CreatedAt'],
  WeeklyDeliveryPlans: ['ID', 'WeekStart', 'Customer', 'Product', 'PlanTons', 'CreatedAt'],
  KPIDailyHistory: ['ID', 'EntryDate', 'RDF2Tons', 'RDF3Tons', 'FineFractionTons', 'MSWTons', 'Source', 'CreatedAt', 'RDF2LGTons'],
  KPIComplaints: ['ID', 'EntryDate', 'Customer', 'Detail', 'CreatedAt'],
  KPITargetSettings: ['ID', 'EffectiveDate', 'RDF2Target', 'RDF3Target', 'FineFractionTarget', 'MSWTarget', 'ComplaintLimit', 'CreatedAt', 'RDF2LGTarget'],
  AppUsers: ['ID', 'AuthUserID', 'Email', 'DisplayName', 'Role', 'Active', 'CreatedAt', 'UpdatedAt'],
  AuditLog: ['ID', 'Action', 'Entity', 'RecordID', 'ActorUserID', 'ActorEmail', 'BeforeData', 'AfterData', 'RequestID', 'IPAddress', 'UserAgent', 'CreatedAt'],
  DeletedRecords: ['ID', 'Entity', 'OriginalID', 'Snapshot', 'DeletedBy', 'DeletedByEmail', 'DeletedAt', 'RestoredBy', 'RestoredByEmail', 'RestoredAt'],
};

const SYSTEM_SHEETS = new Set(['AuditLog', 'DeletedRecords']);
const JSON_COLUMNS = new Set(['BeforeData', 'AfterData', 'Snapshot']);

function isTPICustomer(value) {
  return /^t\.?p\.?i(?:\s|$)/i.test(String(value || '').trim());
}

function migrateRDF2LowGrade(wb) {
  let changed = false;
  for (const [sheetName, productColumn, customerColumn] of [
    ['Sales', 'Material', 'Customer'],
    ['RevenuePrices', 'Product', 'Customer'],
    ['WeeklyDeliveryPlans', 'Product', 'Customer'],
  ]) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    const columns = SHEETS[sheetName];
    const productIndex = columns.indexOf(productColumn) + 1;
    const customerIndex = columns.indexOf(customerColumn) + 1;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(productIndex).value === 'RDF2' && isTPICustomer(row.getCell(customerIndex).value)) {
        row.getCell(productIndex).value = 'RDF2LG';
        changed = true;
      }
    });
  }
  return changed;
}

function migrateYieldSplit(wb) {
  const ws = wb.getWorksheet('YieldSettings');
  if (!ws) return false;
  const columns = SHEETS.YieldSettings;
  const rdf2Index = columns.indexOf('RDF2Pct') + 1;
  const rdf2LGIndex = columns.indexOf('RDF2LGPct') + 1;
  let changed = false;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const currentLG = row.getCell(rdf2LGIndex).value;
    if (currentLG !== null && currentLG !== undefined && currentLG !== '') return;
    const legacyRDF2 = Number(row.getCell(rdf2Index).value);
    if (!Number.isFinite(legacyRDF2)) return;
    const rdf2LG = Math.round((legacyRDF2 * 0.30 + Number.EPSILON) * 100) / 100;
    row.getCell(rdf2Index).value = Math.round((legacyRDF2 - rdf2LG + Number.EPSILON) * 100) / 100;
    row.getCell(rdf2LGIndex).value = rdf2LG;
    changed = true;
  });
  return changed;
}

// Serialize ALL access (reads and writes) to the workbook file through one
// queue: concurrent requests (e.g. multiple tabs loading at once) must not
// read/write the .xlsx concurrently, or the zip container gets corrupted.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

let ensured = false;
let cachedWorkbook = null;
let cachedMtimeMs = -1;

async function saveWorkbook(wb) {
  await wb.xlsx.writeFile(XLSX_PATH);
  cachedWorkbook = wb;
  cachedMtimeMs = fs.statSync(XLSX_PATH).mtimeMs;
}

async function ensureWorkbook() {
  if (ensured || fs.existsSync(XLSX_PATH)) { ensured = true; return; }
  const wb = new ExcelJS.Workbook();
  for (const [name, cols] of Object.entries(SHEETS)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols);
  }
  await saveWorkbook(wb);
  ensured = true;
}

async function loadWorkbook() {
  await ensureWorkbook();
  const mtimeMs = fs.statSync(XLSX_PATH).mtimeMs;
  if (cachedWorkbook && cachedMtimeMs === mtimeMs) return cachedWorkbook;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  let changed = false;
  for (const [name, cols] of Object.entries(SHEETS)) {
    if (!wb.getWorksheet(name)) {
      const ws = wb.addWorksheet(name);
      ws.addRow(cols);
      changed = true;
      continue;
    }
    const header = wb.getWorksheet(name).getRow(1);
    cols.forEach((column, index) => {
      if (!header.getCell(index + 1).value) {
        header.getCell(index + 1).value = column;
        changed = true;
      }
    });
  }
  changed = migrateRDF2LowGrade(wb) || changed;
  changed = migrateYieldSplit(wb) || changed;
  if (changed) await saveWorkbook(wb);
  else {
    cachedWorkbook = wb;
    cachedMtimeMs = mtimeMs;
  }
  return wb;
}

function rowToObj(cols, row) {
  const obj = {};
  cols.forEach((c, i) => {
    const v = row.getCell(i + 1).value;
    const clean = v === null || v === undefined ? '' : v;
    if (JSON_COLUMNS.has(c) && typeof clean === 'string' && clean) {
      try { obj[c] = JSON.parse(clean); } catch { obj[c] = clean; }
    } else {
      obj[c] = clean;
    }
  });
  return obj;
}

function nextId(ws) {
  let maxId = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    maxId = Math.max(maxId, Number(row.getCell(1).value) || 0);
  });
  return maxId + 1;
}

function appendWorkbookRecord(wb, sheetName, data, forcedId) {
  const ws = wb.getWorksheet(sheetName);
  const cols = SHEETS[sheetName];
  const id = forcedId === undefined ? nextId(ws) : Number(forcedId);
  const record = { ID: id, CreatedAt: new Date().toISOString(), ...data };
  record.ID = id;
  ws.addRow(cols.map((column) => {
    const value = record[column];
    if (JSON_COLUMNS.has(column) && value && typeof value === 'object') return JSON.stringify(value);
    return value !== undefined ? value : '';
  }));
  return record;
}

function actorFields() {
  const context = getRequestContext();
  const user = context.user || {};
  return {
    ActorUserID: user.id || user.authUserId || 'system',
    ActorEmail: user.email || 'system',
    RequestID: context.requestId || 'system',
    IPAddress: context.ip || '',
    UserAgent: context.userAgent || '',
  };
}

function appendAudit(wb, action, entity, recordId, beforeData, afterData) {
  if (SYSTEM_SHEETS.has(entity)) return;
  appendWorkbookRecord(wb, 'AuditLog', {
    Action: action,
    Entity: entity,
    RecordID: recordId === undefined || recordId === null ? '' : String(recordId),
    ...actorFields(),
    BeforeData: beforeData || null,
    AfterData: afterData || null,
  });
}

function appendDeletedRecord(wb, entity, snapshot) {
  const actor = actorFields();
  return appendWorkbookRecord(wb, 'DeletedRecords', {
    Entity: entity,
    OriginalID: String(snapshot.ID),
    Snapshot: snapshot,
    DeletedBy: actor.ActorUserID,
    DeletedByEmail: actor.ActorEmail,
    DeletedAt: new Date().toISOString(),
    RestoredBy: '',
    RestoredByEmail: '',
    RestoredAt: '',
  });
}

async function readSheet(sheetName) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = rowToObj(cols, row);
      if (obj.ID === '' || obj.ID === null) return;
      rows.push(obj);
    });
    return rows;
  });
}

async function appendRow(sheetName, data) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const record = appendWorkbookRecord(wb, sheetName, data);
    appendAudit(wb, 'CREATE', sheetName, record.ID, null, record);
    await saveWorkbook(wb);
    return record;
  });
}

async function appendRows(sheetName, dataArr) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    let maxId = 0;
    // Re-importing the same file (same ReportDate + DateTime) updates the
    // existing row instead of creating a duplicate, regardless of whether
    // "replace existing data" was used on import.
    const isGrabCrane = sheetName === 'GrabCrane';
    const existingRowByKey = new Map();
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const id = Number(row.getCell(1).value) || 0;
      if (id > maxId) maxId = id;
      if (isGrabCrane) {
        const key = `${row.getCell(2).value}|${row.getCell(3).value}`; // ReportDate|DateTime
        existingRowByKey.set(key, rowNumber);
      }
    });
    const created = new Date().toISOString();
    const records = [];
    let updatedCount = 0;
    for (const data of dataArr) {
      if (isGrabCrane) {
        const key = `${data.ReportDate}|${data.DateTime}`;
        const existingRowNumber = existingRowByKey.get(key);
        if (existingRowNumber) {
          const row = ws.getRow(existingRowNumber);
          row.getCell(4).value = data.Weight; // Weight
          row.getCell(5).value = data.SourceFile; // SourceFile
          records.push({ ID: row.getCell(1).value, CreatedAt: row.getCell(6).value, ...data });
          updatedCount += 1;
          continue;
        }
      }
      maxId += 1;
      const record = { CreatedAt: created, ...data, ID: maxId };
      ws.addRow(cols.map((c) => (record[c] !== undefined ? record[c] : '')));
      records.push(record);
    }
    appendAudit(wb, 'BULK_UPSERT', sheetName, '', null, {
      count: records.length,
      created: records.length - updatedCount,
      updated: updatedCount,
      ids: records.map((record) => record.ID),
    });
    await saveWorkbook(wb);
    return records;
  });
}

async function updateRow(sheetName, id, patch) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    let found = null;
    let before = null;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (Number(row.getCell(1).value) === Number(id)) {
        before = rowToObj(cols, row);
        cols.forEach((c, i) => {
          if (patch[c] !== undefined) row.getCell(i + 1).value = patch[c];
        });
        if (cols.includes('UpdatedAt')) row.getCell(cols.indexOf('UpdatedAt') + 1).value = new Date().toISOString();
        found = rowToObj(cols, row);
      }
    });
    if (!found) return null;
    appendAudit(wb, 'UPDATE', sheetName, id, before, found);
    await saveWorkbook(wb);
    return found;
  });
}

async function deleteRow(sheetName, id) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    let rowNumberToDelete = null;
    let snapshot = null;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (Number(row.getCell(1).value) === Number(id)) {
        rowNumberToDelete = rowNumber;
        snapshot = rowToObj(cols, row);
      }
    });
    if (!rowNumberToDelete) return false;
    appendDeletedRecord(wb, sheetName, snapshot);
    ws.spliceRows(rowNumberToDelete, 1);
    appendAudit(wb, 'DELETE', sheetName, id, snapshot, null);
    await saveWorkbook(wb);
    return true;
  });
}

async function deleteRowsByReportDate(sheetName, dateField, dateValue) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    const idx = cols.indexOf(dateField) + 1;
    const rowsToDelete = [];
    const snapshots = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (String(row.getCell(idx).value) === String(dateValue)) {
        rowsToDelete.push(rowNumber);
        snapshots.push(rowToObj(cols, row));
      }
    });
    snapshots.forEach((snapshot) => appendDeletedRecord(wb, sheetName, snapshot));
    rowsToDelete.sort((a, b) => b - a).forEach((rn) => ws.spliceRows(rn, 1));
    if (rowsToDelete.length) {
      appendAudit(wb, 'BULK_DELETE', sheetName, '', { [dateField]: dateValue, records: snapshots }, null);
      await saveWorkbook(wb);
    }
    return rowsToDelete.length;
  });
}

async function restoreDeletedRecord(id) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const trash = wb.getWorksheet('DeletedRecords');
    const trashCols = SHEETS.DeletedRecords;
    let trashRow = null;
    let deleted = null;
    trash.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1 || Number(row.getCell(1).value) !== Number(id)) return;
      const candidate = rowToObj(trashCols, row);
      if (!candidate.RestoredAt) {
        trashRow = row;
        deleted = candidate;
      }
    });
    if (!deleted) return null;
    if (!SHEETS[deleted.Entity] || SYSTEM_SHEETS.has(deleted.Entity)) throw new Error('Unsupported restore entity');
    const snapshot = typeof deleted.Snapshot === 'string' ? JSON.parse(deleted.Snapshot) : deleted.Snapshot;
    const target = wb.getWorksheet(deleted.Entity);
    let duplicate = false;
    target.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1 && Number(row.getCell(1).value) === Number(snapshot.ID)) duplicate = true;
    });
    if (duplicate) throw new Error('Original record ID is already in use');
    const restored = appendWorkbookRecord(wb, deleted.Entity, snapshot, snapshot.ID);
    const actor = actorFields();
    trashRow.getCell(trashCols.indexOf('RestoredBy') + 1).value = actor.ActorUserID;
    trashRow.getCell(trashCols.indexOf('RestoredByEmail') + 1).value = actor.ActorEmail;
    trashRow.getCell(trashCols.indexOf('RestoredAt') + 1).value = new Date().toISOString();
    appendAudit(wb, 'RESTORE', deleted.Entity, snapshot.ID, null, restored);
    await saveWorkbook(wb);
    return restored;
  });
}

async function exportBackup() {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const sheets = {};
    for (const [sheetName, cols] of Object.entries(SHEETS)) {
      const rows = [];
      wb.getWorksheet(sheetName).eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > 1) rows.push(rowToObj(cols, row));
      });
      sheets[sheetName] = rows;
    }
    return { format: 'gp1-connect-backup', version: 1, generatedAt: new Date().toISOString(), sheets };
  });
}

async function restoreBackup(backup, options = {}) {
  if (!options.confirm) throw new Error('Restore requires explicit confirmation');
  if (!backup || backup.format !== 'gp1-connect-backup' || !backup.sheets) throw new Error('Invalid GP1 Connect backup');
  return serialize(async () => {
    const wb = new ExcelJS.Workbook();
    for (const [sheetName, cols] of Object.entries(SHEETS)) {
      const ws = wb.addWorksheet(sheetName);
      ws.addRow(cols);
      for (const record of backup.sheets[sheetName] || []) {
        ws.addRow(cols.map((column) => {
          const value = record[column];
          if (JSON_COLUMNS.has(column) && value && typeof value === 'object') return JSON.stringify(value);
          return value !== undefined ? value : '';
        }));
      }
    }
    await saveWorkbook(wb);
    ensured = true;
    return true;
  });
}

module.exports = {
  XLSX_PATH, SHEETS, readSheet, appendRow, appendRows, updateRow, deleteRow,
  deleteRowsByReportDate, restoreDeletedRecord, exportBackup, restoreBackup,
};
