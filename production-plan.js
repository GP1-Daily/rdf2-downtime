(() => {
  let initialized = false;
  let loadingPromise = null;

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

  function renderTotals() {
    const rdf2 = number(element('planRDF2')?.value);
    const rdf2LG = number(element('planRDF2LG')?.value);
    const rdf3 = number(element('planRDF3')?.value);
    element('planDailyTotal').textContent = `${format(rdf2 + rdf2LG)} ตัน/วัน`;
    element('planMonthlyTotal').textContent = `${format((rdf2 + rdf2LG) * 30)} ตัน/30 วัน`;
    element('planRDF3Total').textContent = `${format(rdf3)} ตัน/วัน`;
  }

  function render(data) {
    const applicable = data.applicable;
    element('productionPlanApplied').textContent = applicable
      ? `มีผลตั้งแต่ ${applicable.EffectiveDate}`
      : 'ยังไม่ได้ตั้งแผน — หน้า Daily Report ใช้ค่าเฉลี่ยย้อนหลังไปก่อน';

    const form = applicable || {
      EffectiveDate: data.date, RDF2TonsPerDay: 0, RDF2LGTonsPerDay: 0, RDF3TonsPerDay: 0, Note: '',
    };
    element('planEffectiveDate').value = form.EffectiveDate || data.date;
    element('planRDF2').value = number(form.RDF2TonsPerDay).toFixed(2);
    element('planRDF2LG').value = number(form.RDF2LGTonsPerDay).toFixed(2);
    element('planRDF3').value = number(form.RDF3TonsPerDay).toFixed(2);
    element('planNote').value = form.Note || '';
    renderTotals();

    const rows = Array.isArray(data.rows) ? data.rows : [];
    element('productionPlanHistory').innerHTML = rows.length
      ? rows.map((row) => `<tr>
          <td>${escapeHtml(row.EffectiveDate)}</td>
          <td>${format(row.RDF2TonsPerDay)}</td>
          <td>${format(row.RDF2LGTonsPerDay)}</td>
          <td>${format(row.RDF3TonsPerDay)}</td>
          <td class="left">${escapeHtml(row.Note || '')}</td>
          <td><button class="danger" data-plan-id="${escapeHtml(row.ID)}">ลบ</button></td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty-note">ยังไม่มีแผนที่บันทึกไว้</td></tr>';

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
        rdf2TonsPerDay: number(element('planRDF2').value),
        rdf2LGTonsPerDay: number(element('planRDF2LG').value),
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
    for (const id of ['planRDF2', 'planRDF2LG', 'planRDF3']) {
      element(id)?.addEventListener('input', renderTotals);
    }
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
