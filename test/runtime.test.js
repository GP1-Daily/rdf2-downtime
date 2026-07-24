const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp1-runtime-test-'));
const workbookPath = path.join(tempDir, 'runtime.xlsx');
process.env.RDF2_XLSX_PATH = workbookPath;
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const store = require('../store');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(t) {
  const port = await freePort();
  let serverError = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      RDF2_XLSX_PATH: workbookPath,
      NODE_ENV: 'test',
      AUTH_DISABLED: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(2000)]);
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/login.html`);
      if (response.ok) return baseUrl;
    } catch (_) {
      // Server is still starting.
    }
    if (attempt === 99) throw new Error(`server did not start: ${serverError}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${serverError}`);
}

function line(entryDate, eventType, time, stopType = '') {
  return { EntryDate: entryDate, EventType: eventType, Time: time, StopType: stopType, Note: '' };
}

function downtime(entryDate, startTime, endTime, reason = 'test') {
  return { EntryDate: entryDate, StartTime: startTime, EndTime: endTime, Reason: reason, Note: '' };
}

function grab(id, dateTime, weight = 4.8) {
  return {
    ReportDate: dateTime.slice(0, 10),
    DateTime: dateTime,
    Weight: weight,
    SourceSystem: 'grab-pi-1',
    SourceID: id,
    SyncedAt: '2026-07-24T07:00:00.000Z',
  };
}

test('runtime uses first-to-last Grab per session and merges overlapping downtime', async (t) => {
  await store.appendRows('LineTime', [
    line('2026-07-24', 'Start', '08:00'),
    line('2026-07-24', 'Stop', '12:00', 'break'),
    line('2026-07-24', 'Start', '13:00'),
    line('2026-07-24', 'Stop', '18:00', 'end'),
  ]);
  await store.appendRows('Downtime', [
    downtime('2026-07-24', '09:00', '09:30', 'overlap-a'),
    downtime('2026-07-24', '09:15', '09:45', 'overlap-b'),
    downtime('2026-07-24', '12:15', '12:45', 'outside-session'),
  ]);
  await store.appendRows('GrabCrane', [
    grab(1, '2026-07-24 08:10:00'),
    grab(2, '2026-07-24 11:50:00'),
    grab(3, '2026-07-24 13:15:00'),
    grab(4, '2026-07-24 17:45:00'),
  ]);

  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/report?date=2026-07-24`);
  assert.equal(response.status, 200);
  const report = await response.json();

  assert.equal(report.line.totalMinutes, 540);
  assert.equal(report.line.productionMinutes, 490);
  assert.equal(report.line.runtimeSource, 'grab');
  assert.equal(report.line.grabAnchoredSessions, 2);
  assert.deepEqual(Object.values(report.line.productionByPeriod), [220, 225, 45]);
  assert.equal(report.downtime.totalMinutesRaw, 90);
  assert.equal(report.downtime.totalMinutes, 45);
  assert.equal(report.line.netRunMinutes, 445);
  assert.ok(Math.abs(report.line.availabilityPct - (445 / 490 * 100)) < 0.0001);
  assert.equal(report.grab.firstGrabTime, '08:10');
  assert.equal(report.grab.lastGrabTime, '17:45');

  const removedImport = await fetch(`${baseUrl}/api/grab/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [] }),
  });
  assert.equal(removedImport.status, 404);
});

test('cross-midnight sessions and downtime are split into their calendar days', async (t) => {
  await store.appendRows('LineTime', [
    line('2026-07-25', 'Start', '20:00'),
    line('2026-07-26', 'Stop', '08:00', 'end'),
  ]);
  await store.appendRows('Downtime', [
    downtime('2026-07-25', '23:30', '01:00', 'night-break'),
  ]);
  await store.appendRows('GrabCrane', [
    grab(5, '2026-07-25 20:10:00'),
    grab(6, '2026-07-25 23:50:00'),
    grab(7, '2026-07-26 00:10:00'),
    grab(8, '2026-07-26 07:50:00'),
  ]);

  const baseUrl = await startServer(t);
  const day25 = await fetch(`${baseUrl}/api/report?date=2026-07-25`).then((response) => response.json());
  const day26 = await fetch(`${baseUrl}/api/report?date=2026-07-26`).then((response) => response.json());

  assert.equal(day25.line.totalMinutes, 240);
  assert.equal(day25.line.productionMinutes, 230);
  assert.equal(day25.downtime.totalMinutes, 30);
  assert.equal(day25.line.netRunMinutes, 200);
  assert.equal(day25.grab.totalGrabs, 2);

  assert.equal(day26.line.totalMinutes, 480);
  assert.equal(day26.line.productionMinutes, 470);
  assert.equal(day26.downtime.totalMinutes, 60);
  assert.equal(day26.line.netRunMinutes, 410);
  assert.equal(day26.grab.totalGrabs, 2);
});

test('Start and Stop remain the visible fallback when a session has fewer than two Grabs', async (t) => {
  await store.appendRows('LineTime', [
    line('2026-07-27', 'Start', '08:00'),
    line('2026-07-27', 'Stop', '10:00', 'end'),
  ]);
  await store.appendRows('GrabCrane', [grab(9, '2026-07-27 09:00:00')]);

  const baseUrl = await startServer(t);
  const report = await fetch(`${baseUrl}/api/report?date=2026-07-27`).then((response) => response.json());

  assert.equal(report.line.totalMinutes, 120);
  assert.equal(report.line.productionMinutes, 120);
  assert.equal(report.line.runtimeSource, 'manual');
  assert.equal(report.line.estimatedSessions, 1);
  assert.equal(report.line.netRunMinutes, 120);
});
