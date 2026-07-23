const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, getError) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server stopped: ${getError()}`);
    try {
      const response = await fetch(`${baseUrl}/api/revenue/dashboard?month=2026-07`);
      if (response.ok) return;
    } catch (_) {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`server did not start: ${getError()}`);
}

test('company revenue dashboard combines sales and tipping estimates', async (t) => {
  const port = await getFreePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf2-revenue-test-'));
  const workbookPath = path.join(tempDir, 'test.xlsx');
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, () => serverError);

  async function post(apiPath, body, expectedStatus = 200) {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    assert.equal(response.status, expectedStatus, responseText);
    return expectedStatus === 200 ? JSON.parse(responseText) : null;
  }

  await post('/api/revenue/customers', { name: 'ลูกค้า A' });
  await post('/api/revenue/customers', { name: 'ลูกค้า B' });
  await post('/api/revenue/customers', { name: 'TPI' });
  await post('/api/revenue/prices', { effectiveDate: '2026-07-01', customer: 'ลูกค้า A', product: 'RDF2', pricePerTon: 1000 });
  await post('/api/revenue/prices', { effectiveDate: '2026-07-01', customer: 'ลูกค้า A', product: 'FineFraction', pricePerTon: 500 });
  await post('/api/revenue/prices', { effectiveDate: '2026-07-01', customer: 'ลูกค้า A', product: 'RDF3', pricePerTon: 1500 });
  await post('/api/revenue/prices', { effectiveDate: '2026-07-01', customer: 'ลูกค้า B', product: 'RDF2', pricePerTon: 800 });
  await post('/api/revenue/prices', { effectiveDate: '2026-07-01', customer: 'TPI', product: 'RDF2', pricePerTon: 190 });
  const legacyYield = await post('/api/yield', { effectiveDate: '2026-06-01', rdf2Pct: 33.32, fineFractionPct: 20, heavyFractionPct: 15, metalPct: 5 });
  assert.equal(legacyYield.row.RDF2Pct, 23.32);
  assert.equal(legacyYield.row.RDF2LGPct, 10);
  await post('/api/yield', { effectiveDate: '2026-07-01', rdf2Pct: 28, rdf2LGPct: 12, fineFractionPct: 20, heavyFractionPct: 15, metalPct: 5 });
  await post('/api/yield', { effectiveDate: '2026-07-08', rdf2Pct: 50, fineFractionPct: 10, heavyFractionPct: 20, metalPct: 5 });
  await post('/api/grab/import', {
    reportDate: '2026-07-06', sourceFile: 'test.csv', replace: true,
    rows: [{ dateTime: '2026-07-06 08:00', weight: 10 }, { dateTime: '2026-07-06 09:00', weight: 20 }],
  });
  await post('/api/grab/import', {
    reportDate: '2026-07-08', sourceFile: 'test.csv', replace: true,
    rows: [{ dateTime: '2026-07-08 08:00', weight: 40 }],
  });
  await post('/api/sales', { saleDate: '2026-07-05', material: 'RDF2', customer: 'ลูกค้า A', tons: 10 });
  await post('/api/sales', { saleDate: '2026-07-06', material: 'FineFraction', customer: 'ลูกค้า A', tons: 2 });
  await post('/api/sales', { saleDate: '2026-07-06', material: 'RDF2', customer: 'ยังไม่ Setup', tons: 1 });
  await post('/api/sales', { saleDate: '2026-07-06', material: 'RDF2', customer: 'TPI', tons: 20 });
  await post('/api/revenue/rdf3-sales', { saleDate: '2026-07-07', customer: 'ลูกค้า A', tons: 4 });
  await post('/api/revenue/rdf3-sales', { saleDate: '2026-07-07', customer: 'ลูกค้าที่ไม่มี', tons: 1 }, 400);
  await post('/api/revenue/tipping-daily', { entryDate: '2026-07-05', mswTons: 320 });
  await post('/api/revenue/tipping-daily', { entryDate: '2026-07-05', mswTons: 300 });
  await post('/api/revenue/tipping-daily', { entryDate: '2026-07-06', mswTons: 100 });
  await post('/api/delivery-plans', { weekStart: '2026-07-06', customer: 'ลูกค้า A', product: 'RDF2', planTons: 6 });
  await post('/api/delivery-plans', { weekStart: '2026-07-06', customer: 'ลูกค้า A', product: 'RDF3', planTons: 5 });
  await post('/api/delivery-plans', { weekStart: '2026-07-06', customer: 'ลูกค้า A', product: 'FineFraction', planTons: 3 });
  await post('/api/delivery-plans', { weekStart: '2026-07-06', customer: 'ลูกค้า B', product: 'RDF2', planTons: 2 });
  await post('/api/delivery-plans', { weekStart: '2026-07-06', customer: 'TPI', product: 'RDF2', planTons: 25 });
  await post('/api/delivery-plans', { weekStart: '2026-07-07', customer: 'ลูกค้า A', product: 'RDF2', planTons: 1 }, 400);

  const response = await fetch(`${baseUrl}/api/revenue/dashboard?month=2026-07`);
  const dashboard = await response.json();
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.sales.base, 20800);
  assert.equal(dashboard.sales.low, 18720);
  assert.ok(Math.abs(dashboard.sales.high - 22880) < 0.001);
  assert.equal(dashboard.sales.unresolvedCount, 1);
  assert.equal(dashboard.sales.byProduct.length, 4);
  assert.equal(dashboard.sales.byProduct.find((row) => row.product === 'RDF2LG').revenue, 3800);
  assert.equal(dashboard.tipping.totalMSW, 400);
  assert.equal(dashboard.tipping.central, 55000);
  assert.equal(dashboard.tipping.low, 50000);
  assert.equal(dashboard.tipping.high, 60000);
  assert.equal(dashboard.company.central, 75800);
  assert.equal(dashboard.company.low, 68720);
  assert.ok(Math.abs(dashboard.company.high - 82880) < 0.001);
  const dailyTipping = dashboard.daily.reduce((sum, row) => sum + row.tippingRevenue, 0);
  assert.ok(Math.abs(dailyTipping - dashboard.tipping.central) < 0.001);

  const dailyResponse = await fetch(`${baseUrl}/api/revenue/tipping-daily?month=2026-07`);
  const dailyRows = await dailyResponse.json();
  assert.equal(dailyRows.rows.length, 2, 'same-day MSW input must update instead of duplicate');

  const planResponse = await fetch(`${baseUrl}/api/delivery-plans/dashboard?weekStart=2026-07-06`);
  const planDashboard = await planResponse.json();
  assert.equal(planDashboard.ok, true);
  assert.equal(planDashboard.weekEnd, '2026-07-12');
  assert.equal(planDashboard.weekEndExclusive, '2026-07-13');
  assert.equal(planDashboard.customers.length, 3);
  const planProducts = Object.fromEntries(planDashboard.customers[0].products.map((row) => [row.product, row]));
  assert.equal(planProducts.RDF2.actualTons, 0, 'Sunday before the week must not count toward Actual');
  assert.equal(planProducts.RDF2.diffTons, -6);
  assert.equal(planProducts.RDF2.opportunityLoss, 6000);
  assert.equal(planProducts.RDF3.actualTons, 4);
  assert.equal(planProducts.RDF3.opportunityLoss, 1500);
  assert.equal(planProducts.FineFraction.actualTons, 2);
  assert.equal(planProducts.FineFraction.opportunityLoss, 500);
  assert.equal(planDashboard.customers[0].opportunityLoss, 8000);
  assert.equal(planDashboard.customers[1].opportunityLoss, 1600);
  const tpiPlan = planDashboard.customers.find((customer) => customer.customer === 'TPI').products[0];
  assert.equal(tpiPlan.product, 'RDF2LG');
  assert.equal(tpiPlan.actualTons, 20);
  assert.equal(tpiPlan.opportunityLoss, 950);
  assert.deepEqual(planDashboard.summary, {
    shortfallTons: 15,
    opportunityLoss: 10550,
    missingPriceCount: 0,
    customerCount: 3,
  });

  const weeklyResponse = await fetch(`${baseUrl}/api/weekly-report?weekStart=2026-07-06`);
  const weekly = await weeklyResponse.json();
  assert.equal(weekly.ok, true);
  assert.deepEqual(weekly.incoming, { totalGrabs: 3, totalTons: 70, avgTonsPerGrab: 70 / 3 });
  assert.equal(weekly.production.calculatedIncomingTons, 70);
  assert.equal(weekly.production.uncalculatedIncomingTons, 0);
  assert.deepEqual(weekly.production.missingYieldDates, []);
  assert.deepEqual(Object.fromEntries(weekly.production.products.map((row) => [row.product, row.tons])), {
    RDF2: 22.4,
    RDF2LG: 9.6,
    FineFraction: 10,
    HeavyFraction: 12.5,
    Water: 12,
  });
  assert.equal(weekly.production.products.some((row) => row.product === 'Metal'), false);
  assert.equal(weekly.sales.transactionCount, 4);
  assert.equal(weekly.sales.totalTons, 27);
  assert.deepEqual(Object.fromEntries(weekly.sales.byProduct.map((row) => [row.product, row.tons])), {
    RDF2: 1,
    RDF2LG: 20,
    RDF3: 4,
    FineFraction: 2,
  });
  assert.equal(weekly.sales.byCustomer.find((row) => row.customer === 'ลูกค้า A').totalTons, 6);
  assert.equal(weekly.sales.byCustomer.find((row) => row.customer === 'ยังไม่ Setup').totalTons, 1);
  assert.equal(weekly.sales.byCustomer.find((row) => row.customer === 'TPI').totalTons, 20);

  const salesResponse = await fetch(`${baseUrl}/api/sales`);
  const salesData = await salesResponse.json();
  assert.equal(salesData.rows.find((row) => row.Customer === 'TPI').Material, 'RDF2LG');
});
