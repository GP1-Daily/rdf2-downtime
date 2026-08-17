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

function assertNear(actual, expected, tolerance = 1e-8) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
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

test('RDF3 Grab storage keeps kilograms and de-duplicates an offline queue retry', async () => {
  const context = {
    requestId: 'rdf3-grab-device-test',
    ip: '127.0.0.1',
    userAgent: 'test',
    user: { id: 'device:grabcrane-01', email: 'grabcrane-01@device.local', role: 'operator' },
  };
  const payload = {
    ReportDate: '2026-08-11',
    DateTime: '2026-08-11 08:15:00',
    WeightKg: 485,
    SourceKey: '1786410900:485',
  };
  const first = await runWithRequestContext(context, () => (
    store.syncRDF3GrabRow('grabcrane-01', payload)
  ));
  const repeated = await runWithRequestContext(context, () => (
    store.syncRDF3GrabRow('grabcrane-01', payload)
  ));
  const rows = await store.readSheet('RDF3GrabCrane');
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].WeightKg), 485);
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

  const report = await fetch(`${baseUrl}/api/report?date=2026-07-25`).then((response) => response.json());
  assert.equal(report.grab.deviceConfigured, true);
  assert.equal(report.grab.syncStatus.Status, 'success');
  assert.equal(Number(report.grab.syncStatus.LastSourceID), 501);
  assert.equal(Number(report.grab.syncStatus.LastRowCount), 1);
  assert.ok(report.grab.syncStatus.LastSuccessAt);
});

