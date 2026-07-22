(() => {
  let lastLoadedAt = 0;

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function num(value, digits = 2) {
    return Number(value || 0).toLocaleString('th-TH', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function minutes(value) {
    const total = Math.max(0, Math.round(Number(value) || 0));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return hours ? `${hours} ชม. ${mins} น.` : `${mins} นาที`;
  }

  function mondayFor(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function kpiPeriodFor(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    if (date.getDate() < 21) date.setMonth(date.getMonth() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function thaiDate(dateString) {
    return new Date(`${dateString}T00:00:00`).toLocaleDateString('th-TH', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function monthLabel(month) {
    return new Date(`${month}-01T00:00:00`).toLocaleDateString('th-TH', {
      month: 'long', year: 'numeric',
    });
  }

  function successful(result) {
    return result.status === 'fulfilled' ? result.value : null;
  }

  function renderKPI(data) {
    const selected = data.selected;
    const ring = document.getElementById('homeKPIRing');
    ring.style.setProperty('--kpi-angle', `${selected.passedCount / Math.max(selected.totalCount, 1) * 360}deg`);
    setText('homeKPIValue', `${selected.passedCount}/${selected.totalCount}`);
    setText('homeKPICycle', `${thaiDate(selected.startDate)} - ${thaiDate(selected.endDate)}`);
    setText('homeKPISource', `ข้อมูลระบบ ${selected.source.liveDays} วัน · ประวัติ ${selected.source.historyDays} วัน`);

    const headline = document.getElementById('homeKPIHeadline');
    headline.className = 'home-summary-value';
    if (selected.passedCount === selected.totalCount) {
      headline.textContent = 'ผ่านเป้าหมายครบ';
      headline.classList.add('good');
    } else if (selected.passedCount >= 3) {
      headline.textContent = `ผ่าน ${selected.passedCount} จาก ${selected.totalCount}`;
      headline.classList.add('warn');
    } else {
      headline.textContent = 'ต้องติดตามเร่งด่วน';
      headline.classList.add('bad');
    }

    document.getElementById('homeKPIMetrics').innerHTML = selected.metrics.map((metric) => {
      const digits = metric.key === 'complaints' ? 0 : 2;
      const actual = `${num(metric.actual, digits)} ${metric.unit}`;
      const target = metric.limit
        ? `เป้า < ${num(metric.target, digits)}`
        : `เป้า ${num(metric.target, digits)}`;
      const progress = Math.min(100, Math.max(0, Number(metric.completionPct) || 0));
      return `<div class="home-kpi-metric ${escapeHtml(metric.key)}">
        <div class="home-kpi-metric-head">
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(actual)} / ${escapeHtml(target)}</strong>
          <b class="${metric.achieved ? 'pass' : ''}">${metric.achieved ? 'PASS' : 'BELOW'}</b>
        </div>
        <div class="home-kpi-track"><i style="width:${progress}%"></i></div>
      </div>`;
    }).join('');
  }

  function renderRevenue(data) {
    const total = Number(data.company.central) || 0;
    const sales = Number(data.sales.base) || 0;
    const tipping = Number(data.tipping.central) || 0;
    const salesShare = total > 0 ? sales / total * 100 : 0;
    const tippingShare = total > 0 ? tipping / total * 100 : 0;
    const donut = document.getElementById('homeRevenueDonut');
    donut.classList.toggle('empty', total <= 0);
    donut.style.setProperty('--sales-angle', `${salesShare * 3.6}deg`);
    setText('homeRevenueValue', `${num(total, 0)} บาท`);
    setText('homeRevenueSalesValue', `${num(sales, 0)} บาท`);
    setText('homeRevenueTippingValue', `${num(tipping, 0)} บาท`);
    setText('homeRevenueSalesShare', `${num(salesShare, 1)}%`);
    setText('homeRevenueTippingShare', `${num(tippingShare, 1)}%`);

    if (total <= 0) {
      setText('homeRevenueLead', 'ยังไม่มีข้อมูล');
      setText('homeRevenueComparison', 'ยังไม่มีรายได้ในเดือนนี้');
      return;
    }
    const salesLeads = sales >= tipping;
    const difference = Math.abs(sales - tipping);
    setText('homeRevenueLead', salesLeads ? 'Product Sales' : 'Tipping Fee');
    setText('homeRevenueComparison', `${salesLeads ? 'ยอดขายสินค้า' : 'Tipping Fee'} สูงกว่า ${num(difference, 0)} บาท`);
  }

  async function loadHomeDashboard() {
    const refreshButton = document.getElementById('btnRefreshHome');
    refreshButton.disabled = true;
    const today = todayStr();
    const month = today.slice(0, 7);
    const weekStart = mondayFor(today);
    const kpiPeriod = kpiPeriodFor(today);
    setText('homeDateLabel', new Date().toLocaleDateString('th-TH', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }));
    setText('homeWeekLabel', `${thaiDate(weekStart)} - ${thaiDate(deliveryAddDays(weekStart, 6))}`);
    setText('homeMonthLabel', monthLabel(month));

    try {
      const results = await Promise.allSettled([
        api(`/api/report?date=${today}`),
        api(`/api/weekly-report?weekStart=${weekStart}`),
        api(`/api/delivery-plans/dashboard?weekStart=${weekStart}`),
        api(`/api/revenue/dashboard?month=${month}`),
        api(`/api/kpi/dashboard?period=${kpiPeriod}`),
      ]);
      const report = successful(results[0]);
      const weekly = successful(results[1]);
      const delivery = successful(results[2]);
      const revenue = successful(results[3]);
      const kpi = successful(results[4]);

      if (report) {
        const running = report.line.segments.some((segment) => segment.ongoing);
        const availability = report.line.availabilityPct === null ? '-' : `${num(report.line.availabilityPct, 1)}%`;
        setText('homeLineValue', `${minutes(report.line.netRunMinutes)} · ${availability}`);
        setText('homeLineMeta', `${running ? 'Line Running' : 'Line Recorded'} · Downtime ${minutes(report.downtime.totalMinutes)} · ${report.grab.totalGrabs} Grab`);
      }

      if (weekly) {
        const rdf2 = weekly.production.products.find((row) => row.product === 'RDF2');
        setText('homeWeeklyValue', `${num(weekly.incoming.totalTons)} / ${num(weekly.sales.totalTons)} ตัน`);
        setText('homeWeeklyMeta', `ขยะเข้า / ยอดขาย · ผลิต RDF2 ${num(rdf2?.tons)} ตัน · ${weekly.sales.transactionCount} รายการขาย`);
      }

      if (delivery) {
        setText('homeDeliveryValue', `${num(delivery.summary.opportunityLoss, 0)} บาท`);
        setText('homeDeliveryMeta', `ขาดแผน ${num(delivery.summary.shortfallTons)} ตัน · ${delivery.summary.customerCount} ลูกค้า`);
      }
      if (revenue) renderRevenue(revenue);
      if (kpi) renderKPI(kpi);

      const failed = results.filter((result) => result.status === 'rejected').length;
      setText('homeDataStatus', failed ? `${5 - failed}/5 Sources Online` : 'All Data Online');
      setText('homeLastSync', new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }));
      lastLoadedAt = Date.now();
    } finally {
      refreshButton.disabled = false;
    }
  }

  document.getElementById('btnRefreshHome').addEventListener('click', () => {
    loadHomeDashboard().catch((error) => toast(error.message, true));
  });
  document.addEventListener('gp1:tabchange', (event) => {
    if (event.detail?.tab === 'home' && Date.now() - lastLoadedAt > 60000) {
      loadHomeDashboard().catch((error) => toast(error.message, true));
    }
  });
  loadHomeDashboard().catch((error) => toast(error.message, true));
})();
