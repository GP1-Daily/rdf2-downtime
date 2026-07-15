const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Uses Postgres (e.g. free Supabase) when DATABASE_URL is set - needed for
// cloud deploys with no persistent local disk. Falls back to the local
// Excel file otherwise. Both modules expose the same function signatures.
const store = process.env.DATABASE_URL ? require('./pg-store') : require('./store');
const lib = require('./lib');

const PORT = process.env.PORT || 5600;
const DIR = __dirname;
const HTML_PATH = path.join(DIR, 'index.html');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 20e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---------- Downtime ----------

async function handleDowntime(req, res, parts, query) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('Downtime');
    const date = query.date;
    const filtered = date ? rows.filter((r) => r.EntryDate === date) : rows;
    filtered.sort((a, b) => (a.StartTime > b.StartTime ? 1 : -1));
    return sendJson(res, 200, { ok: true, rows: filtered });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    if (!body.entryDate || !body.startTime || !body.endTime) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ entryDate, startTime, endTime' });
    }
    const record = await store.appendRow('Downtime', {
      EntryDate: body.entryDate,
      StartTime: body.startTime,
      EndTime: body.endTime,
      Reason: body.reason || '',
      Note: body.note || '',
    });
    return sendJson(res, 200, { ok: true, row: record });
  }
  if (req.method === 'PUT' && parts.length === 1) {
    const body = await readBody(req);
    const patch = {};
    if (body.entryDate !== undefined) patch.EntryDate = body.entryDate;
    if (body.startTime !== undefined) patch.StartTime = body.startTime;
    if (body.endTime !== undefined) patch.EndTime = body.endTime;
    if (body.reason !== undefined) patch.Reason = body.reason;
    if (body.note !== undefined) patch.Note = body.note;
    const record = await store.updateRow('Downtime', parts[0], patch);
    if (!record) return sendJson(res, 404, { ok: false, error: 'ไม่พบรายการ' });
    return sendJson(res, 200, { ok: true, row: record });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const okDel = await store.deleteRow('Downtime', parts[0]);
    return sendJson(res, 200, { ok: okDel });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// ---------- Line Time ----------

async function handleLine(req, res, parts, query) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('LineTime');
    const date = query.date;
    const filtered = date ? rows.filter((r) => r.EntryDate === date) : rows;
    filtered.sort((a, b) => (a.Time > b.Time ? 1 : -1));
    return sendJson(res, 200, { ok: true, rows: filtered });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    if (!body.entryDate || !body.eventType || !body.time) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ entryDate, eventType, time' });
    }
    if (body.eventType !== 'Start' && body.eventType !== 'Stop') {
      return sendJson(res, 400, { ok: false, error: 'eventType ต้องเป็น Start หรือ Stop' });
    }
    const record = await store.appendRow('LineTime', {
      EntryDate: body.entryDate,
      EventType: body.eventType,
      Time: body.time,
      StopType: body.eventType === 'Stop' ? (body.stopType || '') : '',
      Note: body.note || '',
    });
    return sendJson(res, 200, { ok: true, row: record });
  }
  if (req.method === 'PUT' && parts.length === 1) {
    const body = await readBody(req);
    const patch = {};
    if (body.entryDate !== undefined) patch.EntryDate = body.entryDate;
    if (body.eventType !== undefined) patch.EventType = body.eventType;
    if (body.time !== undefined) patch.Time = body.time;
    if (body.stopType !== undefined) patch.StopType = body.stopType;
    if (body.note !== undefined) patch.Note = body.note;
    const record = await store.updateRow('LineTime', parts[0], patch);
    if (!record) return sendJson(res, 404, { ok: false, error: 'ไม่พบรายการ' });
    return sendJson(res, 200, { ok: true, row: record });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const okDel = await store.deleteRow('LineTime', parts[0]);
    return sendJson(res, 200, { ok: okDel });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// pairs Start/Stop LineTime events chronologically into sessions
function computeLineSessions(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.EntryDate !== b.EntryDate) return a.EntryDate < b.EntryDate ? -1 : 1;
    return a.Time < b.Time ? -1 : (a.Time > b.Time ? 1 : 0);
  });
  const sessions = [];
  let open = null;
  for (const ev of sorted) {
    if (ev.EventType === 'Start') {
      // A Start superseded by another Start (no Stop in between) is an
      // abandoned/forgotten entry, not a still-running session - the new
      // Start proves the old one must have already ended, we just don't know
      // when. Flagged separately from the one true still-open session below.
      if (open) sessions.push({ start: open, stop: null, incomplete: true, superseded: true });
      open = ev;
    } else if (ev.EventType === 'Stop') {
      if (open) {
        sessions.push({ start: open, stop: ev, incomplete: false });
        open = null;
      } else {
        sessions.push({ start: null, stop: ev, incomplete: true });
      }
    }
  }
  if (open) sessions.push({ start: open, stop: null, incomplete: true, superseded: false });
  return sessions;
}

