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

async function waitForServer(baseUrl, child, getError) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server stopped: ${getError()}`);
    try {
      const response = await fetch(`${baseUrl}/api/kpi/dashboard?period=2026-06`);
      if (response.ok) return;
    } catch (_) {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`server did not start: ${getError()}`);
}

test('monthly KPI uses live operational data and evaluates the 21-20 period', async (t) => {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf2-kpi-test-'));
  const workbookPath = path.join(tempDir, 'test.xlsx');
  let serverError = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATABASE_URL: '', RDF2_XLSX_PATH: workbookPath },
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

  async function request(apiPath, method = 'GET', body) {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.ok, true, JSON.stringify(data));
    return data;
  }

  await request('/api/sales', 'POST', {
    saleDate: '2026-06-21', material: 'RDF2', customer: 'Customer A', tons: 40,
  });
  await request('/api/sales', 'POST', {
    saleDate: '2026-06-22', material: 'FineFraction', customer: 'Customer A', tons: 5,
  });
  await request('/api/revenue/customers', 'POST', { name: 'Customer A' });
  await request('/api/revenue/rdf3-sales', 'POST', {
    saleDate: '2026-06-21', customer: 'Customer A', tons: 60,
  });
  await request('/api/grab/import', 'POST', {
    reportDate: '2026-06-21', sourceFile: 'grab.csv', replace: true,
    rows: [{ dateTime: '2026-06-21 08:00', weight: 250 }],
  });
  await request('/api/kpi/targets', 'POST', {
    effectiveDate: '2026-06-21',
    rdf2Target: 40,
    rdf3Target: 60,
    fineFractionTarget: 5,
    mswTarget: 250,
    complaintLimit: 2,
  });
  await request('/api/kpi/complaints', 'POST', {
    entryDate: '2026-06-22', customer: 'Customer A', detail: 'Late delivery',
  });

  const dashboard = await request('/api/kpi/dashboard?period=2026-06');
  assert.equal(dashboard.selected.startDate, '2026-06-21');
  assert.equal(dashboard.selected.endDate, '2026-07-20');
  assert.deepEqual(dashboard.selected.actual, {
    rdf2: 40,
    rdf3: 60,
    fineFraction: 5,
    msw: 250,
    complaints: 1,
  });
  assert.equal(dashboard.selected.passedCount, 5, 'meeting a delivery target exactly must pass');
  assert.equal(dashboard.selected.complaints.length, 1);
  assert.equal(dashboard.history.length, 6);

  await request('/api/kpi/complaints', 'POST', {
    entryDate: '2026-07-01', customer: 'Customer B', detail: 'Product quality',
  });
  const withSecondComplaint = await request('/api/kpi/dashboard?period=2026-06');
  assert.equal(withSecondComplaint.selected.actual.complaints, 2);
  assert.equal(withSecondComplaint.selected.passedCount, 4, 'complaints must stay below the configured limit');
});
