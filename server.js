const http = require('http');
const fs = require('fs');
const path = require('path');

// Uses Postgres (e.g. free Supabase) when DATABASE_URL is set - needed for
// cloud deploys with no persistent local disk. Falls back to the local
// Excel file otherwise. Both modules expose the same function signatures.
const store = process.env.DATABASE_URL ? require('./pg-store') : require('./store');
const lib = require('./lib');
const { createAuth } = require('./auth');
const { requiredRole, hasRole } = require('./authorization');
const { runWithRequestContext } = require('./request-context');
const {
  createRateLimiter, getClientIp, createRequestId, applySecurityHeaders, constantTimeTokenEqual,
} = require('./security');

const PORT = Number(process.env.PORT) || 5600;
const HOST = process.env.HOST || (process.env.DATABASE_URL ? '0.0.0.0' : '127.0.0.1');
const DIR = __dirname;
const HTML_PATH = path.join(DIR, 'index.html');
const auth = createAuth(store);
const rateLimiter = createRateLimiter();
const BODY_LIMIT_BYTES = Math.min(
  20 * 1024 * 1024,
  Math.max(64 * 1024, Number(process.env.API_BODY_LIMIT_BYTES) || 5 * 1024 * 1024),
);
const PUBLIC_FILES = new Set([
  'index.html', 'login.html', 'accept-invite.html', 'security.html',
  'home.css', 'home.js', 'kpi.css', 'kpi.js', 'html2canvas.min.js',
  'operations.css',
  'login.css', 'login.js', 'invite.js', 'security.css', 'security-admin.js',
  'security-ui.css', 'security-ui.js',
  'assets/gp1-connect-logo.png', 'assets/gp1-connect-mark.png', 'assets/gp1-connect-favicon.png',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > BODY_LIMIT_BYTES) {
        rejected = true;
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
  });
  res.end(JSON.stringify(obj));
}

function validClockTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}

function textWithin(value, maxLength) {
  return String(value || '').length <= maxLength;
}

