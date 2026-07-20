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

  // ---- Downtime: split across midnight + period boundaries, then clipped to
  // only the portion that overlaps an active Start-Stop Line window. Downtime
  // logged while the line wasn't even running (e.g. maintenance before the
  // first Start Line of the day) would otherwise inflate downtime past the
  // total line time, making "net run time" negative and Availability
  // nonsensical.
  const activeRanges = lineSegments.map((s) => [lib.timeToMinutes(s.startTime), lib.timeToMinutes(s.endTime)]);
  function overlapMinutes(startMin, endMin) {
    let total = 0;
    for (const [aStart, aEnd] of activeRanges) {
      const lo = Math.max(startMin, aStart), hi = Math.min(endMin, aEnd);
      if (hi > lo) total += hi - lo;
    }
    return total;
  }

  const relevantDowntime = downtimeRows.filter((r) => r.EntryDate === date || r.EntryDate === prevDate);
  const downtimeSegments = [];
  for (const r of relevantDowntime) {
    const segs = lib.splitEntry(r.EntryDate, r.StartTime, r.EndTime);
    for (const s of segs) {
      if (s.date !== date) continue;
      const startMin = lib.timeToMinutes(s.startTime), endMin = lib.timeToMinutes(s.endTime);
      const insideLineMinutes = overlapMinutes(startMin, endMin);
      downtimeSegments.push({
        ...s,
        id: r.ID,
        reason: r.Reason,
        note: r.Note,
        carriedOver: r.EntryDate !== date,
        originalEntryDate: r.EntryDate,
        originalStartTime: r.StartTime,
        originalEndTime: r.EndTime,
        insideLineMinutes,
        outsideLineMinutes: s.minutes - insideLineMinutes,
      });
    }
  }
  downtimeSegments.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  const totalDowntimeMinRaw = downtimeSegments.reduce((s, x) => s + x.minutes, 0);
  const totalDowntimeMin = downtimeSegments.reduce((s, x) => s + x.insideLineMinutes, 0);
  const downtimeByPeriod = { 'เช้า': 0, 'บ่าย': 0, 'ดึก': 0 };
  for (const s of downtimeSegments) downtimeByPeriod[s.period] += s.insideLineMinutes;

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
      totalMinutesRaw: totalDowntimeMinRaw,
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

// ---------- Company Revenue (isolated from existing stock logic) ----------

const REVENUE_PRODUCTS = ['RDF2', 'RDF3', 'FineFraction'];
const DEFAULT_TIPPING_SETTING = {
  EffectiveDate: '2000-01-01',
  RatePerTon: 250,
  ExcludedCentralTons: 180,
  ExcludedMinTons: 160,
  ExcludedMaxTons: 200,
};

function cleanText(value) {
  return String(value || '').trim();
}

function sameText(a, b) {
  return cleanText(a).toLocaleLowerCase('th-TH') === cleanText(b).toLocaleLowerCase('th-TH');
}

function validMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''));
}

function validIsoDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function mondayForDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  return lib.addDays(date, -daysSinceMonday);
}

