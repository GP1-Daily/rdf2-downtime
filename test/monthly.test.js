const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp1-monthly-test-'));
const workbookPath = path.join(tempDir, 'monthly.xlsx');
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
      const response = await fetch(`${baseUrl}/login.html`);
      if (response.ok) return baseUrl;
    } catch (_) {
      // Server is still starting.
    }
    if (attempt === 299) throw new Error(`server did not start: ${serverError}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${serverError}`);
}

function line(entryDate, eventType, time, stopType = '') {
  return { EntryDate: entryDate, EventType: eventType, Time: time, StopType: stopType, Note: '' };
}

function downtime(entryDate, startTime, endTime, reason) {
  return { EntryDate: entryDate, StartTime: startTime, EndTime: endTime, Reason: reason, Note: '' };
}

function grab(id, dateTime, weight) {
  return {
    ReportDate: dateTime.slice(0, 10),
    DateTime: dateTime,
    Weight: weight,
    SourceSystem: 'grab-pi-1',
    SourceID: id,
    SyncedAt: '2026-08-02T03:00:00.000Z',
  };
}

function legacyCsvGrab(dateTime, weight) {
  return {
    ReportDate: dateTime.slice(0, 10),
    DateTime: dateTime,
    Weight: weight,
    SourceFile: 'legacy-july.csv',
  };
}

