(() => {
  let initialized = false;
  let loadingPromise = null;
  let currentYields = { rdf2Pct: 0, rdf2LGPct: 0, yieldConfigured: false };

  function element(id) {
    return document.getElementById(id);
  }

  function number(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function format(value, digits = 2) {
    return number(value).toLocaleString('th-TH', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function today() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  // Daily Report opens on yesterday, while this panel opens on today, so a plan
  // saved without touching the date field covers nothing the report is showing.
  function reportDefaultDate() {
    const now = new Date();
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  }

  function thaiDate(date) {
    return new Date(`${date}T12:00:00+07:00`).toLocaleDateString('th-TH', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  // Silent when the plan already covers the date Daily Report opens on; it only
  // speaks up for the case that silently falls back to the historical average.
  function renderCoverage(rows) {
    const coverage = element('productionPlanCoverage');
    if (!coverage) return;
    coverage.textContent = '';
    coverage.classList.remove('warn');
    const reportDate = reportDefaultDate();
    const usable = rows.filter(
      (row) => number(row.MSWTonsPerDay) > 0 || number(row.RDF3TonsPerDay) > 0,
    );
    if (!usable.length) return;
    if (usable.some((row) => String(row.EffectiveDate) <= reportDate)) return;
    const earliest = usable.map((row) => String(row.EffectiveDate)).sort()[0];
    coverage.classList.add('warn');
    coverage.textContent = `แผนที่บันทึกไว้เริ่มมีผล ${thaiDate(earliest)} ซึ่งยังไม่ครอบคลุมวันที่ ${thaiDate(reportDate)} ที่หน้า Daily Report เปิดมาเป็นค่าเริ่มต้น — เลือกวันที่รายงานตั้งแต่ ${thaiDate(earliest)} เป็นต้นไป หรือแก้วันที่เริ่มมีผลให้ย้อนกว่านี้`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function setStatus(message, error = false) {
    const status = element('productionPlanStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', Boolean(error));
  }

  // Mirrors productionPlanOutputs on the server so typing an MSW figure shows
  // the product lines it implies before anything is saved. RDF3 is typed, not
  // derived; its share of the LG stream is shown only as a sanity check.
  function renderTotals() {
    const msw = number(element('planMSW')?.value);
    const rdf3 = number(element('planRDF3')?.value);
    const rdf2LG = msw * currentYields.rdf2LGPct / 100;
    element('planMSWDaily').textContent = `${format(msw)} ตัน/วัน`;
    element('planMonthlyTotal').textContent = `${format(msw * 30)} ตัน`;
    element('planRDF2Label').textContent = `RDF2 (${format(currentYields.rdf2Pct)}%)`;
    element('planRDF2LGLabel').textContent = `RDF2 LG (${format(currentYields.rdf2LGPct)}%)`;
    element('planRDF3Label').textContent = rdf2LG > 0
      ? `RDF3 (คิดเป็น ${format(rdf3 / rdf2LG * 100)}% ของ LG)`
      : 'RDF3';
    element('planRDF2').textContent = `${format(msw * currentYields.rdf2Pct / 100)} ตัน/วัน`;
    element('planRDF2LG').textContent = `${format(rdf2LG)} ตัน/วัน`;
    element('planRDF3Display').textContent = `${format(rdf3)} ตัน/วัน`;
  }

  function render(data) {
    const applicable = data.applicable;
    currentYields = data.yields || currentYields;
    const form = applicable
      || { EffectiveDate: data.date, MSWTonsPerDay: 0, RDF3TonsPerDay: 0, Note: '' };
    element('planEffectiveDate').value = form.EffectiveDate || data.date;
    element('planMSW').value = number(form.MSWTonsPerDay).toFixed(2);
    element('planRDF3').value = number(form.RDF3TonsPerDay).toFixed(2);
    element('planNote').value = form.Note || '';
    renderTotals();

    const rows = Array.isArray(data.rows) ? data.rows : [];
    renderCoverage(rows);
    element('productionPlanHistory').innerHTML = rows.length
      ? rows.map((row) => `<tr>
          <td>${escapeHtml(row.EffectiveDate)}</td>
          <td>${format(row.MSWTonsPerDay)}</td>
          <td>${format(row.derived?.rdf2Tons)}</td>
          <td>${format(row.derived?.rdf2LGTons)}</td>
          <td>${format(row.derived?.rdf3Tons)}</td>
          <td class="left">${escapeHtml(row.Note || '')}</td>
          <td><button class="danger" data-plan-id="${escapeHtml(row.ID)}">ลบ</button></td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="empty-note">ยังไม่มีแผนที่บันทึกไว้</td></tr>';

    if (!currentYields.yieldConfigured) {
      setStatus(`ยังไม่ได้ตั้ง Yield ที่มีผลกับวันที่ ${data.date} — RDF2 · RDF2 LG · RDF3 คำนวณไม่ได้`, true);
      return;
    }
    setStatus(applicable
      ? `แผนที่ใช้กับวันที่ ${data.date} คือชุดที่มีผลตั้งแต่ ${applicable.EffectiveDate}`
      : `ยังไม่มีแผนที่มีผลกับวันที่ ${data.date}`);
  }

  async function loadPlans() {
    if (loadingPromise) return loadingPromise;
    const date = element('planEffectiveDate')?.value || today();
    loadingPromise = window.api(`/api/production-plan?date=${encodeURIComponent(date)}`)
      .then((data) => render(data))
      .catch((error) => {
        setStatus(error.message, true);
        throw error;
      })
      .finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  async function savePlan() {
    const effectiveDate = element('planEffectiveDate').value;
    if (!effectiveDate) throw new Error('กรุณาระบุวันที่เริ่มใช้แผน');
    await window.api('/api/production-plan', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        effectiveDate,
        mswTonsPerDay: number(element('planMSW').value),
        rdf3TonsPerDay: number(element('planRDF3').value),
        note: element('planNote').value,
      }),
    });
    window.toast('บันทึกเป้าผลผลิตรายวันแล้ว');
    await loadPlans();
  }

  function bindEvents() {
    element('btnSaveProductionPlan')?.addEventListener('click', () => {
      savePlan().catch((error) => window.toast(error.message, true));
    });
    element('planEffectiveDate')?.addEventListener('change', () => {
      loadPlans().catch((error) => window.toast(error.message, true));
    });
    element('planMSW')?.addEventListener('input', renderTotals);
    element('planRDF3')?.addEventListener('input', renderTotals);
    element('productionPlanHistory')?.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-plan-id]');
      if (!button || button.disabled) return;
      if (!window.confirm('ลบแผนชุดนี้ใช่หรือไม่')) return;
      button.disabled = true;
      try {
        await window.api(`/api/production-plan/${encodeURIComponent(button.dataset.planId)}`, { method: 'DELETE' });
        window.toast('ลบแผนแล้ว');
        await loadPlans();
      } catch (error) {
        button.disabled = false;
        window.toast(error.message, true);
      }
    });
  }

  window.initProductionPlan = async function initProductionPlan() {
    if (!initialized) {
      initialized = true;
      element('planEffectiveDate').value ||= today();
      bindEvents();
    }
    return loadPlans();
  };
})();
