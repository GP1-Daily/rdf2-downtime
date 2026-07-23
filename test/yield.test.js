const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const ExcelJS = require('exceljs');

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
      const response = await fetch(`${baseUrl}/api/yield`);
      if (response.ok) return;
    } catch (_) {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`server did not start: ${getError()}`);
}

async function createLegacyWorkbook(workbookPath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('YieldSettings');
  sheet.addRow(['ID', 'EffectiveDate', 'RDF2Pct', 'FineFractionPct', 'HeavyFractionPct', 'MetalPct', 'CreatedAt']);
  sheet.addRow([1, '2026-07-01', 33.32, 20, 15, 5, '2026-07-01T00:00:00.000Z']);
  await workbook.xlsx.writeFile(workbookPath);
}

test('legacy RDF2 yield is split into normal and low grade exactly once', async (t) => {
  const port = await getFreePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf2-yield-test-'));
  const workbookPath = path.join(tempDir, 'legacy.xlsx');
  await createLegacyWorkbook(workbookPath);

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

  const first = await (await fetch(`${baseUrl}/api/yield`)).json();
  assert.equal(Number(first.rows[0].RDF2Pct), 23.32);
  assert.equal(Number(first.rows[0].RDF2LGPct), 10);

  const second = await (await fetch(`${baseUrl}/api/yield`)).json();
  assert.equal(Number(second.rows[0].RDF2Pct), 23.32);
  assert.equal(Number(second.rows[0].RDF2LGPct), 10);

  const migratedWorkbook = new ExcelJS.Workbook();
  await migratedWorkbook.xlsx.readFile(workbookPath);
  const row = migratedWorkbook.getWorksheet('YieldSettings').getRow(2);
  assert.equal(migratedWorkbook.getWorksheet('YieldSettings').getRow(1).getCell(8).value, 'RDF2LGPct');
  assert.equal(Number(row.getCell(3).value), 23.32);
  assert.equal(Number(row.getCell(8).value), 10);
});
