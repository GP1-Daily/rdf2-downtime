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
      if (open) sessions.push({ start: open, stop: null, incomplete: true });
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
  if (open) sessions.push({ start: open, stop: null, incomplete: true });
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
  const relevantLineRows = lineRows.filter((r) => [lib.addDays(date, -1), date, lib.addDays(date, 1)].includes(r.EntryDate));
  const sessions = computeLineSessions(relevantLineRows);
  const lineSegments = [];
  const incompleteSessions = [];
  for (const sess of sessions) {
    if (sess.incomplete) {
      if (sess.start && sess.start.EntryDate === date) incompleteSessions.push({ type: 'no-stop', entryDate: sess.start.EntryDate, time: sess.start.Time, note: sess.start.Note });
      if (sess.stop && sess.stop.EntryDate === date) incompleteSessions.push({ type: 'no-start', entryDate: sess.stop.EntryDate, time: sess.stop.Time, note: sess.stop.Note });
      continue;
    }
    const segs = lib.splitEntry(sess.start.EntryDate, sess.start.Time, sess.stop.Time);
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