test('monthly report uses calendar boundaries and combines operations, production, sales and revenue', async (t) => {
  await store.appendRows('LineTime', [
    line('2026-07-31', 'Start', '20:00'),
    line('2026-08-01', 'Stop', '02:00', 'break'),
    line('2026-08-02', 'Start', '08:00'),
    line('2026-08-02', 'Stop', '10:00', 'end'),
  ]);
  await store.appendRows('Downtime', [
    downtime('2026-07-31', '23:30', '00:30', 'พักกะดึก'),
    downtime('2026-08-02', '08:40', '09:00', 'Plug Spinner'),
  ]);
  await store.appendRows('GrabCrane', [
    grab(1, '2026-07-31 23:50:00', 99),
    legacyCsvGrab('2026-08-01 00:10:00', 10),
    legacyCsvGrab('2026-08-01 01:50:00', 10),
    grab(4, '2026-08-02 08:10:00', 15),
    grab(5, '2026-08-02 09:50:00', 15),
    grab(6, '2026-09-01 08:00:00', 88),
  ]);
  await store.appendRows('YieldSettings', [{
    EffectiveDate: '2026-08-01',
    RDF2Pct: 20,
    RDF2LGPct: 10,
    FineFractionPct: 30,
    HeavyFractionPct: 20,
    MetalPct: 5,
  }]);
  await store.appendRows('Sales', [
    { SaleDate: '2026-07-31', Material: 'RDF2', Customer: 'Customer A', Tons: 99, Note: '' },
    { SaleDate: '2026-08-01', Material: 'RDF2', Customer: 'Customer A', Tons: 10, Note: '' },
  ]);
  await store.appendRows('RevenueRDF3Sales', [
    { SaleDate: '2026-08-02', Customer: 'Customer A', Tons: 5, Note: '' },
  ]);
  await store.appendRows('RevenuePrices', [
    { EffectiveDate: '2026-08-01', Customer: 'Customer A', Product: 'RDF2', PricePerTon: 1000 },
    { EffectiveDate: '2026-08-01', Customer: 'Customer A', Product: 'RDF3', PricePerTon: 1500 },
  ]);
  await store.appendRows('RevenueTippingDaily', [
    { EntryDate: '2026-08-01', MSWTons: 100, Note: '' },
  ]);
  await store.appendRows('RevenueTippingSettings', [{
    EffectiveDate: '2026-08-01',
    RatePerTon: 250,
    ExcludedCentralTons: 0,
    ExcludedMinTons: 0,
    ExcludedMaxTons: 0,
  }]);
  await store.appendRows('KPIDailyHistory', [
    { EntryDate: '2026-08-02', MSWTons: 999, Source: 'legacy-import' },
    { EntryDate: '2026-08-03', MSWTons: 40, Source: 'legacy-import' },
  ]);
  await store.appendRows('DieselMachines', [
    { Name: 'Wheel Loader', Active: true, DailyLimitLiters: 100 },
    { Name: 'Excavator', Active: true, DailyLimitLiters: 50 },
  ]);
  await store.appendRows('DieselUsage', [
    { EntryDate: '2026-08-01', Machine: 'Wheel Loader', Liters: 90, Note: '' },
    { EntryDate: '2026-08-02', Machine: 'Excavator', Liters: 40, Note: '' },
  ]);
  await store.appendRows('DieselStockBaselines', [
    { EffectiveDate: '2026-08-01', OpeningLiters: 1000, Note: '' },
  ]);
  await store.appendRows('DieselReceipts', [
    { EntryDate: '2026-08-02', Liters: 200, Reference: 'PO-001', Note: '' },
  ]);

  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/monthly-report?month=2026-08`);
  assert.equal(response.status, 200);
  const report = await response.json();

  assert.equal(report.startDate, '2026-08-01');
  assert.equal(report.endDate, '2026-08-31');
  assert.deepEqual(report.incoming, {
    totalGrabs: 4,
    totalTons: 90,
    avgTonsPerGrab: 12.5,
    detailedTons: 50,
    historicalTons: 40,
    historicalDays: 1,
  });
  assert.deepEqual(report.production.products.map((row) => row.product), ['RDF2', 'RDF2LG', 'RDF3', 'FineFraction']);
  assert.deepEqual(Object.fromEntries(report.production.products.map((row) => [row.product, row.tons])), {
    RDF2: 18,
    RDF2LG: 9,
    RDF3: 0,
    FineFraction: 27,
  });
  for (const excluded of ['HeavyFraction', 'Metal', 'Water']) {
    assert.equal(report.production.products.some((row) => row.product === excluded), false);
  }

  assert.equal(report.operations.lineMinutes, 240);
  assert.equal(report.operations.productionMinutes, 100);
  assert.equal(report.operations.downtimeMinutes, 50);
  assert.equal(report.operations.netRunMinutes, 80);
  assert.ok(Math.abs(report.operations.availabilityPct - 80) < 0.0001);
  assert.deepEqual(report.operations.reasonTotals.map((row) => [row.reason, row.count, row.minutes]), [
    ['พักกะดึก', 1, 30],
    ['Plug Spinner', 1, 20],
  ]);

  assert.equal(report.sales.transactionCount, 2);
  assert.equal(report.sales.totalTons, 15);
  assert.equal(report.sales.byCustomer[0].totalTons, 15);
  assert.equal(report.revenue.sales.base, 17500);
  assert.equal(report.revenue.tipping.central, 25000);
  assert.equal(report.revenue.company.central, 42500);
  const august1 = report.daily.find((row) => row.date === '2026-08-01');
  assert.equal(august1.downtimeMinutes, 30);
  assert.equal(august1.incomingTons, 20);
  assert.equal(august1.incomingSource, 'csv');
  const august2 = report.daily.find((row) => row.date === '2026-08-02');
  assert.equal(august2.downtimeMinutes, 20);
  assert.equal(august2.incomingTons, 30);
  assert.equal(august2.incomingSource, 'automatic');
  const august3 = report.daily.find((row) => row.date === '2026-08-03');
  assert.equal(august3.incomingTons, 40);
  assert.equal(august3.incomingSource, 'history');
  assert.equal(report.weeks.reduce((sum, row) => sum + row.incomingTons, 0), 90);
  assert.equal(report.weeks.reduce((sum, row) => sum + row.historicalDays, 0), 1);
  assert.equal(report.diesel.totalLiters, 130);
  assert.equal(report.diesel.totalLimitLiters, 150);
  assert.ok(Math.abs(report.diesel.utilizationPct - (130 / 150 * 100)) < 0.0001);
  assert.deepEqual(report.diesel.byMachine.map((row) => [row.machine, row.liters, row.limitLiters]), [
    ['Wheel Loader', 90, 100],
    ['Excavator', 40, 50],
  ]);
  assert.equal(report.diesel.stock.periodReceivedLiters, 200);
  assert.equal(report.diesel.stock.balanceLiters, 1070);

  const invalidResponse = await fetch(`${baseUrl}/api/monthly-report?month=08-2026`);
  assert.equal(invalidResponse.status, 400);
  assert.equal((await fetch(`${baseUrl}/monthly.js`)).status, 200);
  const page = await fetch(`${baseUrl}/`).then((pageResponse) => pageResponse.text());
  assert.match(page, /id="tab-monthly-report"/);

  const emptyRevenue = await fetch(`${baseUrl}/api/revenue/dashboard?month=2026-06`).then((item) => item.json());
  assert.equal(emptyRevenue.company.central, 0);
  assert.equal(emptyRevenue.company.salesSharePct, 0);
  assert.equal(emptyRevenue.company.tippingSharePct, 0);
});
