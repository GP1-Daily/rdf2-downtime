const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp1-grab-sync-test-'));
process.env.RDF2_XLSX_PATH = path.join(tempDir, 'grab-sync.xlsx');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const store = require('../store');
const { runWithRequestContext } = require('../request-context');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function sourceRow(id, dateTime, weight, amp = 95.3, status = 10) {
  return {
    ReportDate: dateTime.slice(0, 10),
    DateTime: dateTime,
    Weight: weight,
    SourceID: id,
    Amp: amp,
    SourceStatus: status,
  };
}

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

test('Grab device sync is idempotent and reconciles a complete time window', async () => {
  const context = {
    requestId: 'grab-device-test',
    ip: '127.0.0.1',
    userAgent: 'test',
    user: { id: 'device:grab-pi-1', email: 'grab-pi-1@device.local', role: 'operator' },
  };

  await store.appendRows('GrabCrane', [{
    ReportDate: '2026-07-24',
    DateTime: '2026-07-24 08:16:58',
    Weight: 4.7,
    SourceFile: 'manual.csv',
  }]);
  await runWithRequestContext(context, () => store.syncGrabRows('grab-pi-1', [
    sourceRow(101, '2026-07-24 08:16:58', 4.74176, 94.3),
    sourceRow(102, '2026-07-24 08:26:58', 4.93296),
  ]));

  let rows = await store.readSheet('GrabCrane');
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].SourceID), 101);
  assert.equal(rows[0].ReportDate, '2026-07-24');

  const repeated = await runWithRequestContext(context, () => store.syncGrabRows('grab-pi-1', [
    sourceRow(101, '2026-07-24 08:16:58', 5.1, 96.2),
  ]));
  rows = await store.readSheet('GrabCrane');
  assert.equal(rows.length, 2);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.updated, 1);
  assert.equal(Number(rows.find((row) => Number(row.SourceID) === 101).Weight), 5.1);

  const sameSecond = await runWithRequestContext(context, () => store.syncGrabRows('grab-pi-1', [
    sourceRow(103, '2026-07-24 08:30:00', 4.5, 93.3),
    sourceRow(104, '2026-07-24 08:30:00', 4.6, 94.3),
  ]));
  rows = await store.readSheet('GrabCrane');
  assert.equal(sameSecond.created, 2);
  assert.equal(rows.filter((row) => row.DateTime === '2026-07-24 08:30:00').length, 2);
  assert.deepEqual(
    rows
      .filter((row) => row.DateTime === '2026-07-24 08:30:00')
      .map((row) => Number(row.SourceID))
      .sort((a, b) => a - b),
    [103, 104],
  );

  const reconciled = await runWithRequestContext(context, () => store.syncGrabRows('grab-pi-1', [
    sourceRow(101, '2026-07-24 08:16:58', 5.1, 96.2),
  ], {
    snapshotStart: '2026-07-24 00:00:00',
    snapshotEnd: '2026-07-25 00:00:00',
  }));
  rows = await store.readSheet('GrabCrane');
  assert.equal(rows.length, 1);
  assert.equal(reconciled.deleted, 3);
  assert.equal((await store.readSheet('DeletedRecords')).length, 3);
});

test('Grab device API requires its token and assigns the calendar date from source time', async (t) => {
  const port = await freePort();
  const workbookPath = path.join(tempDir, 'grab-api.xlsx');
  const token = 'a'.repeat(64);
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
      GRAB_SYNC_DEVICE_ID: 'grab-pi-1',
      GRAB_SYNC_TOKEN: token,
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/login.html`);
      if (response.ok) break;
    } catch (_) {
      // Server is still starting.
    }
    if (attempt === 299) throw new Error(`server did not start: ${serverError}`);
    await delay(50);
  }

  const payload = {
    deviceId: 'grab-pi-1',
    mode: 'upsert',
    rows: [
      { id: 500, amp: 95.3, weight: 4.93, status: 10, createDate: '2026-07-25 00:05:00' },
      { id: 501, amp: 95.3, weight: 4.93, status: 20, createDate: '2026-07-25 00:05:00' },
    ],
  };
  const rejected = await fetch(`${baseUrl}/api/device/grab-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify(payload),
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(`${baseUrl}/api/device/grab-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.received, 2);
  assert.equal(acceptedBody.processed, 1);
  assert.equal(acceptedBody.maxSourceId, 501);

  const reportDay = await fetch(`${baseUrl}/api/grab?date=2026-07-25`).then((response) => response.json());
  const previousDay = await fetch(`${baseUrl}/api/grab?date=2026-07-24`).then((response) => response.json());
  assert.equal(reportDay.rows.length, 1);
  assert.equal(reportDay.rows[0].DateTime, '2026-07-25 00:05:00');
  assert.equal(previousDay.rows.length, 0);
});
