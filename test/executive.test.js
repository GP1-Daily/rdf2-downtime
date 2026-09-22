const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp1-executive-test-'));
const workbookPath = path.join(tempDir, 'executive.xlsx');
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/login.html`)).ok) return baseUrl;
    } catch (_) {
      // Server is still starting.
    }
    if (attempt === 299) throw new Error(`server did not start: ${serverError}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${serverError}`);
}

function grab(id, dateTime, weight) {
  return {
    ReportDate: dateTime.slice(0, 10),
    DateTime: dateTime,
    Weight: weight,
    SourceSystem: 'grab-pi-1',
    SourceID: id,
    SyncedAt: '2026-08-04T12:00:00.000Z',
  };
}

async function jsonRequest(baseUrl, pathname, method, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('diesel entry and executive daily report combine source systems without double counting', async (t) => {
  await store.appendRows('GrabCrane', [
    grab(1, '2026-08-01 08:00:00', 100),
    grab(2, '2026-08-01 12:00:00', 100),
    grab(3, '2026-08-03 08:00:00', 100),
    grab(4, '2026-08-03 12:00:00', 200),
    grab(5, '2026-08-04 08:00:00', 100),
    grab(6, '2026-08-04 12:00:00', 150),
  ]);
  await store.appendRows('KPIDailyHistory', [
    { EntryDate: '2026-08-02', MSWTons: 300, Source: 'legacy-import' },
    { EntryDate: '2026-08-03', MSWTons: 999, Source: 'legacy-import' },
  ]);
  await store.appendRows('RDF3GrabCrane', [
    { ReportDate: '2026-08-01', DateTime: '2026-08-01 08:00:00', WeightKg: 1000, DeviceID: 'grabcrane-01', SourceKey: 'rdf3-plan-1' },
    { ReportDate: '2026-08-02', DateTime: '2026-08-02 08:00:00', WeightKg: 2000, DeviceID: 'grabcrane-01', SourceKey: 'rdf3-plan-2' },
    { ReportDate: '2026-08-03', DateTime: '2026-08-03 08:00:00', WeightKg: 3000, DeviceID: 'grabcrane-01', SourceKey: 'rdf3-plan-3' },
  ]);
  await store.appendRows('YieldSettings', [{
    EffectiveDate: '2026-08-01',
    RDF2Pct: 20,
    RDF2LGPct: 10,
    FineFractionPct: 30,
    HeavyFractionPct: 20,
    MetalPct: 5,
  }]);
  await store.appendRows('KPITargetSettings', [{
    EffectiveDate: '2026-08-01',
    RDF2Target: 1000,
    RDF2LGTarget: 0,
    RDF3Target: 800,
    FineFractionTarget: 800,
    MSWTarget: 8000,
    ComplaintLimit: 2,
  }]);
  await store.appendRows('RevenueTippingDaily', [
    { EntryDate: '2026-08-01', MSWTons: 100, Note: '' },
    { EntryDate: '2026-08-04', MSWTons: 363, Note: '' },
  ]);
  await store.appendRows('Downtime', [
    { EntryDate: '2026-08-03', StartTime: '23:30', EndTime: '00:30', Reason: 'Night break', Note: '' },
    { EntryDate: '2026-08-04', StartTime: '08:00', EndTime: '09:00', Reason: 'Plug Spinner', Note: 'Repair' },
    { EntryDate: '2026-08-04', StartTime: '12:00', EndTime: '14:00', Reason: 'Shredder', Note: '' },
  ]);
  await store.appendRows('DieselMachines', [
    { Name: 'Wheel Loader 1', Active: true, DailyLimitLiters: 150 },
    { Name: 'Excavator 1', Active: true, DailyLimitLiters: 100 },
    { Name: 'Old Loader', Active: false, DailyLimitLiters: 50 },
  ]);

  const baseUrl = await startServer(t);
  const inactive = await jsonRequest(baseUrl, '/api/diesel/usage', 'POST', {
    entryDate: '2026-08-04', machine: 'Old Loader', liters: 10,
  });
  assert.equal(inactive.response.status, 400);

  for (const entry of [
    { machine: 'Wheel Loader 1', liters: 1, note: 'Second fill' },
    { machine: 'Wheel Loader 1', liters: 120, note: 'กะเช้า' },
    { machine: 'Excavator 1', liters: 80, note: 'กะบ่าย' },
  ]) {
    const saved = await jsonRequest(baseUrl, '/api/diesel/usage', 'POST', {
      entryDate: '2026-08-04', ...entry,
    });
    assert.equal(saved.response.status, 200);
  }
  const baseline = await jsonRequest(baseUrl, '/api/diesel/stock/baseline', 'POST', {
    effectiveDate: '2026-08-01', openingLiters: 1000, note: 'ตรวจนับต้นเดือน',
  });
  assert.equal(baseline.response.status, 200);
  const receipt = await jsonRequest(baseUrl, '/api/diesel/stock/receipt', 'POST', {
    entryDate: '2026-08-04', liters: 500, reference: 'PO-001', note: '',
  });
  assert.equal(receipt.response.status, 200);

  const usage = await fetch(`${baseUrl}/api/diesel/usage?date=2026-08-04`).then((response) => response.json());
  assert.equal(usage.rows.length, 3);
  assert.equal(usage.summary.totalLiters, 201);
  assert.equal(usage.summary.totalLimitLiters, 250);
  assert.equal(usage.summary.utilizationPct, 80.4);
  assert.deepEqual(usage.summary.byMachine.map((row) => [row.machine, row.liters]), [
    ['Wheel Loader 1', 121],
    ['Excavator 1', 80],
  ]);
  assert.deepEqual(usage.summary.byMachine.map((row) => [row.machine, row.limitLiters]), [
    ['Wheel Loader 1', 150],
    ['Excavator 1', 100],
  ]);
  const stock = await fetch(`${baseUrl}/api/diesel/stock?date=2026-08-04`).then((response) => response.json());
  assert.equal(stock.rows.length, 1);
  assert.equal(stock.summary.openingLiters, 1000);
  assert.equal(stock.summary.periodReceivedLiters, 500);
  assert.equal(stock.summary.balanceLiters, 1299);

  const response = await fetch(`${baseUrl}/api/executive-report?date=2026-08-04`);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.incoming.dailyTons, 363);
  assert.equal(report.incoming.mtdTons, 463);
  assert.equal(report.production.dailyTons, 250);
  assert.equal(report.production.mtdTons, 1050);
  assert.equal(report.production.weeklyTons, 550);
  assert.equal(report.targets.source, 'kpi-target');
  assert.ok(Math.abs(report.targets.dailyTons - (8000 / 4 / 7)) < 0.0001);
  assert.equal(report.output.daily.rdf2Tons, 50);
  assert.equal(report.output.daily.rdf2LGTons, 25);
  assert.equal(report.output.mtd.rdf2Tons, 210);
  assert.equal(report.output.mtd.rdf2LGTons, 105);
  assert.ok(Math.abs(report.output.mtd.rdf3Tons - 4.941) < 0.0001);
  assert.equal(report.output.plan.basisDays, 3);
  assert.ok(Math.abs(report.output.plan.rdf2Tons - (160 / 3)) < 0.0001);
  assert.ok(Math.abs(report.output.plan.rdf2LGTons - (80 / 3)) < 0.0001);
  assert.ok(Math.abs(report.output.plan.mtdRDF2Tons - (640 / 3)) < 0.0001);
  assert.ok(Math.abs(report.output.plan.mtdRDF2LGTons - (320 / 3)) < 0.0001);
  assert.equal(report.output.plan.source, 'historical');
  assert.equal(report.output.plan.rdf3Available, true);
  assert.equal(report.output.plan.rdf3BasisDays, 3);
  assert.ok(Math.abs(report.output.plan.rdf3Tons - 1.647) < 0.0001);
  assert.ok(Math.abs(report.output.plan.mtdRDF3Tons - 6.588) < 0.0001);
  assert.equal(report.diesel.daily.totalLiters, 201);
  assert.equal(report.diesel.daily.totalLimitLiters, 250);
  assert.equal(report.diesel.daily.utilizationPct, 80.4);
  assert.deepEqual(report.diesel.daily.byMachine.map((row) => [row.machine, row.liters, row.dailyLimitLiters]), [
    ['Wheel Loader 1', 121, 150],
    ['Excavator 1', 80, 100],
  ]);
  assert.equal(report.diesel.mtd.totalLiters, 201);
  assert.equal(report.diesel.mtd.totalLimitLiters, 250);
  assert.equal(report.diesel.mtd.utilizationPct, 80.4);
  assert.equal(report.diesel.daily.stock.periodReceivedLiters, 500);
  assert.equal(report.diesel.mtd.stock.periodReceivedLiters, 500);
  assert.equal(report.diesel.daily.stock.balanceLiters, 1299);
  assert.equal(report.recovery.daysRemaining, 27);
  assert.equal(report.recovery.shortfallTons, 6950);
  assert.equal(report.trend.length, 4);
  assert.deepEqual(report.trend.map((row) => [row.date, row.tons, row.source]), [
    ['2026-08-01', 200, 'automatic'],
    ['2026-08-02', 300, 'history'],
    ['2026-08-03', 300, 'automatic'],
    ['2026-08-04', 250, 'automatic'],
  ]);
  assert.equal(report.incidents.totalCount, 3);
  assert.equal(report.incidents.totalMinutes, 210);
  assert.deepEqual(report.incidents.top.map((row) => [row.reason, row.minutes]), [
    ['Shredder', 120],
    ['Plug Spinner', 60],
  ]);

  const createdMachine = await jsonRequest(baseUrl, '/api/diesel/machines', 'POST', {
    name: 'Dozer 1', dailyLimitLiters: 60,
  });
  assert.equal(createdMachine.response.status, 200);
  const machineId = createdMachine.data.row.ID;
  const editedMachine = await jsonRequest(baseUrl, `/api/diesel/machines/${machineId}`, 'PUT', {
    name: 'Dozer 2', dailyLimitLiters: 75,
  });
  assert.equal(editedMachine.response.status, 200);
  assert.equal(editedMachine.data.row.Name, 'Dozer 2');
  assert.equal(Number(editedMachine.data.row.DailyLimitLiters), 75);
  const deletedMachine = await jsonRequest(baseUrl, `/api/diesel/machines/${machineId}`, 'DELETE');
  assert.equal(deletedMachine.response.status, 200);

  const machineRows = await fetch(`${baseUrl}/api/diesel/machines`).then((item) => item.json());
  const usedMachine = machineRows.rows.find((row) => row.Name === 'Wheel Loader 1');
  const renamedMachine = await jsonRequest(baseUrl, `/api/diesel/machines/${usedMachine.ID}`, 'PUT', {
    name: 'Wheel Loader A', dailyLimitLiters: 160,
  });
  assert.equal(renamedMachine.response.status, 200);
  const usageAfterRename = await fetch(`${baseUrl}/api/diesel/usage?date=2026-08-04`).then((item) => item.json());
  assert.equal(usageAfterRename.rows.some((row) => row.Machine === 'Wheel Loader A'), true);
  const refusedDelete = await jsonRequest(baseUrl, `/api/diesel/machines/${usedMachine.ID}`, 'DELETE');
  assert.equal(refusedDelete.response.status, 409);

  assert.equal((await fetch(`${baseUrl}/diesel.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/production-plan.js`)).status, 200);
  const executiveCssResponse = await fetch(`${baseUrl}/executive.css`);
  assert.equal(executiveCssResponse.status, 200);
  assert.match(
    await executiveCssResponse.text(),
    /\.executive-skeleton\[hidden\],\.executive-content\[hidden\]\{display:none !important;\}/,
  );
  const page = await fetch(`${baseUrl}/`).then((pageResponse) => pageResponse.text());
  assert.match(page, /executive\.js\?v=20260922-production-plan/);
  assert.match(page, /production-plan\.js\?v=20260922-production-plan/);
  assert.match(page, /id="productionPlanSetup"/);
  assert.match(page, /id="planRDF3"/);
  assert.match(page, /id="planMSW"/);
  assert.match(page, /id="productionPlanCoverage"/);
  assert.match(page, /id="executiveRDF3MTDPct"/);
  assert.match(page, /id="executiveRDF3MTDPlan"/);
  assert.match(page, /executive\.css\?v=20260814-company-logo/);
  assert.match(page, /id="executiveDieselMachines"/);
  assert.match(page, /id="executiveDieselDailyMeta"/);
  assert.doesNotMatch(page, /id="executiveDieselDailyLimit"/);
  assert.doesNotMatch(page, /id="executiveDieselMTDReceived"/);
  assert.match(page, /id="tab-diesel"/);
  assert.match(page, /id="tab-executive-report"/);
  assert.match(page, /<h2>Control Report<\/h2>/);
  assert.match(page, /<h2>Daily Report<\/h2>/);
  const version = await fetch(`${baseUrl}/api/version`).then((versionResponse) => versionResponse.json());
  assert.equal(version.version, '1.4.1');
  const loginPage = await fetch(`${baseUrl}/login.html`).then((pageResponse) => pageResponse.text());
  assert.match(loginPage, /id="appVersion"/);
});

test('a saved daily output plan replaces the historical average on the executive report', async (t) => {
  const baseUrl = await startServer(t);

  const rejected = await jsonRequest(baseUrl, '/api/production-plan', 'PUT', {
    effectiveDate: '2026-08-04', mswTonsPerDay: -1,
  });
  assert.equal(rejected.response.status, 400);

  const saved = await jsonRequest(baseUrl, '/api/production-plan', 'PUT', {
    effectiveDate: '2026-08-04',
    mswTonsPerDay: 300,
    note: 'แผนทดสอบ',
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.updated, false);

  // The yield in effect is RDF2 20% and RDF2 LG 10%, and RDF3 converts the LG
  // stream at its configured 82.35%.
  const listed = await fetch(`${baseUrl}/api/production-plan?date=2026-08-04`).then((r) => r.json());
  assert.equal(listed.applicable.EffectiveDate, '2026-08-04');
  assert.equal(Number(listed.applicable.MSWTonsPerDay), 300);
  assert.equal(listed.yields.rdf2Pct, 20);
  assert.equal(listed.yields.rdf2LGPct, 10);
  assert.equal(listed.rows[0].derived.rdf2Tons, 60);
  assert.ok(Math.abs(listed.rows[0].derived.rdf3Tons - 24.705) < 0.0001);

  const report = await fetch(`${baseUrl}/api/executive-report?date=2026-08-04`).then((r) => r.json());
  const plan = report.output.plan;
  assert.equal(plan.source, 'manual');
  assert.equal(plan.effectiveDate, '2026-08-04');
  assert.equal(plan.mswTons, 300);
  assert.equal(plan.rdf2Tons, 60);
  assert.equal(plan.rdf2LGTons, 30);
  assert.ok(Math.abs(plan.rdf3Tons - 24.705) < 0.0001);
  assert.equal(plan.rdfAvailable, true);
  assert.equal(plan.rdf3Available, true);

  // A typed-in MSW plan is a per-day number, so the month is that number times
  // the days August actually has rather than the KPI target spread over 28.
  assert.equal(report.targets.source, 'manual');
  assert.equal(report.targets.dailyTons, 300);
  assert.equal(report.targets.weeklyTons, 2100);
  assert.equal(report.targets.monthlyTons, 300 * 31);

  // Aug 1-3 fall before the plan's effective date, so they keep the historical
  // average while Aug 4 uses the numbers derived from the typed-in MSW target.
  assert.ok(Math.abs(plan.mtdRDF2Tons - (160 + 60)) < 0.0001);
  assert.ok(Math.abs(plan.mtdRDF2LGTons - (80 + 30)) < 0.0001);
  assert.ok(Math.abs(plan.mtdRDF3Tons - (3 * 1.647 + 24.705)) < 0.0001);
  assert.ok(Math.abs(plan.averageRDF2Tons - (160 / 3)) < 0.0001);
  assert.equal(plan.basisDays, 3);

  // A day before the plan starts still reads as historical.
  const earlier = await fetch(`${baseUrl}/api/executive-report?date=2026-08-03`).then((r) => r.json());
  assert.equal(earlier.output.plan.source, 'historical');

  const removed = await jsonRequest(baseUrl, `/api/production-plan/${listed.applicable.ID}`, 'DELETE');
  assert.equal(removed.response.status, 200);
  const afterDelete = await fetch(`${baseUrl}/api/executive-report?date=2026-08-04`).then((r) => r.json());
  assert.equal(afterDelete.output.plan.source, 'historical');
  assert.equal(afterDelete.targets.source, 'kpi-target');
  assert.ok(Math.abs(afterDelete.targets.dailyTons - (8000 / 4 / 7)) < 0.0001);
});