function sendStatic(req, res, filePath, query) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const cacheControl = ext === '.html'
      ? 'no-cache, must-revalidate'
      : query.v
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, must-revalidate';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (ext !== '.html') headers['Content-Length'] = stat.size;
    if (ext !== '.html' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    fs.readFile(filePath, (readError, data) => {
      if (readError) { res.writeHead(404); res.end('Not found'); return; }
      if (ext === '.html') {
        const nonce = res.__cspNonce;
        data = Buffer.from(data.toString('utf8')
          .replace(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
          .replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`));
        headers['Content-Length'] = data.length;
        delete headers.ETag;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
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
    if (!validIsoDate(body.entryDate) || !validClockTime(body.startTime) || !validClockTime(body.endTime)) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ entryDate, startTime, endTime' });
    }
    if (!textWithin(body.reason, 200) || !textWithin(body.note, 1000)) {
      return sendJson(res, 400, { ok: false, error: 'รายละเอียดรายการยาวเกินกำหนด' });
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
    if ((body.entryDate !== undefined && !validIsoDate(body.entryDate))
      || (body.startTime !== undefined && !validClockTime(body.startTime))
      || (body.endTime !== undefined && !validClockTime(body.endTime))
      || !textWithin(body.reason, 200) || !textWithin(body.note, 1000)) {
      return sendJson(res, 400, { ok: false, error: 'ข้อมูลรายการหยุดเครื่องไม่ถูกต้อง' });
    }
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
    if (!validIsoDate(body.entryDate) || !body.eventType || !validClockTime(body.time)) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ entryDate, eventType, time' });
    }
    if (body.eventType !== 'Start' && body.eventType !== 'Stop') {
      return sendJson(res, 400, { ok: false, error: 'eventType ต้องเป็น Start หรือ Stop' });
    }
    if (body.eventType === 'Stop' && body.stopType && !['break', 'end'].includes(body.stopType)) {
      return sendJson(res, 400, { ok: false, error: 'ประเภท Stop Line ไม่ถูกต้อง' });
    }
    if (!textWithin(body.note, 1000)) {
      return sendJson(res, 400, { ok: false, error: 'หมายเหตุยาวเกินกำหนด' });
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
    if ((body.entryDate !== undefined && !validIsoDate(body.entryDate))
      || (body.time !== undefined && !validClockTime(body.time))
      || (body.eventType !== undefined && !['Start', 'Stop'].includes(body.eventType))
      || (body.stopType !== undefined && body.stopType && !['break', 'end'].includes(body.stopType))
      || !textWithin(body.note, 1000)) {
      return sendJson(res, 400, { ok: false, error: 'ข้อมูล Start-Stop Line ไม่ถูกต้อง' });
    }
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

function normalizeGrabLocalDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match || !validIsoDate(match[1])) return '';
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return '';
  return `${match[1]} ${match[2]}:${match[3]}:${match[4]}`;
}

function deviceBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  return match ? match[1].trim() : '';
}

async function handleGrabDeviceSync(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  const ip = getClientIp(req);
  if (!rateLimitRequest(req, res, `grab-device-auth:${ip}`, 30, 60 * 1000)) return;
  const expectedToken = String(process.env.GRAB_SYNC_TOKEN || '');
  if (!expectedToken) return sendJson(res, 503, { ok: false, error: 'Grab sync is not configured' });
  if (!constantTimeTokenEqual(deviceBearerToken(req), expectedToken)) {
    return sendJson(res, 401, { ok: false, error: 'Invalid device credentials' });
  }
  if (!validateJsonContentType(req, res)) return;

  const body = await readBody(req);
  const configuredDeviceId = String(process.env.GRAB_SYNC_DEVICE_ID || 'grab-pi-1');
  const deviceId = String(body.deviceId || configuredDeviceId).trim();
  if (deviceId !== configuredDeviceId || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid device ID' });
  }
  if (!Array.isArray(body.rows) || body.rows.length > 2500) {
    return sendJson(res, 400, { ok: false, error: 'rows must contain no more than 2,500 records' });
  }

  const seenIds = new Set();
  const rows = [];
  for (const input of body.rows) {
    const sourceId = Number(input?.id);
    const dateTime = normalizeGrabLocalDateTime(input?.createDate);
    const weight = Number(input?.weight);
    const amp = input?.amp === null || input?.amp === undefined || input?.amp === '' ? null : Number(input.amp);
    const sourceStatus = input?.status === null || input?.status === undefined || input?.status === ''
      ? null
      : Number(input.status);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || seenIds.has(sourceId)
      || !dateTime || !Number.isFinite(weight) || weight < 0 || weight > 1000
      || (amp !== null && (!Number.isFinite(amp) || amp < 0 || amp > 100000))
      || (sourceStatus !== null && !Number.isSafeInteger(sourceStatus))) {
      return sendJson(res, 400, { ok: false, error: 'Invalid Grab record' });
    }
    seenIds.add(sourceId);
    rows.push({
      ReportDate: dateTime.slice(0, 10),
      DateTime: dateTime,
      Weight: weight,
      SourceID: sourceId,
      Amp: amp,
      SourceStatus: sourceStatus,
    });
  }

  const mode = String(body.mode || 'upsert');
  if (!['upsert', 'snapshot'].includes(mode)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid sync mode' });
  }
  let snapshotStart = '';
  let snapshotEnd = '';
  if (mode === 'snapshot') {
    snapshotStart = normalizeGrabLocalDateTime(body.windowStart);
    snapshotEnd = normalizeGrabLocalDateTime(body.windowEnd);
    if (!snapshotStart || !snapshotEnd || snapshotEnd <= snapshotStart
      || rows.some((row) => row.DateTime < snapshotStart || row.DateTime >= snapshotEnd)) {
      return sendJson(res, 400, { ok: false, error: 'Invalid or incomplete snapshot window' });
    }
  }

  const context = {
    requestId: req.gp1RequestId,
    ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    user: { id: `device:${deviceId}`, email: `${deviceId}@device.local`, role: 'operator' },
  };
  const result = await runWithRequestContext(context, () => store.syncGrabRows(deviceId, rows, {
    snapshotStart,
    snapshotEnd,
  }));
  return sendJson(res, 200, {
    ok: true,
    deviceId,
    processed: rows.length,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    maxSourceId: rows.reduce((max, row) => Math.max(max, row.SourceID), 0),
    serverTime: new Date().toISOString(),
  });
}

// ---------- Report ----------

function extractTimeOfDay(dateTimeStr) {
  const m = String(dateTimeStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return '00:00';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function grabDateTimePoint(row) {
  const date = String(row.ReportDate || '');
  const match = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(row.DateTime || ''));
  if (!validIsoDate(date) || !match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    row,
    date,
    time,
    key: `${date} ${time}:${String(second).padStart(2, '0')}`,
  };
}

function mergeMinuteRanges(ranges) {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, Number(start)), Math.min(1440, Number(end))])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] > previous[1]) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

function rangeMinutes(ranges) {
  return ranges.reduce((total, [start, end]) => total + end - start, 0);
}

function overlapWithRanges(start, end, ranges) {
  let total = 0;
  for (const [rangeStart, rangeEnd] of ranges) {
    const low = Math.max(start, rangeStart);
    const high = Math.min(end, rangeEnd);
    if (high > low) total += high - low;
  }
  return total;
}

function buildProductionSegments(reportDate, sessionRanges, grabRows) {
  const points = grabRows.map(grabDateTimePoint).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));
  const segments = [];
  let anchoredSessions = 0;
  let estimatedSessions = 0;

  for (const session of sessionRanges) {
    const sessionPoints = points.filter((point) => point.key >= session.startKey && point.key <= session.endKey);
    const anchored = sessionPoints.length >= 2;
    const first = anchored ? sessionPoints[0] : null;
    const last = anchored ? sessionPoints[sessionPoints.length - 1] : null;
    const startDate = first ? first.date : session.startDate;
    const startTime = first ? first.time : session.startTime;
    const endDate = last ? last.date : session.endDate;
    const endTime = last ? last.time : session.endTime;
    if (`${endDate} ${endTime}` <= `${startDate} ${startTime}`) continue;

    if (anchored) anchoredSessions += 1;
    else estimatedSessions += 1;
    for (const part of lib.splitRange(startDate, startTime, endDate, endTime)) {
      if (part.date !== reportDate) continue;
      segments.push({
        ...part,
        source: anchored ? 'grab' : 'manual',
        estimated: !anchored,
        grabCount: sessionPoints.length,
        firstGrab: first?.key || null,
        lastGrab: last?.key || null,
        sessionStart: `${session.startDate} ${session.startTime}`,
        sessionStop: session.ongoing ? null : `${session.endDate} ${session.endTime}`,
        stopType: session.stopType,
        ongoing: session.ongoing,
      });
    }
  }

  // If Start/Stop was missed entirely, two or more Pi records still provide a
  // defensible production span for the day. It is kept visibly inferred so
  // the operator can correct the missing line events later.
  if (!segments.length) {
    const dailyPoints = points.filter((point) => point.date === reportDate);
    if (dailyPoints.length >= 2) {
      const first = dailyPoints[0];
      const last = dailyPoints[dailyPoints.length - 1];
      for (const part of lib.splitRange(reportDate, first.time, reportDate, last.time)) {
        segments.push({
          ...part,
          source: 'grab-inferred',
          estimated: true,
          grabCount: dailyPoints.length,
          firstGrab: first.key,
          lastGrab: last.key,
          sessionStart: null,
          sessionStop: null,
          stopType: '',
          ongoing: false,
        });
      }
      anchoredSessions += 1;
      estimatedSessions += 1;
    }
  }

  segments.sort((a, b) => a.startTime.localeCompare(b.startTime));
  const sources = new Set(segments.map((segment) => segment.source));
  const runtimeSource = !segments.length
    ? 'none'
    : sources.size === 1 && sources.has('manual')
      ? 'manual'
      : sources.has('manual')
        ? 'mixed'
        : sources.has('grab-inferred')
          ? 'grab-inferred'
          : 'grab';
  return { segments, anchoredSessions, estimatedSessions, runtimeSource };
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
  const sessionRanges = [];
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
        const range = {
          startDate: sess.start.EntryDate,
          startTime: sess.start.Time,
          endDate: nowBkk.date,
          endTime: nowBkk.time,
          startKey: `${sess.start.EntryDate} ${sess.start.Time}:00`,
          endKey: `${nowBkk.date} ${nowBkk.time}:59`,
          stopType: '',
          ongoing: true,
        };
        if (range.endKey >= range.startKey) sessionRanges.push(range);
        const segs = lib.splitRange(range.startDate, range.startTime, range.endDate, range.endTime);
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
    const range = {
      startDate: sess.start.EntryDate,
      startTime: sess.start.Time,
      endDate: sess.stop.EntryDate,
      endTime: sess.stop.Time,
      startKey: `${sess.start.EntryDate} ${sess.start.Time}:00`,
      endKey: `${sess.stop.EntryDate} ${sess.stop.Time}:59`,
      stopType: sess.stop.StopType || '',
      ongoing: false,
    };
    if (range.endKey >= range.startKey) sessionRanges.push(range);
    const segs = lib.splitRange(range.startDate, range.startTime, range.endDate, range.endTime);
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

  // Pi timestamps anchor the productive window. Gaps between grabs remain
  // productive time; only an operator-recorded downtime interval subtracts
  // from it. Start/Stop remains the session boundary and the fallback when a
  // session has fewer than two valid Grab records.
  const production = buildProductionSegments(date, sessionRanges, grabRows);
  const productionSegments = production.segments;
  const productionRanges = mergeMinuteRanges(productionSegments.map((segment) => [
    lib.timeToMinutes(segment.startTime), lib.timeToMinutes(segment.endTime),
  ]));
  const productionByPeriod = { 'เช้า': 0, 'บ่าย': 0, 'ดึก': 0 };
  for (const period of Object.keys(productionByPeriod)) {
    const ranges = mergeMinuteRanges(productionSegments
      .filter((segment) => segment.period === period)
      .map((segment) => [lib.timeToMinutes(segment.startTime), lib.timeToMinutes(segment.endTime)]));
    productionByPeriod[period] = rangeMinutes(ranges);
  }
  const totalProductionMin = Object.values(productionByPeriod).reduce((sum, minutes) => sum + minutes, 0);

  const relevantDowntime = downtimeRows.filter((r) => r.EntryDate === date || r.EntryDate === prevDate);
  const downtimeSegments = [];
  for (const r of relevantDowntime) {
    const segs = lib.splitEntry(r.EntryDate, r.StartTime, r.EndTime);
    for (const s of segs) {
      if (s.date !== date) continue;
      const startMin = lib.timeToMinutes(s.startTime), endMin = lib.timeToMinutes(s.endTime);
      const insideLineMinutes = overlapWithRanges(startMin, endMin, productionRanges);
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
  const downtimeByPeriod = { 'เช้า': 0, 'บ่าย': 0, 'ดึก': 0 };
  for (const period of Object.keys(downtimeByPeriod)) {
    const intersections = [];
    for (const segment of downtimeSegments.filter((item) => item.period === period)) {
      const start = lib.timeToMinutes(segment.startTime);
      const end = lib.timeToMinutes(segment.endTime);
      for (const [activeStart, activeEnd] of productionRanges) {
        const low = Math.max(start, activeStart);
        const high = Math.min(end, activeEnd);
        if (high > low) intersections.push([low, high]);
      }
    }
    downtimeByPeriod[period] = rangeMinutes(mergeMinuteRanges(intersections));
  }
  const totalDowntimeMin = Object.values(downtimeByPeriod).reduce((sum, minutes) => sum + minutes, 0);

  const netRunMin = Math.max(0, totalProductionMin - totalDowntimeMin);
  const availabilityPct = totalProductionMin > 0 ? (netRunMin / totalProductionMin) * 100 : null;

  // ---- Grab crane ----
  const grabForDate = grabRows
    .filter((r) => r.ReportDate === date)
    .sort((a, b) => String(a.DateTime).localeCompare(String(b.DateTime)));
  const totalGrabs = grabForDate.length;
  const totalWeight = grabForDate.reduce((s, r) => s + (Number(r.Weight) || 0), 0);
  const avgWeight = totalGrabs > 0 ? totalWeight / totalGrabs : null;
  const firstGrabTime = totalGrabs ? extractTimeOfDay(grabForDate[0].DateTime) : null;
  const lastGrabTime = totalGrabs ? extractTimeOfDay(grabForDate[totalGrabs - 1].DateTime) : null;
  const lastSyncedAt = grabForDate.reduce((latest, row) => {
    const value = String(row.SyncedAt || '');
    return value > latest ? value : latest;
  }, '') || null;
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
      productionSegments,
      productionMinutes: totalProductionMin,
      productionByPeriod,
      runtimeSource: production.runtimeSource,
      grabAnchoredSessions: production.anchoredSessions,
      estimatedSessions: production.estimatedSessions,
      incomplete: incompleteSessions,
      netRunMinutes: netRunMin,
      availabilityPct,
    },
    grab: {
      totalGrabs,
      avgWeight,
      totalWeight,
      firstGrabTime,
      lastGrabTime,
      lastSyncedAt,
      automaticGrabs: grabForDate.filter((row) => row.SourceSystem).length,
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

function splitLegacyRDF2Yield(totalPct) {
  const rdf2LG = Math.round((totalPct * 0.30 + Number.EPSILON) * 100) / 100;
  const rdf2 = Math.round((totalPct - rdf2LG + Number.EPSILON) * 100) / 100;
  return { rdf2, rdf2LG };
}

function computeProduction(incomingWaste, yieldSetting) {
  if (!yieldSetting || incomingWaste <= 0) return null;
  const rdf2Pct = Number(yieldSetting.RDF2Pct) || 0;
  const rdf2LGPct = Number(yieldSetting.RDF2LGPct) || 0;
  const fineFractionPct = Number(yieldSetting.FineFractionPct) || 0;
  const heavyFractionPct = Number(yieldSetting.HeavyFractionPct) || 0;
  const metalPct = Number(yieldSetting.MetalPct) || 0;
  const waterPct = Math.max(0, 100 - rdf2Pct - rdf2LGPct - fineFractionPct - heavyFractionPct - metalPct);
  return {
    incomingWaste,
    yieldPct: {
      rdf2: rdf2Pct,
      rdf2LG: rdf2LGPct,
      fineFraction: fineFractionPct,
      heavyFraction: heavyFractionPct,
      metal: metalPct,
      water: waterPct,
    },
    tons: {
      rdf2: incomingWaste * rdf2Pct / 100,
      rdf2LG: incomingWaste * rdf2LGPct / 100,
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
    const { effectiveDate, rdf2Pct, rdf2LGPct, fineFractionPct, heavyFractionPct, metalPct } = body;
    if (!effectiveDate || [rdf2Pct, fineFractionPct, heavyFractionPct, metalPct].some((v) => v === undefined || v === null || v === '')) {
      return sendJson(res, 400, { ok: false, error: 'ต้องระบุ effectiveDate และเปอร์เซ็นต์ทั้ง 4 ค่า' });
    }
    const hasExplicitRDF2LG = rdf2LGPct !== undefined && rdf2LGPct !== null && rdf2LGPct !== '';
    const legacySplit = splitLegacyRDF2Yield(Number(rdf2Pct));
    const normalizedRDF2Pct = hasExplicitRDF2LG ? Number(rdf2Pct) : legacySplit.rdf2;
    const normalizedRDF2LGPct = hasExplicitRDF2LG ? Number(rdf2LGPct) : legacySplit.rdf2LG;
    const values = [normalizedRDF2Pct, normalizedRDF2LGPct, Number(fineFractionPct), Number(heavyFractionPct), Number(metalPct)];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      return sendJson(res, 400, { ok: false, error: 'เปอร์เซ็นต์ Yield ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป' });
    }
    const sum = values.reduce((total, value) => total + value, 0);
    if (sum > 100) return sendJson(res, 400, { ok: false, error: 'ผลรวมเปอร์เซ็นต์ต้องไม่เกิน 100' });
    const record = await store.appendRow('YieldSettings', {
      EffectiveDate: effectiveDate,
      RDF2Pct: normalizedRDF2Pct,
      RDF2LGPct: normalizedRDF2LGPct,
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

const SALES_MATERIALS = ['RDF2', 'RDF2LG', 'FineFraction', 'Metal'];

function isTPICustomer(value) {
  return /^t\.?p\.?i(?:\s|$)/i.test(String(value || '').trim());
}

function normalizeCustomerProduct(product, customer) {
  return product === 'RDF2' && isTPICustomer(customer) ? 'RDF2LG' : product;
}

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
    const normalizedMaterial = normalizeCustomerProduct(material, customer);
    if (!SALES_MATERIALS.includes(normalizedMaterial)) {
      return sendJson(res, 400, { ok: false, error: 'material ต้องเป็น RDF2, RDF2 LG, FineFraction หรือ Metal' });
    }
    const record = await store.appendRow('Sales', {
      SaleDate: saleDate, Material: normalizedMaterial, Customer: customer || '', Tons: Number(tons), Note: note || '',
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
    totals.rdf2 += prod.tons.rdf2 + prod.tons.rdf2LG;
    totals.fineFraction += prod.tons.fineFraction;
    totals.metal += prod.tons.metal;
    dailyProduction.push({ date, incomingWaste: weight, tons: prod.tons });
  }
  dailyProduction.sort((a, b) => (a.date < b.date ? -1 : 1));

  const salesTotals = { rdf2: 0, fineFraction: 0, metal: 0 };
  const relevantSales = salesRows.filter((r) => r.SaleDate >= baselineDate);
  for (const r of relevantSales) {
    const key = ['RDF2', 'RDF2LG'].includes(r.Material) ? 'rdf2' : r.Material === 'FineFraction' ? 'fineFraction' : 'metal';
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

const REVENUE_PRODUCTS = ['RDF2', 'RDF2LG', 'RDF3', 'FineFraction'];
const DIRECT_SALES_PRODUCTS = ['RDF2', 'RDF2LG', 'FineFraction'];
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
    const product = normalizeCustomerProduct(cleanText(body.product), customer);
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
    .filter((row) => row.SaleDate >= bounds.start && row.SaleDate <= bounds.end && DIRECT_SALES_PRODUCTS.includes(row.Material))
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

// ---------- Monthly KPI (21st through the following 20th) ----------

const DEFAULT_KPI_TARGET = {
  EffectiveDate: '2000-01-01',
  RDF2Target: 1000,
  RDF2LGTarget: 0,
  RDF3Target: 800,
  FineFractionTarget: 800,
  MSWTarget: 8000,
  ComplaintLimit: 2,
};

const KPI_METRICS = [
  { key: 'rdf2', label: 'RDF2 Delivery', targetKey: 'RDF2Target', unit: 'ตัน' },
  { key: 'rdf2LG', label: 'RDF2 LG Delivery', targetKey: 'RDF2LGTarget', unit: 'ตัน' },
  { key: 'rdf3', label: 'RDF3 Delivery', targetKey: 'RDF3Target', unit: 'ตัน' },
  { key: 'fineFraction', label: 'Fine Fraction Delivery', targetKey: 'FineFractionTarget', unit: 'ตัน' },
  { key: 'msw', label: 'MSW to Production', targetKey: 'MSWTarget', unit: 'ตัน' },
  { key: 'complaints', label: 'Customer Complaints', targetKey: 'ComplaintLimit', unit: 'เรื่อง', limit: true },
];

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function kpiPeriodForDate(date) {
  const month = date.slice(0, 7);
  return Number(date.slice(8, 10)) >= 21 ? month : shiftMonth(month, -1);
}

function kpiPeriodBounds(period) {
  const nextMonth = shiftMonth(period, 1);
  return { period, start: `${period}-21`, end: `${nextMonth}-20` };
}

function addToDateMap(map, date, amount) {
  map.set(date, (map.get(date) || 0) + (Number(amount) || 0));
}

function kpiPeriodSummary(period, data) {
  const bounds = kpiPeriodBounds(period);
  const dates = Array.from(
    { length: lib.daysBetween(bounds.start, bounds.end) + 1 },
    (_, index) => lib.addDays(bounds.start, index),
  );
  const automatic = {
    rdf2: new Map(), rdf2LG: new Map(), rdf3: new Map(), fineFraction: new Map(), msw: new Map(),
  };
  const automaticDates = {
    rdf2: new Set(), rdf2LG: new Set(), rdf3: new Set(), fineFraction: new Set(), msw: new Set(),
  };

  for (const row of data.stockSales) {
    if (row.SaleDate < bounds.start || row.SaleDate > bounds.end) continue;
    if (row.Material === 'RDF2') {
      addToDateMap(automatic.rdf2, row.SaleDate, row.Tons);
      automaticDates.rdf2.add(row.SaleDate);
      automaticDates.rdf2LG.add(row.SaleDate);
    } else if (row.Material === 'RDF2LG') {
      addToDateMap(automatic.rdf2LG, row.SaleDate, row.Tons);
      automaticDates.rdf2.add(row.SaleDate);
      automaticDates.rdf2LG.add(row.SaleDate);
    } else if (row.Material === 'FineFraction') {
      addToDateMap(automatic.fineFraction, row.SaleDate, row.Tons);
      automaticDates.fineFraction.add(row.SaleDate);
    }
  }
  for (const row of data.rdf3Sales) {
    if (row.SaleDate < bounds.start || row.SaleDate > bounds.end) continue;
    addToDateMap(automatic.rdf3, row.SaleDate, row.Tons);
    automaticDates.rdf3.add(row.SaleDate);
  }
  for (const row of data.grabRows) {
    if (row.ReportDate < bounds.start || row.ReportDate > bounds.end) continue;
    addToDateMap(automatic.msw, row.ReportDate, row.Weight);
    automaticDates.msw.add(row.ReportDate);
  }

  const historyByDate = new Map(data.historyRows.map((row) => [row.EntryDate, row]));
  const actual = { rdf2: 0, rdf2LG: 0, rdf3: 0, fineFraction: 0, msw: 0, complaints: 0 };
  const sourceDates = { live: new Set(), history: new Set() };
  const daily = dates.map((date) => {
    const historical = historyByDate.get(date);
    const values = {};
    const sources = {};
    for (const metric of ['rdf2', 'rdf2LG', 'rdf3', 'fineFraction', 'msw']) {
      const historyKey = {
        rdf2: 'RDF2Tons', rdf2LG: 'RDF2LGTons', rdf3: 'RDF3Tons',
        fineFraction: 'FineFractionTons', msw: 'MSWTons',
      }[metric];
      if (automaticDates[metric].has(date)) {
        values[metric] = automatic[metric].get(date) || 0;
        sources[metric] = 'live';
        sourceDates.live.add(date);
      } else if (historical) {
        values[metric] = Number(historical[historyKey]) || 0;
        sources[metric] = 'history';
        sourceDates.history.add(date);
      } else {
        values[metric] = 0;
        sources[metric] = 'none';
      }
      actual[metric] += values[metric];
    }
    return { date, ...values, sources };
  });

  const complaints = data.complaintRows
    .filter((row) => row.EntryDate >= bounds.start && row.EntryDate <= bounds.end)
    .sort((a, b) => String(b.EntryDate).localeCompare(String(a.EntryDate)));
  actual.complaints = complaints.length;
  const targetSetting = applicableRow(data.targetRows, bounds.end, 'EffectiveDate') || DEFAULT_KPI_TARGET;
  const metrics = KPI_METRICS.map((metric) => {
    const target = Number(targetSetting[metric.targetKey]) || 0;
    const value = actual[metric.key];
    const tracked = metric.limit || target > 0;
    const achieved = tracked ? (metric.limit ? value < target : value >= target) : null;
    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      actual: value,
      target,
      limit: !!metric.limit,
      tracked,
      achieved,
      completionPct: metric.limit
        ? (value < target ? 100 : Math.max(0, target / Math.max(value, 1) * 100))
        : (target > 0 ? value / target * 100 : 0),
    };
  });

  return {
    period,
    startDate: bounds.start,
    endDate: bounds.end,
    actual,
    metrics,
    passedCount: metrics.filter((metric) => metric.achieved === true).length,
    totalCount: metrics.filter((metric) => metric.tracked).length,
    complaints,
    target: {
      id: targetSetting.ID || null,
      effectiveDate: targetSetting.EffectiveDate,
      rdf2: Number(targetSetting.RDF2Target) || 0,
      rdf2LG: Number(targetSetting.RDF2LGTarget) || 0,
      rdf3: Number(targetSetting.RDF3Target) || 0,
      fineFraction: Number(targetSetting.FineFractionTarget) || 0,
      msw: Number(targetSetting.MSWTarget) || 0,
      complaints: Number(targetSetting.ComplaintLimit) || 0,
    },
    source: { liveDays: sourceDates.live.size, historyDays: sourceDates.history.size },
    daily,
  };
}

async function loadKPIData() {
  const [stockSales, rdf3Sales, grabRows, historyRows, complaintRows, targetRows] = await Promise.all([
    store.readSheet('Sales'),
    store.readSheet('RevenueRDF3Sales'),
    store.readSheet('GrabCrane'),
    store.readSheet('KPIDailyHistory'),
    store.readSheet('KPIComplaints'),
    store.readSheet('KPITargetSettings'),
  ]);
  return { stockSales, rdf3Sales, grabRows, historyRows, complaintRows, targetRows };
}

async function handleKPIDashboard(req, res, query) {
  const fallbackPeriod = kpiPeriodForDate(lib.nowInBangkok().date);
  const period = validMonth(query.period) ? query.period : fallbackPeriod;
  const data = await loadKPIData();
  const selected = kpiPeriodSummary(period, data);
  const history = Array.from({ length: 6 }, (_, index) => {
    const summary = kpiPeriodSummary(shiftMonth(period, index - 5), data);
    return {
      period: summary.period,
      startDate: summary.startDate,
      endDate: summary.endDate,
      passedCount: summary.passedCount,
      totalCount: summary.totalCount,
      metrics: summary.metrics,
    };
  });
  return sendJson(res, 200, { ok: true, selected, history });
}

async function handleKPIComplaints(req, res, parts, query) {
  if (req.method === 'GET' && parts.length === 0) {
    let rows = await store.readSheet('KPIComplaints');
    if (validMonth(query.period)) {
      const bounds = kpiPeriodBounds(query.period);
      rows = rows.filter((row) => row.EntryDate >= bounds.start && row.EntryDate <= bounds.end);
    }
    rows.sort((a, b) => String(b.EntryDate).localeCompare(String(a.EntryDate)));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const entryDate = cleanText(body.entryDate);
    const detail = cleanText(body.detail);
    if (!validIsoDate(entryDate) || !detail) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาระบุวันที่และรายละเอียดข้อร้องเรียน' });
    }
    const row = await store.appendRow('KPIComplaints', {
      EntryDate: entryDate,
      Customer: cleanText(body.customer),
      Detail: detail,
    });
    return sendJson(res, 200, { ok: true, row });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('KPIComplaints', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'unknown KPI complaint route' });
}

async function handleKPITargets(req, res, parts) {
  if (req.method === 'GET' && parts.length === 0) {
    const rows = await store.readSheet('KPITargetSettings');
    rows.sort((a, b) => String(b.EffectiveDate).localeCompare(String(a.EffectiveDate)));
    return sendJson(res, 200, { ok: true, rows });
  }
  if (req.method === 'POST' && parts.length === 0) {
    const body = await readBody(req);
    const data = {
      EffectiveDate: cleanText(body.effectiveDate),
      RDF2Target: Number(body.rdf2Target),
      RDF2LGTarget: Number(body.rdf2LGTarget),
      RDF3Target: Number(body.rdf3Target),
      FineFractionTarget: Number(body.fineFractionTarget),
      MSWTarget: Number(body.mswTarget),
      ComplaintLimit: Number(body.complaintLimit),
    };
    if (!validIsoDate(data.EffectiveDate)
      || ![data.RDF2Target, data.RDF2LGTarget, data.RDF3Target, data.FineFractionTarget, data.MSWTarget]
        .every((value) => Number.isFinite(value) && value >= 0)
      || !Number.isFinite(data.ComplaintLimit) || data.ComplaintLimit <= 0) {
      return sendJson(res, 400, { ok: false, error: 'กรุณากรอกเป้าหมาย KPI ให้ถูกต้อง' });
    }
    const rows = await store.readSheet('KPITargetSettings');
    const existing = rows.find((row) => row.EffectiveDate === data.EffectiveDate);
    const row = existing
      ? await store.updateRow('KPITargetSettings', existing.ID, data)
      : await store.appendRow('KPITargetSettings', data);
    return sendJson(res, 200, { ok: true, row, updated: !!existing });
  }
  if (req.method === 'DELETE' && parts.length === 1) {
    const deleted = await store.deleteRow('KPITargetSettings', parts[0]);
    return sendJson(res, 200, { ok: deleted });
  }
  return sendJson(res, 404, { ok: false, error: 'unknown KPI target route' });
}

async function handleKPI(req, res, parts, query) {
  const section = parts[0];
  const rest = parts.slice(1);
  if (section === 'dashboard' && req.method === 'GET') return handleKPIDashboard(req, res, query);
  if (section === 'complaints') return handleKPIComplaints(req, res, rest, query);
  if (section === 'targets') return handleKPITargets(req, res, rest);
  return sendJson(res, 404, { ok: false, error: 'unknown KPI route' });
}

// ---------- Weekly Production & Sales Report ----------

const WEEKLY_PRODUCTION_PRODUCTS = [
  { product: 'RDF2', tonsKey: 'rdf2' },
  { product: 'RDF2LG', tonsKey: 'rdf2LG' },
  { product: 'FineFraction', tonsKey: 'fineFraction' },
  { product: 'HeavyFraction', tonsKey: 'heavyFraction' },
  { product: 'Water', tonsKey: 'water' },
];

async function handleWeeklyReport(req, res, query) {
  const requested = cleanText(query.weekStart);
  const weekStart = validIsoDate(requested) ? requested : mondayForDate(lib.nowInBangkok().date);
  if (mondayForDate(weekStart) !== weekStart) {
    return sendJson(res, 400, { ok: false, error: 'วันเริ่มสัปดาห์ต้องเป็นวันจันทร์' });
  }

  const weekEndExclusive = lib.addDays(weekStart, 7);
  const weekEnd = lib.addDays(weekStart, 6);
  const dates = Array.from({ length: 7 }, (_, index) => lib.addDays(weekStart, index));
  const [grabRows, yieldRows, stockSales, rdf3Sales, kpiTargetRows] = await Promise.all([
    store.readSheet('GrabCrane'),
    store.readSheet('YieldSettings'),
    store.readSheet('Sales'),
    store.readSheet('RevenueRDF3Sales'),
    store.readSheet('KPITargetSettings'),
  ]);

  const productionTons = Object.fromEntries(WEEKLY_PRODUCTION_PRODUCTS.map((item) => [item.tonsKey, 0]));
  let incomingWaste = 0;
  let calculatedIncomingWaste = 0;
  let totalGrabs = 0;
  const missingYieldDates = [];
  const daily = dates.map((date) => {
    const rows = grabRows.filter((row) => row.ReportDate === date);
    const dayIncomingWaste = rows.reduce((sum, row) => sum + (Number(row.Weight) || 0), 0);
    const yieldSetting = getApplicableYield(yieldRows, date);
    const production = computeProduction(dayIncomingWaste, yieldSetting);
    incomingWaste += dayIncomingWaste;
    totalGrabs += rows.length;
    if (dayIncomingWaste > 0 && !yieldSetting) missingYieldDates.push(date);
    if (production) {
      calculatedIncomingWaste += dayIncomingWaste;
      for (const item of WEEKLY_PRODUCTION_PRODUCTS) {
        productionTons[item.tonsKey] += production.tons[item.tonsKey];
      }
    }
    return {
      date,
      grabCount: rows.length,
      incomingWaste: dayIncomingWaste,
      hasYieldSetting: !!yieldSetting,
    };
  });

  const productionProducts = WEEKLY_PRODUCTION_PRODUCTS.map((item) => ({
    product: item.product,
    tons: productionTons[item.tonsKey],
    effectiveYieldPct: calculatedIncomingWaste > 0
      ? productionTons[item.tonsKey] / calculatedIncomingWaste * 100
      : 0,
  }));

  const kpiTargetSetting = applicableRow(kpiTargetRows, weekEnd, 'EffectiveDate') || DEFAULT_KPI_TARGET;
  const monthlyMSWTargetTons = Math.max(0, Number(kpiTargetSetting.MSWTarget) || 0);
  const weeklyMSWTargetTons = monthlyMSWTargetTons / 4;
  const mswDiffTons = incomingWaste - weeklyMSWTargetTons;
  const mswAttainmentPct = weeklyMSWTargetTons > 0
    ? incomingWaste / weeklyMSWTargetTons * 100
    : null;

  const salesRows = stockSales
    .filter((row) => row.SaleDate >= weekStart && row.SaleDate < weekEndExclusive
      && DIRECT_SALES_PRODUCTS.includes(row.Material))
    .map((row) => ({
      date: row.SaleDate,
      product: row.Material,
      customer: cleanText(row.Customer) || '(ไม่ระบุลูกค้า)',
      tons: Number(row.Tons) || 0,
    }));
  for (const row of rdf3Sales) {
    if (row.SaleDate < weekStart || row.SaleDate >= weekEndExclusive) continue;
    salesRows.push({
      date: row.SaleDate,
      product: 'RDF3',
      customer: cleanText(row.Customer) || '(ไม่ระบุลูกค้า)',
      tons: Number(row.Tons) || 0,
    });
  }

  const salesProductMap = Object.fromEntries(REVENUE_PRODUCTS.map((product) => [product, 0]));
  const salesCustomerMap = new Map();
  for (const sale of salesRows) {
    salesProductMap[sale.product] += sale.tons;
    if (!salesCustomerMap.has(sale.customer)) {
      salesCustomerMap.set(sale.customer, {
        customer: sale.customer,
        totalTons: 0,
        products: Object.fromEntries(REVENUE_PRODUCTS.map((product) => [product, 0])),
      });
    }
    const customer = salesCustomerMap.get(sale.customer);
    customer.totalTons += sale.tons;
    customer.products[sale.product] += sale.tons;
  }

  const salesByCustomer = [...salesCustomerMap.values()]
    .sort((a, b) => b.totalTons - a.totalTons || a.customer.localeCompare(b.customer, 'th'));

  return sendJson(res, 200, {
    ok: true,
    weekStart,
    weekEnd,
    weekEndExclusive,
    kpi: {
      msw: {
        monthlyTargetTons: monthlyMSWTargetTons,
        weeklyTargetTons: weeklyMSWTargetTons,
        actualTons: incomingWaste,
        diffTons: mswDiffTons,
        shortfallTons: Math.max(0, -mswDiffTons),
        attainmentPct: mswAttainmentPct,
        passed: weeklyMSWTargetTons > 0 ? incomingWaste >= weeklyMSWTargetTons : null,
      },
    },
    incoming: {
      totalGrabs,
      totalTons: incomingWaste,
      avgTonsPerGrab: totalGrabs > 0 ? incomingWaste / totalGrabs : null,
    },
    production: {
      calculatedIncomingTons: calculatedIncomingWaste,
      uncalculatedIncomingTons: incomingWaste - calculatedIncomingWaste,
      missingYieldDates,
      products: productionProducts,
    },
    sales: {
      transactionCount: salesRows.length,
      totalTons: salesRows.reduce((sum, row) => sum + row.tons, 0),
      byProduct: REVENUE_PRODUCTS.map((product) => ({ product, tons: salesProductMap[product] })),
      byCustomer: salesByCustomer,
    },
    daily,
  });
}

// ---------- Weekly Delivery Plan (Monday 00:00 to next Monday 00:00) ----------

function deliveryActualRows(stockSales, rdf3Sales, weekStart, weekEndExclusive) {
  const rows = stockSales
    .filter((row) => row.SaleDate >= weekStart && row.SaleDate < weekEndExclusive
      && DIRECT_SALES_PRODUCTS.includes(row.Material))
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
    const product = normalizeCustomerProduct(cleanText(body.product), customer);
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

function rateLimitRequest(req, res, key, limit, windowMs) {
  const result = rateLimiter.check(key, limit, windowMs);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(result.retryAfter));
  sendJson(res, 429, { ok: false, error: 'มีคำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่' });
  return false;
}

function requestHasBody(req) {
  return Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
}

function validateJsonContentType(req, res) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !requestHasBody(req)) return true;
  if (String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return true;
  sendJson(res, 415, { ok: false, error: 'รองรับข้อมูลแบบ application/json เท่านั้น' });
  return false;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}

async function appendSecurityAudit(req, action, user, detail) {
  const context = {
    requestId: req.gp1RequestId,
    ip: getClientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    user: user || { id: 'anonymous', email: String(detail?.email || 'anonymous') },
  };
  try {
    await runWithRequestContext(context, () => store.appendRow('AuditLog', {
      Action: action,
      Entity: 'Authentication',
      RecordID: user?.id || '',
      ActorUserID: user?.id || 'anonymous',
      ActorEmail: user?.email || String(detail?.email || ''),
      BeforeData: null,
      AfterData: detail || null,
      RequestID: context.requestId,
      IPAddress: context.ip,
      UserAgent: context.userAgent,
    }));
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', requestId: req.gp1RequestId, event: 'audit-write-failed', message: error.message }));
  }
}

async function handleAuthApi(req, res, parts) {
  const route = parts[0] || 'session';
  const ip = getClientIp(req);
  if (route === 'login' && req.method === 'POST') {
    if (!rateLimitRequest(req, res, `login:${ip}`, 10, 15 * 60 * 1000)) return;
    if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'คำขอ Login ไม่ถูกต้อง' });
    if (!validateJsonContentType(req, res)) return;
    const body = await readBody(req);
    const normalizedEmail = String(body.email || '').trim().toLowerCase();
    if (normalizedEmail.length > 320 || String(body.password || '').length > 1024) {
      return sendJson(res, 400, { ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (!rateLimitRequest(req, res, `login-account:${normalizedEmail}`, 10, 15 * 60 * 1000)) return;
    const user = await auth.login(req, res, body.email, body.password);
    if (!user) {
      await appendSecurityAudit(req, 'LOGIN_FAILED', null, { email: String(body.email || '').trim().toLowerCase() });
      return sendJson(res, 401, { ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือบัญชียังไม่ได้รับสิทธิ์' });
    }
    await appendSecurityAudit(req, 'LOGIN', user, { role: user.role });
    return sendJson(res, 200, { ok: true, user: publicUser(user), authEnabled: auth.enabled });
  }
  if (route === 'session' && req.method === 'GET') {
    if (!rateLimitRequest(req, res, `session:${ip}`, 120, 60 * 1000)) return;
    const user = await auth.authenticate(req, res);
    if (!user) return sendJson(res, 401, { ok: false, error: 'กรุณาเข้าสู่ระบบ' });
    return sendJson(res, 200, { ok: true, user: publicUser(user), authEnabled: auth.enabled });
  }
  if (route === 'accept-invite' && req.method === 'POST') {
    if (!rateLimitRequest(req, res, `invite-accept:${ip}`, 10, 15 * 60 * 1000)) return;
    if (!auth.sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'คำขอไม่ถูกต้อง' });
    if (!validateJsonContentType(req, res)) return;
    const body = await readBody(req);
    const passwordLength = String(body.password || '').length;
    if (passwordLength < 10 || passwordLength > 1024) {
      return sendJson(res, 400, { ok: false, error: 'รหัสผ่านต้องมี 10-1,024 ตัวอักษร' });
    }
    const user = await auth.acceptInvite(req, res, body);
    if (!user) return sendJson(res, 400, { ok: false, error: 'ลิงก์หมดอายุหรือไม่ถูกต้อง กรุณาขอลิงก์ใหม่จากผู้ดูแลระบบ' });
    await appendSecurityAudit(req, 'INVITE_ACCEPTED', user, { role: user.role });
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }
  if (route === 'logout' && req.method === 'POST') {
    const user = await auth.authenticate(req, res);
    if (auth.enabled && (!user || !auth.verifyCsrf(req))) {
      return sendJson(res, 403, { ok: false, error: 'คำขอออกจากระบบไม่ถูกต้อง' });
    }
    await auth.logout(req, res);
    await appendSecurityAudit(req, 'LOGOUT', user, null);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { ok: false, error: 'unknown auth route' });
}

function normalizeUserRow(row) {
  const active = !['false', '0', ''].includes(String(row.Active).toLowerCase());
  const authLinked = Boolean(String(row.AuthUserID || '').trim());
  return {
    id: String(row.ID),
    email: row.Email,
    displayName: row.DisplayName || row.Email,
    role: row.Role,
    active,
    authLinked,
    deleted: !active && !authLinked,
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt,
  };
}

async function handleSecurityApi(req, res, parts, query) {
  const section = parts[0];
  if (section === 'users' && req.method === 'GET' && parts.length === 1) {
    const rows = (await store.readSheet('AppUsers'))
      .map(normalizeUserRow)
      .filter((row) => !row.deleted);
    return sendJson(res, 200, { ok: true, rows });
  }
  if (section === 'users' && req.method === 'POST' && parts.length === 1) {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'viewer');
    const displayName = String(body.displayName || '').trim();
    if (email.length > 320 || displayName.length > 120 || !/^\S+@\S+\.\S+$/.test(email) || !auth.roles.includes(role)) {
      return sendJson(res, 400, { ok: false, error: 'กรุณาระบุอีเมลและสิทธิ์ผู้ใช้ให้ถูกต้อง' });
    }
    const row = await auth.inviteUser({
      email,
      displayName,
      role,
      redirectTo: process.env.AUTH_REDIRECT_URL || `${String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0]}://${String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0]}/accept-invite.html`,
    });
    return sendJson(res, 200, { ok: true, row: normalizeUserRow(row) });
  }
  if (section === 'users' && req.method === 'PUT' && parts.length === 2) {
    const rows = await store.readSheet('AppUsers');
    const target = rows.find((row) => String(row.ID) === String(parts[1]));
    if (!target) return sendJson(res, 404, { ok: false, error: 'ไม่พบบัญชีผู้ใช้' });
    const body = await readBody(req);
    const role = body.role === undefined ? target.Role : String(body.role);
    const active = body.active === undefined
      ? normalizeUserRow(target).active
      : body.active === true || body.active === 'true';
    if (!auth.roles.includes(role)) return sendJson(res, 400, { ok: false, error: 'สิทธิ์ผู้ใช้ไม่ถูกต้อง' });
    if (String(target.ID) === String(req.gp1User.id) && (!active || role !== 'admin')) {
      return sendJson(res, 400, { ok: false, error: 'ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตนเองได้' });
    }
    const activeAdmins = rows.filter((row) => normalizeUserRow(row).active && row.Role === 'admin');
    if (target.Role === 'admin' && activeAdmins.length === 1 && (!active || role !== 'admin')) {
      return sendJson(res, 400, { ok: false, error: 'ระบบต้องมีผู้ดูแลที่ใช้งานได้อย่างน้อย 1 คน' });
    }
    const updated = await store.updateRow('AppUsers', target.ID, {
      DisplayName: body.displayName === undefined ? target.DisplayName : String(body.displayName).trim().slice(0, 120),
      Role: role,
      Active: active,
    });
    return sendJson(res, 200, { ok: true, row: normalizeUserRow(updated) });
  }
  if (section === 'users' && req.method === 'POST' && parts.length === 3 && parts[2] === 'reset-password') {
    const rows = await store.readSheet('AppUsers');
    const target = rows.find((row) => String(row.ID) === String(parts[1]));
    if (!target) return sendJson(res, 404, { ok: false, error: 'ไม่พบบัญชีผู้ใช้' });
    const protocol = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
    const resetUrl = process.env.AUTH_REDIRECT_URL || `${protocol}://${host}/accept-invite.html`;
    await auth.sendPasswordReset(target.Email, resetUrl);
    await appendSecurityAudit(req, 'PASSWORD_RESET_SENT', req.gp1User, {
      targetUserId: String(target.ID), targetEmail: target.Email,
    });
    return sendJson(res, 200, { ok: true });
  }
  if (section === 'users' && req.method === 'POST' && parts.length === 3 && parts[2] === 'password') {
    const rows = await store.readSheet('AppUsers');
    const target = rows.find((row) => String(row.ID) === String(parts[1]));
    if (!target || normalizeUserRow(target).deleted) {
      return sendJson(res, 404, { ok: false, error: 'ไม่พบบัญชีผู้ใช้' });
    }
    if (!rateLimitRequest(req, res, `admin-password:${req.gp1User.id}:${target.ID}`, 10, 15 * 60 * 1000)) return;
    const body = await readBody(req);
    const password = String(body.password || '');
    if (password.length < 10 || password.length > 1024) {
      return sendJson(res, 400, { ok: false, error: 'รหัสผ่านต้องมี 10-1,024 ตัวอักษร' });
    }
    if (!String(target.AuthUserID || '').trim()) {
      return sendJson(res, 409, { ok: false, error: 'บัญชีนี้ยังไม่ได้เชื่อมกับ Supabase Auth' });
    }
    await auth.setUserPassword(target.AuthUserID, password);
    await appendSecurityAudit(req, 'USER_PASSWORD_SET', req.gp1User, {
      targetUserId: String(target.ID), targetEmail: target.Email,
    });
    return sendJson(res, 200, { ok: true });
  }
  if (section === 'users' && req.method === 'DELETE' && parts.length === 2) {
    const rows = await store.readSheet('AppUsers');
    const target = rows.find((row) => String(row.ID) === String(parts[1]));
    if (!target || normalizeUserRow(target).deleted) {
      return sendJson(res, 404, { ok: false, error: 'ไม่พบบัญชีผู้ใช้' });
    }
    if (!rateLimitRequest(req, res, `admin-delete:${req.gp1User.id}`, 10, 15 * 60 * 1000)) return;
    if (String(target.ID) === String(req.gp1User.id)) {
      return sendJson(res, 400, { ok: false, error: 'ไม่สามารถลบบัญชีที่กำลังใช้งานอยู่ได้' });
    }
    const targetUser = normalizeUserRow(target);
    const activeAdmins = rows.map(normalizeUserRow)
      .filter((row) => !row.deleted && row.active && row.role === 'admin');
    if (targetUser.role === 'admin' && targetUser.active && activeAdmins.length === 1) {
      return sendJson(res, 400, { ok: false, error: 'ระบบต้องมีผู้ดูแลที่ใช้งานได้อย่างน้อย 1 คน' });
    }
    const originalActive = targetUser.active;
    await store.updateRow('AppUsers', target.ID, { Active: false });
    try {
      await auth.deleteUserAccount(target.AuthUserID);
    } catch (error) {
      await store.updateRow('AppUsers', target.ID, { Active: originalActive }).catch(() => {});
      throw error;
    }
    await store.updateRow('AppUsers', target.ID, { AuthUserID: null, Active: false });
    await appendSecurityAudit(req, 'USER_ACCOUNT_DELETED', req.gp1User, {
      targetUserId: String(target.ID), targetEmail: target.Email, targetRole: target.Role,
    });
    return sendJson(res, 200, { ok: true });
  }
  if (section === 'audit' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(query.limit || 150)));
    if (typeof store.readRecentAudit === 'function') {
      const rows = await store.readRecentAudit({ limit, entity: query.entity, action: query.action });
      return sendJson(res, 200, { ok: true, rows });
    }
    let rows = await store.readSheet('AuditLog');
    if (query.entity) rows = rows.filter((row) => row.Entity === query.entity);
    if (query.action) rows = rows.filter((row) => row.Action === query.action);
    rows.sort((a, b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)));
    return sendJson(res, 200, { ok: true, rows: rows.slice(0, limit) });
  }
  if (section === 'trash' && req.method === 'GET' && parts.length === 1) {
    const limit = Math.min(500, Math.max(1, Number(query.limit || 150)));
    const sourceRows = typeof store.readActiveDeleted === 'function'
      ? await store.readActiveDeleted(limit)
      : await store.readSheet('DeletedRecords');
    const rows = sourceRows
      .filter((row) => !row.RestoredAt)
      .sort((a, b) => String(b.DeletedAt).localeCompare(String(a.DeletedAt)))
      .slice(0, limit);
    return sendJson(res, 200, { ok: true, rows });
  }
  if (section === 'trash' && req.method === 'POST' && parts.length === 3 && parts[2] === 'restore') {
    let row;
    try {
      row = await store.restoreDeletedRecord(parts[1]);
    } catch (error) {
      if (error.code === '23505' || /already in use|duplicate/i.test(String(error.message))) {
        return sendJson(res, 409, {
          ok: false,
          error: 'กู้คืนไม่ได้ เนื่องจากมีข้อมูลรหัสเดียวกันอยู่ในระบบแล้ว',
        });
      }
      throw error;
    }
    if (!row) return sendJson(res, 404, { ok: false, error: 'ไม่พบรายการที่กู้คืนได้' });
    return sendJson(res, 200, { ok: true, row });
  }
  if (section === 'backup' && req.method === 'GET') {
    await appendSecurityAudit(req, 'BACKUP_EXPORT', req.gp1User, null);
    const backup = await store.exportBackup();
    const stamp = backup.generatedAt.replace(/[:.]/g, '-');
    const payload = JSON.stringify(backup, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gp1-connect-backup-${stamp}.json"`,
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end(payload);
    return;
  }
  if (section === 'status' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      authEnabled: auth.enabled,
      authConfigured: auth.configured,
      database: process.env.DATABASE_URL ? 'postgres' : 'excel',
      separateMigrationRole: Boolean(process.env.MIGRATION_DATABASE_URL),
      verifiedDatabaseTls: process.env.DATABASE_URL ? process.env.DATABASE_SSL !== 'false' : null,
      scheduledBackupConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.BACKUP_BUCKET),
    });
  }
  return sendJson(res, 404, { ok: false, error: 'unknown security route' });
}