function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(days).padStart(2, '0')}`,
    days,
  };
}

function applicableRow(rows, date, dateField) {
  const matches = rows
    .filter((row) => String(row[dateField]) <= date)
    .sort((a, b) => String(a[dateField]).localeCompare(String(b[dateField])));
  return matches.length ? matches[matches.length - 1] : null;
}

function applicableRevenuePrice(priceRows, customer, product, date) {
  return applicableRow(
    priceRows.filter((row) => sameText(row.Customer, customer) && row.Product === product),
    date,
    'EffectiveDate',
  );
}

async function handleRevenueCustomers(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('RevenueCustomers');
    rows.sort((a, b) => cleanText(a.Name).localeCompare(cleanText(b.Name), 'th'));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const name = cleanText(body.name);
    if (!name) return sendJson(res, 400, { ok: false, error: 'ต้องระบุชื่อลูกค้า' });
    const rows = await store.readSheet('RevenueCustomers');
    const existing = rows.find((row) => sameText(row.Name, name));
    if (existing) return sendJson(res, 200, { ok: true, row: existing, existing: true });
    const row = await store.appendRow('RevenueCustomers', { Name: name, Active: true });
    return sendJson(res, 200, { ok: true, row });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('RevenueCustomers', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleRevenuePrices(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('RevenuePrices');
    rows.sort((a, b) => String(b.EffectiveDate).localeCompare(String(a.EffectiveDate)));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const effectiveDate = cleanText(body.effectiveDate);
    const customer = cleanText(body.customer);
    const product = cleanText(body.product);
    const pricePerTon = Number(body.pricePerTon);
    if (!effectiveDate || !customer || !REVENUE_PRODUCTS.includes(product) || !Number.isFinite(pricePerTon) || pricePerTon < 0) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาระบุวันที่ ลูกค้า สินค้า และราคาต่อตันให้ถูกต้อง' });
    }
    const customers = await store.readSheet('RevenueCustomers');
    if (!customers.some((row) => sameText(row.Name, customer))) {
      return sendJson(res, 400, { ok: false, error: 'ไม่พบลูกค้าในรายการ Setup' });
    }
    const rows = await store.readSheet('RevenuePrices');
    const existing = rows.find((row) => row.EffectiveDate === effectiveDate && row.Product === product && sameText(row.Customer, customer));
    const data = { EffectiveDate: effectiveDate, Customer: customer, Product: product, PricePerTon: pricePerTon };
    const row = existing
      ? await store.updateRow('RevenuePrices', existing.ID, data)
      : await store.appendRow('RevenuePrices', data);
    return sendJson(res, 200, { ok: true, row, updated: !!existing });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('RevenuePrices', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleRevenueRDF3Sales(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('RevenueRDF3Sales');
    rows.sort((a, b) => String(b.SaleDate).localeCompare(String(a.SaleDate)));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const saleDate = cleanText(body.saleDate);
    const customer = cleanText(body.customer);
    const tons = Number(body.tons);
    if (!saleDate || !customer || !Number.isFinite(tons) || tons <= 0) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาระบุวันที่ ลูกค้า และจำนวนตัน RDF3' });
    }
    const customers = await store.readSheet('RevenueCustomers');
    if (!customers.some((row) => sameText(row.Name, customer))) {
      return sendJson(res, 400, { ok: false, error: 'ไม่พบลูกค้าในรายการ Setup' });
    }
    const row = await store.appendRow('RevenueRDF3Sales', {
      SaleDate: saleDate, Customer: customer, Tons: tons, Note: cleanText(body.note),
    });
    return sendJson(res, 200, { ok: true, row });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('RevenueRDF3Sales', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleRevenueTippingSettings(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('RevenueTippingSettings');
    rows.sort((a, b) => String(b.EffectiveDate).localeCompare(String(a.EffectiveDate)));
    const current = applicableRow(rows, lib.nowInBangkok().date, 'EffectiveDate') || DEFAULT_TIPPING_SETTING;
    return sendJson(res, 200, { ok: true, rows, current });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const data = {
      EffectiveDate: cleanText(body.effectiveDate),
      RatePerTon: Number(body.ratePerTon),
      ExcludedCentralTons: Number(body.excludedCentralTons),
      ExcludedMinTons: Number(body.excludedMinTons),
      ExcludedMaxTons: Number(body.excludedMaxTons),
    };
    if (!data.EffectiveDate || !Number.isFinite(data.RatePerTon) || data.RatePerTon < 0
      || !Number.isFinite(data.ExcludedCentralTons) || !Number.isFinite(data.ExcludedMinTons)
      || !Number.isFinite(data.ExcludedMaxTons) || data.ExcludedMinTons > data.ExcludedCentralTons
      || data.ExcludedCentralTons > data.ExcludedMaxTons) {
      return sendJson(res, 400, { ok: false, error: 'ค่าตั้ง Tipping Fee หรือช่วงบ้านมะเกลือไม่ถูกต้อง' });
    }
    const rows = await store.readSheet('RevenueTippingSettings');
    const existing = rows.find((row) => row.EffectiveDate === data.EffectiveDate);
    const row = existing
      ? await store.updateRow('RevenueTippingSettings', existing.ID, data)
      : await store.appendRow('RevenueTippingSettings', data);
    return sendJson(res, 200, { ok: true, row, updated: !!existing });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('RevenueTippingSettings', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleRevenueTippingDaily(req, res, parts, query) {
  if (req.method === 'GET' && parts.length === 0) {
    let rows = await store.readSheet('RevenueTippingDaily');
    if (query.month) rows = rows.filter((row) => String(row.EntryDate).startsWith(`${query.month}-`));
    rows.sort((a, b) => String(b.EntryDate).localeCompare(String(a.EntryDate)));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const entryDate = cleanText(body.entryDate);
    const mswTons = Number(body.mswTons);
    if (!entryDate || !Number.isFinite(mswTons) || mswTons < 0) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาระบุวันที่และน้ำหนัก MSW ให้ถูกต้อง' });
    }
    const rows = await store.readSheet('RevenueTippingDaily');
    const existing = rows.find((row) => row.EntryDate === entryDate);
    const data = { EntryDate: entryDate, MSWTons: mswTons, Note: cleanText(body.note) };
    const row = existing
      ? await store.updateRow('RevenueTippingDaily', existing.ID, data)
      : await store.appendRow('RevenueTippingDaily', data);
    return sendJson(res, 200, { ok: true, row, updated: !!existing });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('RevenueTippingDaily', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handleRevenueDashboard(req, res, query) {
  const nowBkk = lib.nowInBangkok();
  const month = validMonth(query.month) ? query.month : nowBkk.date.slice(0, 7);
  const bounds = monthBounds(month);
  const [stockSales, rdf3Sales, prices, tippingRows, tippingSettings] = await Promise.all([
    store.readSheet('Sales'),
    store.readSheet('RevenueRDF3Sales'),
    store.readSheet('RevenuePrices'),
    store.readSheet('RevenueTippingDaily'),
    store.readSheet('RevenueTippingSettings'),
  ]);

  const sales = stockSales
    .filter((row) => row.SaleDate >= bounds.start && row.SaleDate <= bounds.end && ['RDF2', 'FineFraction'].includes(row.Material))
    .map((row) => ({
      source: 'stock', sourceId: row.ID, date: row.SaleDate, product: row.Material,
      customer: cleanText(row.Customer), tons: Number(row.Tons) || 0,
    }));
  for (const row of rdf3Sales) {
    if (row.SaleDate < bounds.start || row.SaleDate > bounds.end) continue;
    sales.push({
      source: 'rdf3', sourceId: row.ID, date: row.SaleDate, product: 'RDF3',
      customer: cleanText(row.Customer), tons: Number(row.Tons) || 0,
    });
  }

  const pricedSales = sales.map((sale) => {
    const price = applicableRevenuePrice(prices, sale.customer, sale.product, sale.date);
    const pricePerTon = price ? Number(price.PricePerTon) || 0 : null;
    return { ...sale, pricePerTon, revenue: pricePerTon === null ? null : sale.tons * pricePerTon };
  });
  const unresolvedSales = pricedSales.filter((sale) => sale.pricePerTon === null);
  const salesBase = pricedSales.reduce((sum, sale) => sum + (sale.revenue || 0), 0);
  const productMap = Object.fromEntries(REVENUE_PRODUCTS.map((product) => [
    product, { product, tons: 0, revenue: 0 },
  ]));
  const customerMap = {};
  const dailyMap = {};
  for (let day = 1; day <= bounds.days; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    dailyMap[date] = { date, salesRevenue: 0, tippingRevenue: 0, mswTons: 0 };
  }
  for (const sale of pricedSales) {
    if (sale.revenue !== null) {
      productMap[sale.product] = productMap[sale.product] || { product: sale.product, tons: 0, revenue: 0 };
      productMap[sale.product].tons += sale.tons;
      productMap[sale.product].revenue += sale.revenue;
      const customerKey = sale.customer || '(ไม่ระบุลูกค้า)';
      customerMap[customerKey] = customerMap[customerKey] || { customer: customerKey, tons: 0, revenue: 0 };
      customerMap[customerKey].tons += sale.tons;
      customerMap[customerKey].revenue += sale.revenue;
      dailyMap[sale.date].salesRevenue += sale.revenue;
    }
  }

  const monthTippingRows = tippingRows.filter((row) => row.EntryDate >= bounds.start && row.EntryDate <= bounds.end);
  const totalMSW = monthTippingRows.reduce((sum, row) => sum + (Number(row.MSWTons) || 0), 0);
  const setting = applicableRow(tippingSettings, bounds.end, 'EffectiveDate') || DEFAULT_TIPPING_SETTING;
  const rate = Number(setting.RatePerTon) || 0;
  const excludedCentral = Math.min(totalMSW, Number(setting.ExcludedCentralTons) || 0);
  const excludedMin = Math.min(totalMSW, Number(setting.ExcludedMinTons) || 0);
  const excludedMax = Math.min(totalMSW, Number(setting.ExcludedMaxTons) || 0);
  for (const row of monthTippingRows) {
    const msw = Number(row.MSWTons) || 0;
    const allocatedExcluded = totalMSW > 0 ? excludedCentral * msw / totalMSW : 0;
    dailyMap[row.EntryDate].mswTons += msw;
    dailyMap[row.EntryDate].tippingRevenue += Math.max(0, msw - allocatedExcluded) * rate;
  }
  const tippingCentral = Math.max(0, totalMSW - excludedCentral) * rate;
  const tippingLow = Math.max(0, totalMSW - excludedMax) * rate;
  const tippingHigh = Math.max(0, totalMSW - excludedMin) * rate;
  const salesLow = salesBase * 0.9;
  const salesHigh = salesBase * 1.1;
  const companyCentral = salesBase + tippingCentral;
  const salesShare = companyCentral > 0 ? salesBase / companyCentral * 100 : 0;

  return sendJson(res, 200, {
    ok: true,
    month,
    sales: {
      base: salesBase, low: salesLow, high: salesHigh,
      transactionCount: pricedSales.length,
      unresolvedCount: unresolvedSales.length,
      unresolved: unresolvedSales,
      byProduct: Object.values(productMap).sort((a, b) => b.revenue - a.revenue),
      byCustomer: Object.values(customerMap).sort((a, b) => b.revenue - a.revenue),
    },
    tipping: {
      totalMSW, ratePerTon: rate,
      excludedCentralTons: excludedCentral,
      excludedMinTons: excludedMin,
      excludedMaxTons: excludedMax,
      eligibleCentralTons: Math.max(0, totalMSW - excludedCentral),
      central: tippingCentral, low: tippingLow, high: tippingHigh,
    },
    company: {
      central: companyCentral,
      low: salesLow + tippingLow,
      high: salesHigh + tippingHigh,
      salesSharePct: salesShare,
      tippingSharePct: 100 - salesShare,
    },
    daily: Object.values(dailyMap),
  });
}

async function handleRevenue(req, res, parts, query) {
  const section = parts[0];
  const rest = parts.slice(1);
  if (section === 'customers') return handleRevenueCustomers(req, res, rest);
  if (section === 'prices') return handleRevenuePrices(req, res, rest);
  if (section === 'rdf3-sales') return handleRevenueRDF3Sales(req, res, rest);
  if (section === 'tipping-settings') return handleRevenueTippingSettings(req, res, rest);
  if (section === 'tipping-daily') return handleRevenueTippingDaily(req, res, rest, query);
  if (section === 'dashboard' && req.method === 'GET') return handleRevenueDashboard(req, res, query);
  return sendJson(res, 404, { ok: false, error: 'unknown revenue route' });
}

// ---------- Weekly Delivery Plan (Monday 00:00 to next Monday 00:00) ----------

function deliveryActualRows(stockSales, rdf3Sales, weekStart, weekEndExclusive) {
  const rows = stockSales
    .filter((row) => row.SaleDate >= weekStart && row.SaleDate < weekEndExclusive
      && ['RDF2', 'FineFraction'].includes(row.Material))
    .map((row) => ({
      customer: cleanText(row.Customer),
      product: row.Material,
      tons: Number(row.Tons) || 0,
    }));
  for (const row of rdf3Sales) {
    if (row.SaleDate < weekStart || row.SaleDate >= weekEndExclusive) continue;
    rows.push({
      customer: cleanText(row.Customer),
      product: 'RDF3',
      tons: Number(row.Tons) || 0,
    });
  }
  return rows;
}

async function handleDeliveryPlanDashboard(req, res, query) {
  const requested = cleanText(query.weekStart);
  const weekStart = validIsoDate(requested) ? requested : mondayForDate(lib.nowInBangkok().date);
  if (mondayForDate(weekStart) !== weekStart) {
    return sendJson(res, 400, { ok: false, error: 'วันเริ่มสัปดาห์ต้องเป็นวันจันทร์' });
  }
  const weekEndExclusive = lib.addDays(weekStart, 7);
  const weekEnd = lib.addDays(weekStart, 6);
  const [allPlans, stockSales, rdf3Sales, prices] = await Promise.all([
    store.readSheet('WeeklyDeliveryPlans'),
    store.readSheet('Sales'),
    store.readSheet('RevenueRDF3Sales'),
    store.readSheet('RevenuePrices'),
  ]);
  const plans = allPlans.filter((row) => row.WeekStart === weekStart);
  const actualRows = deliveryActualRows(stockSales, rdf3Sales, weekStart, weekEndExclusive);
  const detailRows = plans.map((plan) => {
    const planTons = Number(plan.PlanTons) || 0;
    const actualTons = actualRows
      .filter((row) => row.product === plan.Product && sameText(row.customer, plan.Customer))
      .reduce((sum, row) => sum + row.tons, 0);
    const diffTons = actualTons - planTons;
    const shortfallTons = Math.max(0, planTons - actualTons);
    const priceRow = applicableRevenuePrice(prices, plan.Customer, plan.Product, weekStart);
    const pricePerTon = priceRow ? Number(priceRow.PricePerTon) || 0 : null;
    const opportunityLoss = pricePerTon === null ? null : shortfallTons * pricePerTon;
    return {
      id: plan.ID,
      weekStart,
      customer: cleanText(plan.Customer),
      product: plan.Product,
      planTons,
      actualTons,
      diffTons,
      shortfallTons,
      completionPct: planTons > 0 ? actualTons / planTons * 100 : 0,
      pricePerTon,
      opportunityLoss,
      status: diffTons >= 0 ? 'achieved' : 'behind',
    };
  });

  const customerMap = new Map();
  for (const row of detailRows) {
    if (!customerMap.has(row.customer)) {
      customerMap.set(row.customer, {
        customer: row.customer,
        products: [],
        shortfallTons: 0,
        opportunityLoss: 0,
        missingPriceCount: 0,
      });
    }
    const customer = customerMap.get(row.customer);
    customer.products.push(row);
    customer.shortfallTons += row.shortfallTons;
    if (row.opportunityLoss === null) customer.missingPriceCount += 1;
    else customer.opportunityLoss += row.opportunityLoss;
  }
  const customers = [...customerMap.values()]
    .map((customer) => ({
      ...customer,
      products: customer.products.sort((a, b) => REVENUE_PRODUCTS.indexOf(a.product) - REVENUE_PRODUCTS.indexOf(b.product)),
    }))
    .sort((a, b) => b.opportunityLoss - a.opportunityLoss
      || b.shortfallTons - a.shortfallTons
      || a.customer.localeCompare(b.customer, 'th'));

  const summary = customers.reduce((result, customer) => {
    result.shortfallTons += customer.shortfallTons;
    result.opportunityLoss += customer.opportunityLoss;
    result.missingPriceCount += customer.missingPriceCount;
    return result;
  }, {
    shortfallTons: 0,
    opportunityLoss: 0,
    missingPriceCount: 0,
    customerCount: customers.length,
  });

  return sendJson(res, 200, {
    ok: true,
    weekStart,
    weekEnd,
    weekEndExclusive,
    summary,
    customers,
  });
}

async function handleDeliveryPlans(req, res, parts, query) {
  if (parts[0] === 'dashboard' && req.method === 'GET') {
    return handleDeliveryPlanDashboard(req, res, query);
  }
  if (req.method === 'GET' && parts.length === 0) {
    const weekStart = cleanText(query.weekStart);
    let rows = await store.readSheet('WeeklyDeliveryPlans');
    if (weekStart) rows = rows.filter((row) => row.WeekStart === weekStart);
    rows.sort((a, b) => String(b.WeekStart).localeCompare(String(a.WeekStart))
      || cleanText(a.Customer).localeCompare(cleanText(b.Customer), 'th'));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const weekStart = cleanText(body.weekStart);
    const customer = cleanText(body.customer);
    const product = cleanText(body.product);
    const planTons = Number(body.planTons);
    if (!validIsoDate(weekStart) || mondayForDate(weekStart) !== weekStart) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาเลือกวันจันทร์เริ่มสัปดาห์' });
    }
    if (!customer || !REVENUE_PRODUCTS.includes(product) || !Number.isFinite(planTons) || planTons <= 0) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาระบุลูกค้า สินค้า และ Plan ให้ถูกต้อง' });
    }
    const customers = await store.readSheet('RevenueCustomers');
    if (!customers.some((row) => sameText(row.Name, customer))) {
      return sendJson(res, 400, { ok: false, error: 'ไม่พบลูกค้าในรายการ Setup' });
    }
    const rows = await store.readSheet('WeeklyDeliveryPlans');
    const existing = rows.find((row) => row.WeekStart === weekStart
      && row.Product === product && sameText(row.Customer, customer));
    const data = { WeekStart: weekStart, Customer: customer, Product: product, PlanTons: planTons };
    const row = existing
      ? await store.updateRow('WeeklyDeliveryPlans', existing.ID, data)
      : await store.appendRow('WeeklyDeliveryPlans', data);
    return sendJson(res, 200, { ok: true, row, updated: !!existing });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('WeeklyDeliveryPlans', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'unknown delivery plan route' });
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
      if (resource === 'delivery-plans') return await handleDeliveryPlans(req, res, rest, query);
      if (resource === 'stock') {
        if (rest[0] === 'baseline') return await handleStockBaseline(req, res);
        if (rest.length === 0 && req.method === 'GET') return await handleStock(req, res);
      }
      if (resource === 'revenue') return await handleRevenue(req, res, rest, query);
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
