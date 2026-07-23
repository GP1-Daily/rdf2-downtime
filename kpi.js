(() => {
  const metricLabels = {
    rdf2: 'RDF2 Delivery',
    rdf2LG: 'RDF2 LG Delivery',
    rdf3: 'RDF3 Delivery',
    fineFraction: 'Fine Fraction Delivery',
    msw: 'MSW to Production',
    complaints: 'Customer Complaints',
  };
  let loadedOnce = false;
  let latestDashboard = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function number(value, digits = 2) {
    return Number(value || 0).toLocaleString('th-TH', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function thaiDate(date, options = {}) {
    if (!date) return '-';
    return new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
      day: 'numeric', month: 'short', year: 'numeric', ...options,
    });
  }

  function currentKPIPeriod() {
    const now = new Date();
    if (now.getDate() < 21) now.setMonth(now.getMonth() - 1);
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function shiftPeriod(period, offset) {
    const [year, month] = period.split('-').map(Number);
    const date = new Date(year, month - 1 + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function metricValue(metric) {
    const digits = metric.key === 'complaints' ? 0 : 2;
    return `${number(metric.actual, digits)} <small>${metric.unit}</small>`;
  }

  function metricTarget(metric) {
    const digits = metric.key === 'complaints' ? 0 : 2;
    if (!metric.tracked) return 'ยังไม่ได้ตั้งเป้าหมาย';
    return metric.limit
      ? `เป้าหมาย: น้อยกว่า ${number(metric.target, digits)} ${metric.unit}`
      : `เป้าหมาย: ${number(metric.target, digits)} ${metric.unit}`;
  }

  function renderMetrics(selected) {
    document.getElementById('kpiMetricGrid').innerHTML = selected.metrics.map((metric) => {
      const progress = Math.min(100, Math.max(0, Number(metric.completionPct) || 0));
      const status = !metric.tracked ? 'NO TARGET' : metric.achieved ? 'PASS' : (metric.limit ? 'ABOVE LIMIT' : 'BELOW TARGET');
      return `<article class="monthly-kpi-metric ${escapeHtml(metric.key)}">
        <div class="monthly-kpi-metric-name">${escapeHtml(metric.label)}</div>
        <div class="monthly-kpi-metric-value">${metricValue(metric)}</div>
        <div class="monthly-kpi-metric-target">${metricTarget(metric)}</div>
        <div class="monthly-kpi-progress"><span style="width:${progress}%"></span></div>
        <div class="monthly-kpi-metric-status ${metric.achieved ? 'pass' : ''} ${!metric.tracked ? 'untracked' : ''}">${status}</div>
      </article>`;
    }).join('');
  }

  function renderHistory(history) {
    document.getElementById('kpiHistoryHead').innerHTML = `<tr><th>KPI</th>${history.map((period) =>
      `<th>${escapeHtml(thaiDate(period.startDate, { day: 'numeric', month: 'short' }))}<br>${escapeHtml(thaiDate(period.endDate, { day: 'numeric', month: 'short' }))}</th>`
    ).join('')}</tr>`;
    document.getElementById('kpiHistoryBody').innerHTML = Object.keys(metricLabels).map((key) => {
      const cells = history.map((period) => {
        const metric = period.metrics.find((item) => item.key === key);
        const digits = key === 'complaints' ? 0 : 2;
        const target = metric.tracked ? `เป้า ${number(metric.target, digits)}` : 'ยังไม่ตั้งเป้า';
        return `<td><span class="kpi-history-value"><i class="kpi-history-status ${metric.achieved ? 'pass' : ''} ${!metric.tracked ? 'untracked' : ''}"></i>${number(metric.actual, digits)}</span><span class="kpi-history-target">${target}</span></td>`;
      }).join('');
      return `<tr><td>${escapeHtml(metricLabels[key])}</td>${cells}</tr>`;
    }).join('');
  }

  function renderComplaints(selected) {
    const rows = selected.complaints || [];
    document.getElementById('kpiComplaintSummary').textContent = `${rows.length} เรื่อง`;
    document.getElementById('kpiComplaintExportList').innerHTML = rows.length
      ? rows.map((row) => `<div class="kpi-complaint-export-row">
          <span>${escapeHtml(thaiDate(row.EntryDate, { year: undefined }))}</span>
          <strong>${escapeHtml(row.Customer || 'ไม่ระบุลูกค้า')}</strong>
          <span>${escapeHtml(row.Detail)}</span>
        </div>`).join('')
      : '<div class="kpi-no-complaint">ไม่พบข้อร้องเรียนในรอบนี้</div>';

    const tbody = document.getElementById('kpiComplaintTable');
    tbody.innerHTML = rows.length ? '' : '<tr><td colspan="4" class="empty-note">ไม่มีข้อร้องเรียนในรอบนี้</td></tr>';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(row.EntryDate)}</td><td class="left">${escapeHtml(row.Customer || '-')}</td><td class="left">${escapeHtml(row.Detail)}</td><td><button class="danger">ลบ</button></td>`;
      tr.querySelector('button').addEventListener('click', async () => {
        if (!confirm('ลบข้อร้องเรียนรายการนี้หรือไม่?')) return;
        try {
          await api(`/api/kpi/complaints/${row.ID}`, { method: 'DELETE' });
          await loadDashboard();
          toast('ลบข้อร้องเรียนแล้ว');
        } catch (error) { toast(error.message, true); }
      });
      tbody.appendChild(tr);
    });
  }

  function setTargetForm(target, startDate) {
    document.getElementById('kpiTargetDate').value = startDate;
    document.getElementById('kpiTargetRDF2').value = target.rdf2;
    document.getElementById('kpiTargetRDF2LG').value = target.rdf2LG;
    document.getElementById('kpiTargetRDF3').value = target.rdf3;
    document.getElementById('kpiTargetFine').value = target.fineFraction;
    document.getElementById('kpiTargetMSW').value = target.msw;
    document.getElementById('kpiTargetComplaint').value = target.complaints;
  }

  function renderDashboard(data) {
    latestDashboard = data;
    const selected = data.selected;
    document.getElementById('kpiPeriodLabel').textContent = `${thaiDate(selected.startDate)} - ${thaiDate(selected.endDate)}`;
    document.getElementById('kpiScoreValue').textContent = `${selected.passedCount}/${selected.totalCount}`;
    document.getElementById('kpiScoreRing').style.setProperty('--score-angle', `${selected.passedCount / Math.max(selected.totalCount, 1) * 360}deg`);
    const status = document.getElementById('kpiOverallStatus');
    status.className = 'kpi-overview-status';
    if (selected.passedCount === selected.totalCount) {
      status.textContent = 'ผ่านเป้าหมายครบทุกตัว';
      status.classList.add('good');
    } else if (selected.passedCount >= Math.ceil(selected.totalCount / 2)) {
      status.textContent = `ผ่าน ${selected.passedCount} จาก ${selected.totalCount} ตัวชี้วัด`;
      status.classList.add('warn');
    } else {
      status.textContent = `ผ่าน ${selected.passedCount} จาก ${selected.totalCount} ตัวชี้วัด`;
      status.classList.add('bad');
    }
    document.getElementById('kpiSourceStatus').textContent = `ข้อมูลระบบหลัก ${selected.source.liveDays} วัน · ข้อมูลย้อนหลัง ${selected.source.historyDays} วัน`;
    document.getElementById('kpiAsOfDate').textContent = thaiDate(todayStr());
    renderMetrics(selected);
    renderHistory(data.history);
    renderComplaints(selected);
    setTargetForm(selected.target, selected.startDate);
  }

  async function loadDashboard() {
    const period = document.getElementById('kpiPeriod').value || currentKPIPeriod();
    const data = await api(`/api/kpi/dashboard?period=${encodeURIComponent(period)}`);
    renderDashboard(data);
    return data;
  }

  async function loadTargets() {
    const data = await api('/api/kpi/targets');
    const tbody = document.getElementById('kpiTargetTable');
    tbody.innerHTML = data.rows.length ? '' : '<tr><td colspan="8" class="empty-note">กำลังใช้ค่าเป้าหมายเริ่มต้นของระบบ</td></tr>';
    data.rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(row.EffectiveDate)}</td><td>${number(row.RDF2Target)}</td><td>${number(row.RDF2LGTarget)}</td><td>${number(row.RDF3Target)}</td><td>${number(row.FineFractionTarget)}</td><td>${number(row.MSWTarget)}</td><td>&lt; ${number(row.ComplaintLimit, 0)}</td><td><button class="danger">ลบ</button></td>`;
      tr.querySelector('button').addEventListener('click', async () => {
        if (!confirm('ลบชุดเป้าหมายนี้หรือไม่?')) return;
        try {
          await api(`/api/kpi/targets/${row.ID}`, { method: 'DELETE' });
          await Promise.all([loadTargets(), loadDashboard()]);
          toast('ลบค่าเป้าหมายแล้ว');
        } catch (error) { toast(error.message, true); }
      });
      tbody.appendChild(tr);
    });
  }

  async function loadCustomerOptions() {
    const data = await api('/api/revenue/customers');
    document.getElementById('kpiComplaintCustomerList').innerHTML = data.rows
      .filter((row) => row.Active !== false && row.Active !== 'false')
      .map((row) => `<option value="${escapeHtml(row.Name)}"></option>`).join('');
  }

  async function refreshAll() {
    await Promise.all([loadDashboard(), loadTargets(), loadCustomerOptions()]);
  }

  onClickGuarded(document.getElementById('btnLoadKPI'), async () => {
    try { await loadDashboard(); } catch (error) { toast(error.message, true); }
  });

  document.getElementById('btnKPIPrevious').addEventListener('click', async () => {
    const input = document.getElementById('kpiPeriod');
    input.value = shiftPeriod(input.value || currentKPIPeriod(), -1);
    try { await loadDashboard(); } catch (error) { toast(error.message, true); }
  });

  document.getElementById('btnKPINext').addEventListener('click', async () => {
    const input = document.getElementById('kpiPeriod');
    input.value = shiftPeriod(input.value || currentKPIPeriod(), 1);
    try { await loadDashboard(); } catch (error) { toast(error.message, true); }
  });

  document.getElementById('kpiPeriod').addEventListener('change', () => {
    loadDashboard().catch((error) => toast(error.message, true));
  });

  onClickGuarded(document.getElementById('btnSaveKPIComplaint'), async () => {
    const entryDate = document.getElementById('kpiComplaintDate').value;
    const customer = document.getElementById('kpiComplaintCustomer').value.trim();
    const detail = document.getElementById('kpiComplaintDetail').value.trim();
    if (!entryDate || !detail) { toast('กรุณาระบุวันที่และรายละเอียดข้อร้องเรียน', true); return; }
    try {
      await api('/api/kpi/complaints', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryDate, customer, detail }),
      });
      document.getElementById('kpiComplaintDetail').value = '';
      await loadDashboard();
      toast('บันทึกข้อร้องเรียนแล้ว');
    } catch (error) { toast(error.message, true); }
  });

  onClickGuarded(document.getElementById('btnSaveKPITarget'), async () => {
    const body = {
      effectiveDate: document.getElementById('kpiTargetDate').value,
      rdf2Target: document.getElementById('kpiTargetRDF2').value,
      rdf2LGTarget: document.getElementById('kpiTargetRDF2LG').value,
      rdf3Target: document.getElementById('kpiTargetRDF3').value,
      fineFractionTarget: document.getElementById('kpiTargetFine').value,
      mswTarget: document.getElementById('kpiTargetMSW').value,
      complaintLimit: document.getElementById('kpiTargetComplaint').value,
    };
    try {
      await api('/api/kpi/targets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      await Promise.all([loadTargets(), loadDashboard()]);
      toast('บันทึกเป้าหมาย KPI แล้ว');
    } catch (error) { toast(error.message, true); }
  });

  onClickGuarded(document.getElementById('btnExportKPI'), async () => {
    const area = document.getElementById('kpiExportArea');
    try {
      if (!latestDashboard) await loadDashboard();
      if (document.fonts?.ready) await document.fonts.ready;
      const capture = await ensureHtml2Canvas();
      area.classList.add('exporting');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = await capture(area, {
        scale: 2,
        backgroundColor: '#f8fafc',
        logging: false,
        useCORS: true,
        windowWidth: 1220,
      });
      const link = document.createElement('a');
      link.download = `GP1-Monthly-KPI-${document.getElementById('kpiPeriod').value}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast('ดาวน์โหลดภาพ Monthly KPI แล้ว');
    } catch (error) {
      toast(`ไม่สามารถ Export ภาพได้: ${error.message}`, true);
    } finally {
      area.classList.remove('exporting');
    }
  });

  document.getElementById('kpiPeriod').value = currentKPIPeriod();
  document.getElementById('kpiComplaintDate').value = todayStr();
  document.getElementById('kpiTargetDate').value = `${currentKPIPeriod()}-21`;
  function loadKPIOnce() {
    if (loadedOnce) return;
    loadedOnce = true;
    refreshAll().catch((error) => toast(error.message, true));
  }
  document.addEventListener('gp1:tabchange', (event) => {
    if (event.detail?.tab === 'kpi') loadKPIOnce();
  });
  if (document.getElementById('tab-kpi').classList.contains('active')) loadKPIOnce();
})();
