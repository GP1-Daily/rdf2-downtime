const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('inline application scripts have valid JavaScript syntax', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'expected at least one inline script');
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
  }
});

test('monthly revenue donut uses export-safe SVG arcs', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'monthly.css'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'monthly.js'), 'utf8');

  assert.match(html, /id="monthlyRevenueSalesArc"/);
  assert.match(html, /id="monthlyRevenueTippingArc"/);
  assert.match(html, /id="monthlyRevenueSalesArc"[^>]+fill="none"[^>]+stroke="#236bb0"/);
  assert.match(html, /id="monthlyRevenueTippingArc"[^>]+fill="none"[^>]+stroke="#17a35d"/);
  assert.match(script, /salesArc\.setAttribute\('stroke-dasharray'/);
  assert.match(script, /tippingArc\.setAttribute\('stroke-dasharray'/);
  assert.match(css, /\.monthly-revenue-donut\s*{[^}]*conic-gradient/s);
  assert.match(css, /\.monthly-report-export\.exporting \.monthly-revenue-donut svg\s*{\s*display:\s*block/);
  assert.match(html, /monthly\.css\?v=20260814-company-logo/);
  assert.match(html, /monthly\.js\?v=20260814-rdf3-stock/);
  assert.match(html, /onclone:\s*clonedDocument\s*=>/);
  assert.match(html, /important\(label, 'width', '178px'\)/);
});

test('production motion graphics stay with their related settings', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'machines.js'), 'utf8');

  assert.doesNotMatch(html, /machine-process-panel/);
  assert.match(
    html,
    /class="panel rdf2-yield-panel"[\s\S]*?class="industrial-motion rdf2-motion[\s\S]*?id="yieldRDF2"/
  );
  assert.match(
    html,
    /id="rdf3MachineControl"[\s\S]*?id="rdf3LineStage"[\s\S]*?data-stage-machine="MC5"/
  );
  assert.match(script, /stageIndicator\?\.classList\.toggle\('is-on', Boolean\(isOn\)\)/);
  assert.match(script, /lineStage\?\.classList\.toggle\('is-running', onMachines\.length > 0\)/);
  assert.match(script, /lineStatus\.textContent = onMachines\.length > 0/);
});