async function dispatchBusinessApi(req, res, pathname, query) {
  const segs = pathname.split('/').filter(Boolean);
  const resource = segs[1];
  const rest = segs.slice(2);
  if (resource === 'security') return handleSecurityApi(req, res, rest, query);
  if (resource === 'downtime') return handleDowntime(req, res, rest, query);
  if (resource === 'line') return handleLine(req, res, rest, query);
  if (resource === 'report') return handleReport(req, res, query);
  if (resource === 'grab') {
    if (rest.length === 0 && req.method === 'GET') return handleGrabGet(req, res, query);
    if (rest.length === 0 && req.method === 'DELETE') return handleGrabDelete(req, res, query);
  }
  if (resource === 'production') return handleProduction(req, res, query);
  if (resource === 'weekly-report' && req.method === 'GET') return handleWeeklyReport(req, res, query);
  if (resource === 'yield') return handleYield(req, res, rest);
  if (resource === 'sales') return handleSales(req, res, rest);
  if (resource === 'delivery-plans') return handleDeliveryPlans(req, res, rest, query);
  if (resource === 'stock') {
    if (rest[0] === 'baseline') return handleStockBaseline(req, res);
    if (rest.length === 0 && req.method === 'GET') return handleStock(req, res);
  }
  if (resource === 'revenue') return handleRevenue(req, res, rest, query);
  if (resource === 'kpi') return handleKPI(req, res, rest, query);
  return sendJson(res, 404, { ok: false, error: 'unknown api route' });
}

