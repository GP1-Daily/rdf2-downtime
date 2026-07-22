(() => {
  let lastLoadedAt = 0;

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
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
    return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric',
    });
  }

  function successful(result) {
    return result.status === 'fulfilled' ? result.value : null;
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
    setText('homeRevenuePeriod', monthLabel(month));

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
        setText('homeTodayStatus', running ? 'Line Running' : (report.line.totalMinutes > 0 ? 'Line Recorded' : 'No Line Session'));
        setText('homeLineState', running ? 'Running' : 'Current Day');
        setText('homeLineValue', minutes(report.line.netRunMinutes));
        const availability = report.line.availabilityPct === null ? '-' : `${num(report.line.availabilityPct, 1)}%`;
        setText('homeLineMeta', `Availability ${availability} · Downtime ${minutes(report.downtime.totalMinutes)}`);
        setText('homeGrabValue', `${report.grab.totalGrabs} Grab`);
        setText('homeGrabMeta', `${num(report.grab.totalWeight)} ตัน · เฉลี่ย ${report.grab.avgWeight === null ? '-' : num(report.grab.avgWeight)} ตัน/Grab`);
        setText('homeDailyValue', availability);
        setText('homeDailyMeta', `Line ${minutes(report.line.totalMinutes)} · Net ${minutes(report.line.netRunMinutes)}`);
      }

      if (weekly) {
        const rdf2 = weekly.production.products.find((row) => row.product === 'RDF2');
        const fine = weekly.production.products.find((row) => row.product === 'FineFraction');
        setText('homeProductionValue', `${num(weekly.incoming.totalTons)} ตันเข้า`);
        setText('homeProductionMeta', `RDF2 ${num(rdf2?.tons)} ตัน · Fine ${num(fine?.tons)} ตัน`);
        setText('homeWeeklyValue', `${num(weekly.sales.totalTons)} ตันขาย`);
        setText('homeWeeklyMeta', `${weekly.sales.transactionCount} รายการ · ขยะเข้า ${num(weekly.incoming.totalTons)} ตัน`);
      }

      if (delivery) {
        setText('homeDeliveryValue', `${num(delivery.summary.opportunityLoss, 0)} บาท`);
        setText('homeDeliveryMeta', `ค่าเสียโอกาส · ขาดแผน ${num(delivery.summary.shortfallTons)} ตัน · ${delivery.summary.customerCount} ลูกค้า`);
      }

      if (revenue) {
        setText('homeRevenueValue', `${num(revenue.company.central, 0)} บาท`);
        setText('homeRevenueMeta', revenue.company.central > 0
          ? `Sales ${num(revenue.company.salesSharePct, 1)}% · Tipping ${num(revenue.company.tippingSharePct, 1)}%`
          : 'ยังไม่มีรายได้ในเดือนนี้');
      }

      if (kpi) {
        const selected = kpi.selected;
        setText('homeKPIValue', `${selected.passedCount}/${selected.totalCount} ผ่านเป้า`);
        setText('homeKPIMeta', `${selected.totalCount - selected.passedCount} ตัวชี้วัดต่ำกว่าเป้า`);
        setText('homeKPIPeriod', `${thaiDate(selected.startDate)} - ${thaiDate(selected.endDate)}`);
      }

      const failed = results.filter((result) => result.status === 'rejected').length;
      setText('homeLastSync', new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }));
      if (failed) setText('homeTodayStatus', `${5 - failed}/5 Data Sources Online`);
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