// ---------- Grab Crane ----------

async function handleGrabImport(req, res) {
  const body = await readBody(req);
  const { reportDate, rows, sourceFile, replace } = body;
  if (!reportDate || !Array.isArray(rows)) {
    return sendJson(res, 400, { ok: false, error: 'ต้องระบุ reportDate และ rows' });
  }
  if (replace) {
    await store.deleteRowsByReportDate('GrabCrane', 'ReportDate', reportDate);
  }
  const data = rows
    .filter((r) => r.dateTime && r.weight !== undefined && r.weight !== null && r.weight !== '')
    .map((r) => ({
      ReportDate: reportDate,
      DateTime: r.dateTime,
      Weight: Number(r.weight),
      SourceFile: sourceFile || '',
    }));
  await store.appendRows('GrabCrane', data);
  return sendJson(res, 200, { ok: true, imported: data.length });
}

async function handleGrabGet(req, res, query) {
  const rows = await store.readSheet('GrabCrane');
  const date = query.date;
  const filtered = date ? rows.filter((r) => r.ReportDate === date) : rows;
  return sendJson(res, 200, { ok: true, rows: filtered });
}

async function handleGrabDelete(req, res, query) {
  const date = query.date;
  if (!date) return sendJson(res, 400, { ok: false, error: 'ต้องระบุ date' });
  const n = await store.deleteRowsByReportDate('GrabCrane', 'ReportDate', date);
  return sendJson(res, 200, { ok: true, deleted: n });
}

// ---------- Report ----------