const server = http.createServer(async (req, res) => {
  req.gp1RequestId = createRequestId(req);
  res.setHeader('X-Request-ID', req.gp1RequestId);
  res.__cspNonce = applySecurityHeaders(res);
  try {
    const parsed = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(parsed.pathname); } catch {
      const error = new Error('URL ไม่ถูกต้อง');
      error.statusCode = 400;
      throw error;
    }
    const query = Object.fromEntries(parsed.searchParams.entries());

    if (pathname === '/api/device/grab-sync') {
      return await handleGrabDeviceSync(req, res);
    }

    if (pathname.startsWith('/api/auth/')) {
      const authParts = pathname.split('/').filter(Boolean).slice(2);
      return await handleAuthApi(req, res, authParts);
    }

    if (pathname.startsWith('/api/')) {
      const user = await auth.authenticate(req, res);
      if (!user) return sendJson(res, 401, { ok: false, error: 'กรุณาเข้าสู่ระบบ' });
      req.gp1User = user;
      const limit = req.method === 'GET' ? 600 : 120;
      const windowMs = 60 * 1000;
      if (!rateLimitRequest(req, res, `api:${user.id}:${req.method}`, limit, windowMs)) return;
      const role = requiredRole(pathname, req.method);
      if (!hasRole(user, role)) {
        return sendJson(res, 403, { ok: false, error: 'บัญชีนี้ไม่มีสิทธิ์ดำเนินการส่วนนี้' });
      }
      if (!validateJsonContentType(req, res)) return;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !auth.verifyCsrf(req)) {
        return sendJson(res, 403, { ok: false, error: 'Session หมดอายุหรือคำขอไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
      }
      const context = {
        requestId: req.gp1RequestId,
        ip: getClientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
        user,
      };
      return await runWithRequestContext(context, () => dispatchBusinessApi(req, res, pathname, query));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    const htmlRequest = pathname === '/' || pathname.endsWith('.html');
    if (htmlRequest && pathname !== '/login.html' && pathname !== '/accept-invite.html') {
      const user = await auth.authenticate(req, res);
      if (!user) {
        res.writeHead(302, { Location: '/login.html' });
        res.end();
        return;
      }
      if (pathname === '/security.html' && user.role !== 'admin') {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
    }
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const publicPath = relativePath.replace(/\\/g, '/');
    if (!PUBLIC_FILES.has(publicPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const filePath = path.resolve(DIR, relativePath);
    if (filePath !== HTML_PATH && !filePath.startsWith(`${DIR}${path.sep}`)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    sendStatic(req, res, filePath, query);
  } catch (e) {
    const status = Number(e.statusCode) >= 400 && Number(e.statusCode) < 600 ? Number(e.statusCode) : 500;
    console.error(JSON.stringify({
      level: 'error',
      requestId: req.gp1RequestId,
      method: req.method,
      path: String(req.url || '').split('?')[0],
      status,
      message: e.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : e.stack,
    }));
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) res.end();
      return;
    }
    const error = status < 500 || status === 503
      ? String(e.message || 'คำขอไม่ถูกต้อง')
      : `ระบบขัดข้องชั่วคราว กรุณาลองใหม่ (รหัสอ้างอิง ${req.gp1RequestId})`;
    sendJson(res, status, { ok: false, error, requestId: req.gp1RequestId });
  }
});

server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 30000;
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 15000;
server.keepAliveTimeout = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS) || 5000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 100;
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

function startServer(port) {
  server.listen(port, HOST, () => {
    const link = `http://localhost:${port}/`;
    console.log(`RDF2 Downtime Logger running at ${link}`);
    if (store.XLSX_PATH) {
      console.log(`ไฟล์ข้อมูล: ${store.XLSX_PATH}`);
      console.log('เปิดเบราว์เซอร์ไปที่ลิงก์ด้านบน แล้วเปิดค้างไว้ระหว่างใช้งาน (อย่าปิดหน้าต่างดำนี้)');
    } else {
      console.log('ใช้ฐานข้อมูล Postgres ผ่าน DATABASE_URL');
    }
    const { exec } = require('child_process');
    if (process.platform === 'win32' && !process.env.PORT && process.env.AUTO_OPEN_BROWSER !== 'false') {
      exec(`start "" "${link}"`);
    }
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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down GP1 Connect (${signal})`);
  const forceTimer = setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    process.exit(1);
  }, 10000);
  forceTimer.unref();
  server.close(async () => {
    try {
      if (typeof store.close === 'function') await store.close();
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