test('RDF3 Grab device API accepts ESP32 form data and reports tons on the dashboard', async (t) => {
  const port = await freePort();
  const workbookPath = path.join(tempDir, 'rdf3-grab-api.xlsx');
  const token = 'r'.repeat(64);
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
      RDF3_GRAB_DEVICE_ID: 'grabcrane-01',
      RDF3_GRAB_SYNC_TOKEN: token,
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

  const epoch = Math.floor(Date.parse('2026-08-11T01:15:00Z') / 1000);
  const invalid = await fetch(`${baseUrl}/api/device/rdf3-grab-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ device: 'grabcrane-01', key: 'wrong', weight: '485', ts: String(epoch) }),
  });
  assert.equal(invalid.status, 401);

  const send = () => fetch(`${baseUrl}/api/device/rdf3-grab-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ device: 'grabcrane-01', key: token, weight: '485', ts: String(epoch) }),
  });
  const accepted = await send();
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.duplicate, false);
  assert.equal(acceptedBody.weighedAt, '2026-08-11 08:15:00');
  assert.equal(acceptedBody.weightTons, 0.485);

  const retryBody = await (await send()).json();
  assert.equal(retryBody.duplicate, true);

  const concurrentEpoch = epoch + 60;
  const sendConcurrent = async () => {
    const response = await fetch(`${baseUrl}/api/device/rdf3-grab-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        device: 'grabcrane-01', key: token, weight: '510', ts: String(concurrentEpoch),
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const concurrentBodies = await Promise.all(Array.from({ length: 5 }, sendConcurrent));
  assert.equal(concurrentBodies.filter((body) => body.duplicate === false).length, 1);
  assert.equal(concurrentBodies.filter((body) => body.duplicate === true).length, 4);

  const dashboard = await fetch(`${baseUrl}/api/rdf3-grab?date=2026-08-11`).then((response) => response.json());
  assert.equal(dashboard.summary.totalGrabs, 2);
  assert.equal(dashboard.summary.totalWeightKg, 995);
  assert.equal(dashboard.summary.totalWeight, 0.995);
  assert.equal(dashboard.summary.firstGrabTime, '08:15');

  const baselineResponse = await fetch(`${baseUrl}/api/stock/baseline`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baselineDate: '2026-08-11',
      rdf2Tons: 10,
      rdf2LGTons: 2,
      rdf3Tons: 1,
      fineFractionTons: 3,
      metalTons: 0.5,
    }),
  });
  assert.equal(baselineResponse.status, 200, await baselineResponse.text());

  const report = await fetch(`${baseUrl}/api/report?date=2026-08-11`).then((response) => response.json());
  assert.equal(report.rdf3Grab.totalGrabs, 2);
  assert.equal(report.rdf3Grab.avgWeight, 0.4975);
  assertNear(report.rdf3Production.feedTons, 0.995);
  assertNear(report.rdf3Production.outputTons, 0.995 * 0.8235);
  assertNear(report.stock.stock.rdf2, 10 - 0.995);
  assertNear(report.stock.stock.rdf2LG, 2);
  assertNear(report.stock.stock.rdf3, 1 + 0.995 * 0.8235);

  const production = await fetch(`${baseUrl}/api/production?date=2026-08-11`).then((response) => response.json());
  assert.equal(production.rdf3Grab.totalGrabs, 2);
  assertNear(production.rdf3Production.feedTons, 0.995);
  assertNear(production.rdf3Production.outputTons, 0.995 * 0.8235);

  const stock = await fetch(`${baseUrl}/api/stock?date=2026-08-11`).then((response) => response.json());
  assert.equal(stock.configured, true);
  assertNear(stock.rdf2TransferredToRDF3Tons, 0.995);
  assertNear(stock.stock.rdf2, 9.005);
  assertNear(stock.stock.rdf2LG, 2);
  assertNear(stock.stock.rdf3, 1.8193825);
  assertNear(stock.stock.fineFraction, 3);
  assertNear(stock.stock.metal, 0.5);

  const weekly = await fetch(`${baseUrl}/api/weekly-report?weekStart=2026-08-10`).then((response) => response.json());
  const weeklyRDF3 = weekly.production.products.find((row) => row.product === 'RDF3');
  assertNear(weeklyRDF3.tons, 0.8193825);
  assertNear(weekly.stock.stock.rdf2, 9.005);
  assertNear(weekly.stock.stock.rdf2LG, 2);
  assertNear(weekly.stock.stock.rdf3, 1.8193825);

  const monthly = await fetch(`${baseUrl}/api/monthly-report?month=2026-08`).then((response) => response.json());
  const monthlyRDF3 = monthly.production.products.find((row) => row.product === 'RDF3');
  assertNear(monthlyRDF3.tons, 0.8193825);
  assertNear(monthly.stock.stock.rdf2, 9.005);
  assertNear(monthly.stock.stock.rdf2LG, 2);
  assertNear(monthly.stock.stock.rdf3, 1.8193825);

  const executive = await fetch(`${baseUrl}/api/executive-report?date=2026-08-11`).then((response) => response.json());
  assertNear(executive.output.daily.rdf3FeedTons, 0.995);
  assertNear(executive.output.daily.rdf3Tons, 0.8193825);
  assertNear(executive.output.mtd.rdf3Tons, 0.8193825);
  assertNear(executive.stock.stock.rdf2, 9.005);
  assertNear(executive.stock.stock.rdf2LG, 2);
  assertNear(executive.stock.stock.rdf3, 1.8193825);
});

test('RDF3 production uses measured feed and yield while capacity remains a performance benchmark', async (t) => {
  const port = await freePort();
  const workbookPath = path.join(tempDir, 'rdf3-machine-bottleneck.xlsx');
  const token = 'm'.repeat(64);
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
      RDF3_GRAB_DEVICE_ID: 'grabcrane-01',
      RDF3_GRAB_SYNC_TOKEN: token,
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

  const baseline = await fetch(`${baseUrl}/api/stock/baseline`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baselineDate: '2026-08-12',
      rdf2Tons: 20,
      rdf2LGTons: 0,
      rdf3Tons: 0,
      fineFractionTons: 0,
      metalTons: 0,
    }),
  });
  assert.equal(baseline.status, 200, await baseline.text());

  const setting = await fetch(`${baseUrl}/api/rdf3-machines/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      effectiveDate: '2026-08-12',
      mc1CapTPH: 0.2,
      mc2CapTPH: 0.3,
      mc3CapTPH: 0.3,
      mc4CapTPH: 0.5,
      mc5CapTPH: 0.5,
      yieldPct: 80,
      efficiencyPct: 50,
    }),
  });
  assert.equal(setting.status, 200, await setting.text());

  const dailyStatus = await fetch(`${baseUrl}/api/rdf3-machines/daily`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryDate: '2026-08-12',
      mc1On: true,
      mc2On: true,
      mc3On: false,
      mc4On: true,
      mc5On: false,
    }),
  });
  assert.equal(dailyStatus.status, 200, await dailyStatus.text());

  async function sendGrab(dateTime, weightKg) {
    const epoch = Math.floor(Date.parse(`${dateTime.replace(' ', 'T')}+07:00`) / 1000);
    const response = await fetch(`${baseUrl}/api/device/rdf3-grab-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        device: 'grabcrane-01', key: token, weight: String(weightKg), ts: String(epoch),
      }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  await sendGrab('2026-08-12 08:00:00', 500);
  await sendGrab('2026-08-12 10:00:00', 500);

  const production = await fetch(`${baseUrl}/api/production?date=2026-08-12`).then((response) => response.json());
  assert.equal(production.rdf3Production.mode, 'material-yield');
  assert.equal(production.rdf3Production.activeMachineCount, 3);
  assertNear(production.rdf3Production.feedTons, 1);
  assertNear(production.rdf3Production.availableFeedTons, 1);
  assertNear(production.rdf3Production.activeCapacityTPH, 1);
  assertNear(production.rdf3Production.runtimeHours, 2);
  assertNear(production.rdf3Production.materialOutputTons, 0.8);
  assertNear(production.rdf3Production.capacityOutputTons, 1);
  assertNear(production.rdf3Production.outputTons, 0.8);
  assertNear(production.rdf3Production.inputConsumedTons, 1);
  assertNear(production.rdf3Production.wipTons, 0);

  const stock = await fetch(`${baseUrl}/api/stock?date=2026-08-12`).then((response) => response.json());
  assertNear(stock.stock.rdf2, 19);
  assert.equal(stock.stock.rdf2InProcess, undefined);
  assertNear(stock.stock.rdf3, 0.8);

  const adjustmentResponse = await fetch(`${baseUrl}/api/stock/adjustments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryDate: '2026-08-12', material: 'RDF2', tonsDelta: -20,
      reason: 'ตรวจนับสต๊อกจริง', note: 'integration test',
    }),
  });
  assert.equal(adjustmentResponse.status, 201, await adjustmentResponse.text());
  const adjustedStock = await fetch(`${baseUrl}/api/stock?date=2026-08-12`).then((response) => response.json());
  assertNear(adjustedStock.stock.rdf2, -1);
  assert.equal(adjustedStock.warnings[0].material, 'rdf2');
  const adjustmentHistory = await fetch(`${baseUrl}/api/stock/adjustments?month=2026-08`).then((response) => response.json());
  assert.equal(adjustmentHistory.rows.length, 1);
  assert.equal(Number(adjustmentHistory.rows[0].TonsDelta), -20);

  const weekly = await fetch(`${baseUrl}/api/weekly-report?weekStart=2026-08-10`).then((response) => response.json());
  const weeklyRDF3 = weekly.production.products.find((row) => row.product === 'RDF3');
  assertNear(weeklyRDF3.tons, 0.8);
  assertNear(weekly.production.rdf3Machine.inputConsumedTons, 1);
  assertNear(weekly.production.rdf3Machine.closingWipTons, 0);
  assertNear(weekly.stock.stock.rdf2, -1);

  const monthly = await fetch(`${baseUrl}/api/monthly-report?month=2026-08`).then((response) => response.json());
  const monthlyRDF3 = monthly.production.products.find((row) => row.product === 'RDF3');
  assertNear(monthlyRDF3.tons, 0.8);
  assertNear(monthly.production.rdf3Machine.runtimeMinutes, 120);
  assertNear(monthly.stock.stock.rdf2, -1);

  const executive = await fetch(`${baseUrl}/api/executive-report?date=2026-08-12`).then((response) => response.json());
  assertNear(executive.output.daily.rdf3Tons, 0.8);
  assertNear(executive.output.rdf3Machine.daily.capacityOutputTons, 1);
  assertNear(executive.output.rdf3Machine.mtd.closingWipTons, 0);
  assertNear(executive.stock.stock.rdf2, -1);
});
