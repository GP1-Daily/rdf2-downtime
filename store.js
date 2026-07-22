const path = require('path');
const ExcelJS = require('exceljs');

const XLSX_PATH = process.env.RDF2_XLSX_PATH
  ? path.resolve(process.env.RDF2_XLSX_PATH)
  : path.join(__dirname, 'RDF2_Downtime.xlsx');

const SHEETS = {
  Downtime: ['ID', 'EntryDate', 'StartTime', 'EndTime', 'Reason', 'Note', 'CreatedAt'],
  LineTime: ['ID', 'EntryDate', 'EventType', 'Time', 'Note', 'CreatedAt', 'StopType'],
  GrabCrane: ['ID', 'ReportDate', 'DateTime', 'Weight', 'SourceFile', 'CreatedAt'],
  YieldSettings: ['ID', 'EffectiveDate', 'RDF2Pct', 'FineFractionPct', 'HeavyFractionPct', 'MetalPct', 'CreatedAt'],
  StockBaseline: ['ID', 'BaselineDate', 'RDF2Tons', 'FineFractionTons', 'MetalTons', 'CreatedAt'],
  Sales: ['ID', 'SaleDate', 'Material', 'Customer', 'Tons', 'Note', 'CreatedAt'],
  RevenueCustomers: ['ID', 'Name', 'Active', 'CreatedAt'],
  RevenuePrices: ['ID', 'EffectiveDate', 'Customer', 'Product', 'PricePerTon', 'CreatedAt'],
  RevenueRDF3Sales: ['ID', 'SaleDate', 'Customer', 'Tons', 'Note', 'CreatedAt'],
  RevenueTippingSettings: ['ID', 'EffectiveDate', 'RatePerTon', 'ExcludedCentralTons', 'ExcludedMinTons', 'ExcludedMaxTons', 'CreatedAt'],
  RevenueTippingDaily: ['ID', 'EntryDate', 'MSWTons', 'Note', 'CreatedAt'],
  WeeklyDeliveryPlans: ['ID', 'WeekStart', 'Customer', 'Product', 'PlanTons', 'CreatedAt'],
  KPIDailyHistory: ['ID', 'EntryDate', 'RDF2Tons', 'RDF3Tons', 'FineFractionTons', 'MSWTons', 'Source', 'CreatedAt'],
  KPIComplaints: ['ID', 'EntryDate', 'Customer', 'Detail', 'CreatedAt'],
  KPITargetSettings: ['ID', 'EffectiveDate', 'RDF2Target', 'RDF3Target', 'FineFractionTarget', 'MSWTarget', 'ComplaintLimit', 'CreatedAt'],
};

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
async function ensureWorkbook() {
  const fs = require('fs');
  if (ensured || fs.existsSync(XLSX_PATH)) { ensured = true; return; }
  const wb = new ExcelJS.Workbook();
  for (const [name, cols] of Object.entries(SHEETS)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols);
  }
  await wb.xlsx.writeFile(XLSX_PATH);
  ensured = true;
}

async function loadWorkbook() {
  await ensureWorkbook();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  for (const [name, cols] of Object.entries(SHEETS)) {
    if (!wb.getWorksheet(name)) {
      const ws = wb.addWorksheet(name);
      ws.addRow(cols);
    }
  }
  return wb;
}

function rowToObj(cols, row) {
  const obj = {};
  cols.forEach((c, i) => {
    const v = row.getCell(i + 1).value;
    obj[c] = v === null || v === undefined ? '' : v;
  });
  return obj;
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
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    let maxId = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const id = Number(row.getCell(1).value) || 0;
      if (id > maxId) maxId = id;
    });
    const id = maxId + 1;
    const record = { ID: id, CreatedAt: new Date().toISOString(), ...data, };
    record.ID = id;
    ws.addRow(cols.map((c) => (record[c] !== undefined ? record[c] : '')));
    await wb.xlsx.writeFile(XLSX_PATH);
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
    for (const data of dataArr) {
      if (isGrabCrane) {
        const key = `${data.ReportDate}|${data.DateTime}`;
        const existingRowNumber = existingRowByKey.get(key);
        if (existingRowNumber) {
          const row = ws.getRow(existingRowNumber);
          row.getCell(4).value = data.Weight; // Weight
          row.getCell(5).value = data.SourceFile; // SourceFile
          records.push({ ID: row.getCell(1).value, CreatedAt: row.getCell(6).value, ...data });
          continue;
        }
      }
      maxId += 1;
      const record = { CreatedAt: created, ...data, ID: maxId };
      ws.addRow(cols.map((c) => (record[c] !== undefined ? record[c] : '')));
      records.push(record);
    }
    await wb.xlsx.writeFile(XLSX_PATH);
    return records;
  });
}

async function updateRow(sheetName, id, patch) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    const cols = SHEETS[sheetName];
    let found = null;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (Number(row.getCell(1).value) === Number(id)) {
        cols.forEach((c, i) => {
          if (patch[c] !== undefined) row.getCell(i + 1).value = patch[c];
        });
        found = rowToObj(cols, row);
      }
    });
    if (!found) return null;
    await wb.xlsx.writeFile(XLSX_PATH);
    return found;
  });
}

async function deleteRow(sheetName, id) {
  return serialize(async () => {
    const wb = await loadWorkbook();
    const ws = wb.getWorksheet(sheetName);
    let rowNumberToDelete = null;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (Number(row.getCell(1).value) === Number(id)) rowNumberToDelete = rowNumber;
    });
    if (!rowNumberToDelete) return false;
    ws.spliceRows(rowNumberToDelete, 1);
    await wb.xlsx.writeFile(XLSX_PATH);
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
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (String(row.getCell(idx).value) === String(dateValue)) rowsToDelete.push(rowNumber);
    });
    rowsToDelete.sort((a, b) => b - a).forEach((rn) => ws.spliceRows(rn, 1));
    if (rowsToDelete.length) await wb.xlsx.writeFile(XLSX_PATH);
    return rowsToDelete.length;
  });
}

module.exports = {
  XLSX_PATH, SHEETS, readSheet, appendRow, appendRows, updateRow, deleteRow, deleteRowsByReportDate,
};