function extractTimeOfDay(dateTimeStr) {
  const m = String(dateTimeStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return '00:00';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

async function handleReport(req, res, query) {
  const date = query.date || lib.addDays(lib.todayStr(), -1);
  const prevDate = lib.addDays(date, -1);

  const [downtimeRows, lineRows, grabRows] = await Promise.all([
    store.readSheet('Downtime'),
    store.readSheet('LineTime'),
    store.readSheet('GrabCrane'),
  ]);

  // ---- Downtime: split across midnight + period boundaries ----
  const relevantDowntime = downtimeRows.filter((r) => r.EntryDate === date || r.EntryDate === prevDate);
  const downtimeSegments = [];
  for (const r of relevantDowntime) {
    const segs = lib.splitEntry(r.EntryDate, r.StartTime, r.EndTime);
    for (const s of segs) {
      if (s.date !== date) continue;
      downtimeSegments.push({
        ...s,
        id: r.ID,
        reason: r.Reason,
        note: r.Note,
        carriedOver: r.EntryDate !== date,
        originalEntryDate: r.EntryDate,
        originalStartTime: r.StartTime,
        originalEndTime: r.EndTime,
      });
    }
  }
  downtimeSegments.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  const totalDowntimeMin = downtimeSegments.reduce((s, x) => s + x.minutes, 0);
  const downtimeByPeriod = { 'เช้า': 0, 'บ่าย': 0, 'ดึก': 0 };
  for (const s of downtimeSegments) downtimeByPeriod[s.period] += s.minutes;

  // ---- Line sessions ----
  // Pair across ALL rows (not just a window around `date`): a Start left open
  // for several days (forgotten Stop Line) must still be found and credited
  // on every day it spans, not just the day it started.
  const sessions = computeLineSessions(lineRows);
  const nowBkk = lib.nowInBangkok();
  const lineSegments = [];
  const incompleteSessions = [];
  for (const sess of sessions) {
    if (sess.incomplete) {
      if (sess.stop && !sess.start && sess.stop.EntryDate === date) {
        incompleteSessions.push({ type: 'no-start', entryDate: sess.stop.EntryDate, time: sess.stop.Time, note: sess.stop.Note });
      }
      if (sess.start && !sess.stop && sess.superseded) {
        // Abandoned: a later Start proves this one must have already ended,
        // but we don't know when - flag it, don't credit it with phantom
        // running time all the way up to now.
        if (sess.start.EntryDate === date) {
          incompleteSessions.push({ type: 'no-stop', entryDate: sess.start.EntryDate, time: sess.start.Time, note: sess.start.Note });
        }
      } else if (sess.start && !sess.stop) {
        // The one genuinely still-open session (nothing has superseded it) is
        // still "running" up through now - give it provisional credit on
        // every day it spans (including today, up to the current time)
        // instead of it silently disappearing until the operator eventually
        // logs the real Stop Line.
        const segs = lib.splitRange(sess.start.EntryDate, sess.start.Time, nowBkk.date, nowBkk.time);
        for (const s of segs) {
          if (s.date !== date) continue;
          lineSegments.push({
            ...s,
            sessionStart: `${sess.start.EntryDate} ${sess.start.Time}`,
            sessionStop: null,
            stopType: '',
            ongoing: true,
          });
        }
      }
      continue;
    }
    const segs = lib.splitRange(sess.start.EntryDate, sess.start.Time, sess.stop.EntryDate, sess.stop.Time);
    for (const s of segs) {
      if (s.date !== date) continue;
      lineSegments.push({
        ...s,
        sessionStart: `${sess.start.EntryDate} ${sess.start.Time}`,
        sessionStop: `${sess.stop.EntryDate} ${sess.stop.Time}`,
        stopType: sess.stop.StopType || '',
      });
    }
  }
  lineSegments.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  const totalLineMin = lineSegments.reduce((s, x) => s + x.minutes, 0);
  const lineByPeriod = { 'เช้า': 0, 'บ่าย': 0, 'ดึก': 0 };
  for (const s of lineSegments) lineByPeriod[s.period] += s.minutes;

  const netRunMin = Math.max(0, totalLineMin - totalDowntimeMin);
  const availabilityPct = totalLineMin > 0 ? (netRunMin / totalLineMin) * 100 : null;

  // ---- Grab crane ----
  const grabForDate = grabRows.filter((r) => r.ReportDate === date);
  const totalGrabs = grabForDate.length;
  const totalWeight = grabForDate.reduce((s, r) => s + (Number(r.Weight) || 0), 0);
  const avgWeight = totalGrabs > 0 ? totalWeight / totalGrabs : null;
  const grabByPeriod = {
    'เช้า': { count: 0, totalWeight: 0 },
    'บ่าย': { count: 0, totalWeight: 0 },
    'ดึก': { count: 0, totalWeight: 0 },
  };
  for (const r of grabForDate) {
    const t = extractTimeOfDay(r.DateTime);
    const p = lib.periodOfTime(t);
    grabByPeriod[p].count += 1;
    grabByPeriod[p].totalWeight += Number(r.Weight) || 0;
  }
  for (const p of Object.keys(grabByPeriod)) {
    const g = grabByPeriod[p];
    g.avgWeight = g.count > 0 ? g.totalWeight / g.count : null;
  }

  return sendJson(res, 200, {
    ok: true,
    date,
    downtime: {
      segments: downtimeSegments,
      totalMinutes: totalDowntimeMin,
      byPeriod: downtimeByPeriod,
    },
    line: {
      segments: lineSegments,
      totalMinutes: totalLineMin,
      byPeriod: lineByPeriod,
      incomplete: incompleteSessions,
      netRunMinutes: netRunMin,
      availabilityPct,
    },
    grab: {
      totalGrabs,
      avgWeight,
      totalWeight,
      byPeriod: grabByPeriod,
    },
  });
}

// ---------- Production & Stock ----------

// Yield % settings are effective-dated: the setting used for a given day is
// whichever one was most recently in effect on or before that day, so
// updating the yield doesn't retroactively change past days' numbers.
function getApplicableYield(yieldRows, date) {
  const applicable = yieldRows
    .filter((y) => y.EffectiveDate <= date)
    .sort((a, b) => (a.EffectiveDate < b.EffectiveDate ? -1 : 1));
  return applicable.length ? applicable[applicable.length - 1] : null;
}

function computeProduction(incomingWaste, yieldSetting) {
  if (!yieldSetting || incomingWaste <= 0) return null;
  const rdf2Pct = Number(yieldSetting.RDF2Pct) || 0;
  const fineFractionPct = Number(yieldSetting.FineFractionPct) || 0;
  const heavyFractionPct = Number(yieldSetting.HeavyFractionPct) || 0;
  const metalPct = Number(yieldSetting.MetalPct) || 0;
  const waterPct = Math.max(0, 100 - rdf2Pct - fineFractionPct - heavyFractionPct - metalPct);
  return {
    incomingWaste,
    yieldPct: { rdf2: rdf2Pct, fineFraction: fineFractionPct, heavyFraction: heavyFractionPct, metal: metalPct, water: waterPct },
    tons: {
      rdf2: incomingWaste * rdf2Pct / 100,
      fineFraction: incomingWaste * fineFractionPct / 100,
      heavyFraction: incomingWaste * heavyFractionPct / 100,
      metal: incomingWaste * metalPct / 100,
      water: incomingWaste * waterPct / 100,
    },
  };
}

async function handleProduction(req, res, query) {
  const date = query.date || lib.todayStr();
  const [grabRows, yieldRows] = await Promise.all([
    store.readSheet('GrabCrane'),
    store.readSheet('YieldSettings'),
  ]);
  const incomingWaste = grabRows.filter((r) => r.ReportDate === date).reduce((s, r) => s + (Number(r.Weight) || 0), 0);
  const yieldSetting = getApplicableYield(yieldRows, date);
  const production = computeProduction(incomingWaste, yieldSetting);
  return sendJson(res, 200, { ok: true, date, incomingWaste, hasYieldSetting: !!yieldSetting, production });
}

async function handleYield(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('YieldSettings');
    rows.sort((a, b) => (a.EffectiveDate < b.EffectiveDate ? 1 : -1));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const { effectiveDate, rdf2Pct, fineFractionPct, heavyFractionPct, metalPct } = body;
    if (!effectiveDate || [rdf2Pct, fineFractionPct, heavyFractionPct, metalPct].some((v) => v === undefined || v === null || v === '')) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ effectiveDate และเปอร์เซ็นต์ทั้ง 4 ค่า' });
    }
    const sum = Number(rdf2Pct) + Number(fineFractionPct) + Number(heavyFractionPct) + Number(metalPct);
    if (sum > 100) return sendJson(res, 400, { ok: false, error: 'ผลรวมเปอร์เซ็นต์ต้องไม่เกิน 100' });
    const record = await store.appendRow('YieldSettings', {
      EffectiveDate: effectiveDate,
      RDF2Pct: Number(rdf2Pct),
      FineFractionPct: Number(fineFractionPct),
      HeavyFractionPct: Number(heavyFractionPct),
      MetalPct: Number(metalPct),
    });
    return sendJson(res, 200, { ok: true, row: record });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const okDel = await store.deleteRow('YieldSettings', parts[0]);
    return sendJson(res, 200, { ok: okDel });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleStockBaseline(req, res) {
  if (req.method === 'GET') {
    const rows = await store.readSheet('StockBaseline');
    return sendJson(res, 200, { ok: true, row: rows[0] || null });
  }
  if (req.method === 'PUT') {
    const body = await readBody(req);
    const { baselineDate, rdf2Tons, fineFractionTons, metalTons } = body;
    if (!baselineDate) return sendJson(res, 400, { ok: false, error: 'ต้องระบุ baselineDate' });
    const rows = await store.readSheet('StockBaseline');
    const patch = {
      BaselineDate: baselineDate,
      RDF2Tons: Number(rdf2Tons) || 0,
      FineFractionTons: Number(fineFractionTons) || 0,
      MetalTons: Number(metalTons) || 0,
    };
    const record = rows.length === 0
      ? await store.appendRow('StockBaseline', patch)
      : await store.updateRow('StockBaseline', rows[0].ID, patch);
    return sendJson(res, 200, { ok: true, row: record });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

const SALES_MATERIALS = ['RDF2', 'FineFraction', 'Metal'];

async function handleSales(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('Sales');
    rows.sort((a, b) => (a.SaleDate < b.SaleDate ? 1 : -1));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const { saleDate, material, customer, tons, note } = body;
    if (!saleDate || !material || !tons) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ saleDate, material, tons' });
    }
    if (!SALES_MATERIALS.includes(material)) {
      return sendJson(res, 400, { ok: false, error: 'material ต้องเป็น RDF2, FineFraction หรือ Metal' });
    }
    const record = await store.appendRow('Sales', {
      SaleDate: saleDate, Material: material, Customer: customer || '', Tons: Number(tons), Note: note || '',
    });
    return sendJson(res, 200, { ok: true, row: record });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const okDel = await store.deleteRow('Sales', parts[0]);
    return sendJson(res, 200, { ok: okDel });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleStock(req, res) {
  const [grabRows, yieldRows, baselineRows, salesRows] = await Promise.all([
    store.readSheet('GrabCrane'),
    store.readSheet('YieldSettings'),
    store.readSheet('StockBaseline'),
    store.readSheet('Sales'),
  ]);
  const baseline = baselineRows[0] || null;
  const baselineDate = baseline ? baseline.BaselineDate : lib.todayStr();
  const totals = {
    rdf2: baseline ? Number(baseline.RDF2Tons) || 0 : 0,
    fineFraction: baseline ? Number(baseline.FineFractionTons) || 0 : 0,
    metal: baseline ? Number(baseline.MetalTons) || 0 : 0,
  };

  const weightByDate = {};
  for (const r of grabRows) {
    weightByDate[r.ReportDate] = (weightByDate[r.ReportDate] || 0) + (Number(r.Weight) || 0);
  }

  const dailyProduction = [];
  for (const [date, weight] of Object.entries(weightByDate)) {
    if (date < baselineDate) continue;
    const yieldSetting = getApplicableYield(yieldRows, date);
    const prod = computeProduction(weight, yieldSetting);
    if (!prod) continue;
    totals.rdf2 += prod.tons.rdf2;
    totals.fineFraction += prod.tons.fineFraction;
    totals.metal += prod.tons.metal;
    dailyProduction.push({ date, incomingWaste: weight, tons: prod.tons });
  }
  dailyProduction.sort((a, b) => (a.date < b.date ? -1 : 1));

  const salesTotals = { rdf2: 0, fineFraction: 0, metal: 0 };
  const relevantSales = salesRows.filter((r) => r.SaleDate >= baselineDate);
  for (const r of relevantSales) {
    const key = r.Material === 'RDF2' ? 'rdf2' : r.Material === 'FineFraction' ? 'fineFraction' : 'metal';
    salesTotals[key] += Number(r.Tons) || 0;
  }
  totals.rdf2 -= salesTotals.rdf2;
  totals.fineFraction -= salesTotals.fineFraction;
  totals.metal -= salesTotals.metal;

  return sendJson(res, 200, {
    ok: true,
    baseline,
    baselineDate,
    stock: totals,
    productionSince: dailyProduction,
    salesTotals,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);
    const query = parsed.query;

    if (pathname.startsWith('/api/')) {
      const segs = pathname.split('/').filter(Boolean); // ['api','downtime', '3']
      const resource = segs[1];
      const rest = segs.slice(2);

      if (resource === 'downtime') return await handleDowntime(req, res, rest, query);
      if (resource === 'line') return await handleLine(req, res, rest, query);
      if (resource === 'report') return await handleReport(req, res, query);
      if (resource === 'grab') {
        if (rest[0] === 'import' && req.method === 'POST') return await handleGrabImport(req, res);
        if (rest.length === 0 && req.method === 'GET') return await handleGrabGet(req, res, query);
        if (rest.length === 0 && req.method === 'DELETE') return await handleGrabDelete(req, res, query);
      }
      if (resource === 'production') return await handleProduction(req, res, query);
      if (resource === 'yield') return await handleYield(req, res, rest);
      if (resource === 'sales') return await handleSales(req, res, rest);
      if (resource === 'stock') {
        if (rest[0] === 'baseline') return await handleStockBaseline(req, res);
        if (rest.length === 0 && req.method === 'GET') return await handleStock(req, res);
      }
      return sendJson(res, 404, { ok: false, error: 'unknown api route' });
    }

    let filePath = pathname === '/' ? HTML_PATH : path.join(DIR, pathname);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

function startServer(port) {
  server.listen(port, () => {
    const link = `http://localhost:${port}/`;
    console.log(`RDF2 Downtime Logger running at ${link}`);
    if (store.XLSX_PATH) {
      console.log(`ไฟล์ข้อมูล: ${store.XLSX_PATH}`);
      console.log('เปิดเบราว์เซอร์ไปที่ลิงก์ด้านบน แล้วเปิดค้างไว้ระหว่างใช้งาน (อย่าปิดหน้าต่างดำนี้)');
    } else {
      console.log('ใช้ฐานข้อมูล Postgres ผ่าน DATABASE_URL');
    }
    const { exec } = require('child_process');
    if (process.platform === 'win32') exec(`start "" "${link}"`);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const nextPort = server.__port + 1;
    if (server.__attemptsLeft > 0) {
      console.log(`พอร์ต ${server.__port} ถูกใช้งานอยู่แล้ว กำลังลองพอร์ต ${nextPort}...`);
      server.__port = nextPort;
      server.__attemptsLeft -= 1;
      setTimeout(() => startServer(nextPort), 200);
    } else {
      console.error('ไม่สามารถเปิดพอร์ตใดๆ ได้เลย ลองปิดหน้าต่างเดิมที่ค้างอยู่ก่อน แล้วเปิดใหม่');
      process.exit(1);
    }
  } else {
    console.error(err);
    process.exit(1);
  }
});

server.__port = PORT;
server.__attemptsLeft = 10;
startServer(PORT);
