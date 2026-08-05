(() => {
  const panel = document.getElementById('tab-monthly-report');
  if (!panel) return;

  const monthInput = document.getElementById('monthlyReportMonth');
  const skeleton = document.getElementById('monthlyReportSkeleton');
  const content = document.getElementById('monthlyReportContent');
  let loadPromise = null;
  let renderedMonth = '';

  function monthValue() {
    return monthInput.value || todayStr().slice(0, 7);
  }

  function shiftMonth(month, offset) {
    const [year, monthNumber] = month.split('-').map(Number);
    return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
  }

  function minutesLabel(value) {
    const minutes = Math.max(0, Math.round(Number(value) || 0));
    return `${Math.floor(minutes / 60).toLocaleString('th-TH')} ชม. ${minutes % 60} น.`;
  }

  function percentLabel(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
    return `${revenueNumber(value, 1)}%`;
  }

  function reportDateRange(start, end) {
    return `${deliveryDateLabel(start)} - ${deliveryDateLabel(end)}`;
  }

  function renderDailyChart(data) {
    const chart = document.getElementById('monthlyDailyChart');
    const maxTons = Math.max(0, ...data.daily.map((row) => Number(row.incomingTons) || 0));
    chart.style.setProperty('--month-days', String(data.daily.length));
    chart.innerHTML = data.daily.map((row, index) => {
      const tons = Number(row.incomingTons) || 0;
      const height = maxTons > 0 ? tons / maxTons * 100 : 0;
      const day = Number(row.date.slice(-2));
      const sourceLabel = {
        automatic: 'ข้อมูลจาก Pi',
        csv: 'ข้อมูลจาก CSV',
        mixed: 'ข้อมูลจาก CSV + Pi',
        history: 'ข้อมูลย้อนหลัง',
        none: 'ไม่มีข้อมูล',
      }[row.incomingSource] || 'ไม่ระบุแหล่งข้อมูล';
      const barClasses = [tons > 0 ? '' : 'zero', row.incomingSource === 'history' ? 'historical' : '']
        .filter(Boolean).join(' ');
      return `<div class="monthly-day-bar" title="${revenueEsc(deliveryDateLabel(row.date))}: ${revenueNumber(tons)} ตัน · ${revenueEsc(sourceLabel)}">
        <div class="monthly-day-column">
          <i class="${barClasses}" style="--bar-height:${height.toFixed(2)}%;--bar-min-height:${tons > 0 ? '3px' : '1px'};--bar-delay:${Math.min(index * 14, 280)}ms"></i>
        </div>
        <b>${day}</b>
      </div>`;
    }).join('');
    const activeDays = data.daily.filter((row) => Number(row.incomingTons) > 0).length;
    document.getElementById('monthlyDailyAverage').textContent = activeDays
      ? `เฉลี่ย ${revenueNumber(data.incoming.totalTons / activeDays)} ตัน/วันที่มีข้อมูล`
      : 'ยังไม่มีข้อมูลขยะเข้าระบบในเดือนนี้';
  }

  function renderProduction(data) {
    const labels = { RDF2: 'RDF2', RDF2LG: 'RDF2 LG', FineFraction: 'Fine Fraction' };
    const classes = { RDF2: 'rdf2', RDF2LG: 'rdf2lg', FineFraction: 'fine' };
    document.getElementById('monthlyProductionGrid').innerHTML = data.production.products.map((row) => `
      <article class="monthly-production-item ${revenueEsc(classes[row.product] || '')}">
        <span>${revenueEsc(labels[row.product] || row.product)}</span>
        <strong>${revenueNumber(row.tons)} ตัน</strong>
        <small>Yield เฉลี่ย ${revenueNumber(row.effectiveYieldPct)}%</small>
      </article>`).join('');
    document.getElementById('monthlyProductionSource').textContent = `คำนวณจาก ${revenueNumber(data.production.calculatedIncomingTons)} ตัน`;
    const warning = document.getElementById('monthlyYieldWarning');
    warning.textContent = data.production.missingYieldDates.length
      ? `ผลผลิตยังคำนวณไม่ครบ ${revenueNumber(data.production.uncalculatedIncomingTons)} ตัน: ไม่มีค่า Yield วันที่ ${data.production.missingYieldDates.map(deliveryDateLabel).join(', ')}`
      : '';
    warning.classList.toggle('show', data.production.missingYieldDates.length > 0);
  }

  function renderDiesel(data) {
    const diesel = data.diesel;
    const utilization = diesel.utilizationPct === null ? '-' : `${revenueNumber(diesel.utilizationPct, 1)}%`;
    document.getElementById('monthlyDieselSummary').textContent = `${revenueNumber(diesel.totalLiters)} / ${revenueNumber(diesel.totalLimitLiters)} ลิตร · ${utilization}`;
    document.getElementById('monthlyDieselMachines').innerHTML = reportFuelRowsHtml(diesel);
  }

  function renderOperations(data) {
    const operations = data.operations;
    document.getElementById('monthlyLineTime').textContent = minutesLabel(operations.lineMinutes);
    document.getElementById('monthlyProductionTime').textContent = minutesLabel(operations.productionMinutes);
    document.getElementById('monthlyDowntimeTime').textContent = minutesLabel(operations.downtimeMinutes);
    const reasons = operations.reasonTotals.slice(0, 5);
    const maxMinutes = Math.max(0, ...reasons.map((row) => Number(row.minutes) || 0));
    document.getElementById('monthlyDowntimeReasons').innerHTML = reasons.length ? reasons.map((row) => {
      const width = maxMinutes > 0 ? Number(row.minutes) / maxMinutes * 100 : 0;
      return `<div class="monthly-reason-row">
        <span>${revenueEsc(row.reason)} (${Number(row.count) || 0})</span>
        <div class="monthly-reason-track"><i style="--reason-width:${width.toFixed(2)}%"></i></div>
        <strong>${minutesLabel(row.minutes)}</strong>
      </div>`;
    }).join('') : '<div class="monthly-reason-empty">ไม่มี Downtime ในเดือนนี้</div>';
  }

  function renderRevenue(data) {
    const revenue = data.revenue;
    const salesShare = Number(revenue.company.salesSharePct) || 0;
    const tippingShare = Number(revenue.company.tippingSharePct) || 0;
    const safeSalesShare = Math.max(0, Math.min(100, salesShare));
    const safeTippingShare = Math.max(0, Math.min(100 - safeSalesShare, tippingShare));
    const donut = document.getElementById('monthlyRevenueDonut');
    donut.style.setProperty('--sales-share', `${safeSalesShare}%`);
    donut.classList.toggle('no-data', Number(revenue.company.central) <= 0);
    donut.setAttribute('aria-label', `ขายสินค้า ${percentLabel(salesShare)} และ Tipping Fee ${percentLabel(tippingShare)}`);
    const salesArc = document.getElementById('monthlyRevenueSalesArc');
    const tippingArc = document.getElementById('monthlyRevenueTippingArc');
    salesArc.setAttribute('stroke-dasharray', `${safeSalesShare} ${100 - safeSalesShare}`);
    salesArc.setAttribute('stroke-dashoffset', '0');
    tippingArc.setAttribute('stroke-dasharray', `${safeTippingShare} ${100 - safeTippingShare}`);
    tippingArc.setAttribute('stroke-dashoffset', `${-safeSalesShare}`);
    document.getElementById('monthlyRevenueDonutValue').textContent = percentLabel(salesShare);
    document.getElementById('monthlyRevenueTotal').textContent = revenueMoney(revenue.company.central);
    document.getElementById('monthlyRevenueHeadline').textContent = revenueMoney(revenue.company.central);
    document.getElementById('monthlyRevenueRange').textContent = `ช่วงประมาณการ ${revenueMoney(revenue.company.low)} - ${revenueMoney(revenue.company.high)}`;
    document.getElementById('monthlySalesRevenue').textContent = revenueMoney(revenue.sales.base);
    document.getElementById('monthlySalesShare').textContent = percentLabel(salesShare);
    document.getElementById('monthlySalesRevenueMeta').textContent = `${data.sales.transactionCount} รายการ · ${revenueNumber(data.sales.totalTons)} ตัน`;
    document.getElementById('monthlyTippingRevenue').textContent = revenueMoney(revenue.tipping.central);
    document.getElementById('monthlyTippingShare').textContent = percentLabel(tippingShare);
    document.getElementById('monthlyTippingRevenueMeta').textContent = `${revenueNumber(revenue.tipping.totalMSW)} ตัน MSW · ${revenueNumber(revenue.tipping.ratePerTon)} บาท/ตัน`;
    const warning = document.getElementById('monthlyRevenueWarning');
    warning.textContent = revenue.sales.unresolvedCount
      ? `ยอดขาย ${revenue.sales.unresolvedCount} รายการยังไม่รวมในรายได้ เนื่องจากยังไม่มีราคากลาง`
      : '';
    warning.classList.toggle('show', revenue.sales.unresolvedCount > 0);
  }

  function renderSales(data) {
    const tbody = document.getElementById('monthlySalesTable');
    tbody.innerHTML = data.sales.byCustomer.length ? data.sales.byCustomer.map((row) => `
      <tr>
        <td class="left"><strong>${revenueEsc(row.customer)}</strong></td>
        <td>${revenueNumber(row.products.RDF2)}</td>
        <td>${revenueNumber(row.products.RDF2LG)}</td>
        <td>${revenueNumber(row.products.RDF3)}</td>
        <td>${revenueNumber(row.products.FineFraction)}</td>
        <td class="monthly-total">${revenueNumber(row.totalTons)}</td>
        <td>${revenueMoney(row.revenue)}</td>
      </tr>`).join('') : revenueEmpty(7, 'ยังไม่มีรายการขายในเดือนนี้');
    const productTotals = Object.fromEntries(data.sales.byProduct.map((row) => [row.product, row.tons]));
    document.getElementById('monthlySalesTotal').innerHTML = `<tr>
      <td class="left">รวมทั้งหมด</td>
      <td>${revenueNumber(productTotals.RDF2)}</td>
      <td>${revenueNumber(productTotals.RDF2LG)}</td>
      <td>${revenueNumber(productTotals.RDF3)}</td>
      <td>${revenueNumber(productTotals.FineFraction)}</td>
      <td>${revenueNumber(data.sales.totalTons)}</td>
      <td>${revenueMoney(data.revenue.sales.base)}</td>
    </tr>`;
    document.getElementById('monthlySalesSummary').textContent = `${data.sales.transactionCount} รายการ · ${revenueNumber(data.sales.totalTons)} ตัน`;
  }

  function renderWeeks(data) {
    document.getElementById('monthlyWeekTable').innerHTML = data.weeks.length ? data.weeks.map((week) => `
      <tr>
        <td class="left"><strong>${reportDateRange(week.weekStart, week.weekEnd)}</strong></td>
        <td>${revenueNumber(week.incomingTons)}</td>
        <td>${Number(week.grabCount).toLocaleString('th-TH')}</td>
        <td>${minutesLabel(week.netRunMinutes)}</td>
        <td>${minutesLabel(week.downtimeMinutes)}</td>
        <td>${revenueNumber(week.salesTons)}</td>
        <td class="monthly-total">${revenueMoney(week.revenue)}</td>
      </tr>`).join('') : revenueEmpty(7, 'ยังไม่มีข้อมูลในเดือนนี้');
  }

  function renderMonthlyReport(data) {
    document.getElementById('monthlyReportPeriod').textContent = revenueMonthLabel(data.month);
    document.getElementById('monthlyIncomingTons').textContent = `${revenueNumber(data.incoming.totalTons)} ตัน`;
    const historyMeta = data.incoming.historicalDays > 0
      ? ` · ข้อมูลย้อนหลัง ${data.incoming.historicalDays.toLocaleString('th-TH')} วัน ${revenueNumber(data.incoming.historicalTons)} ตัน`
      : '';
    document.getElementById('monthlyIncomingMeta').textContent = `${data.incoming.totalGrabs.toLocaleString('th-TH')} Grab · เฉลี่ย ${data.incoming.avgTonsPerGrab === null ? '-' : revenueNumber(data.incoming.avgTonsPerGrab)} ตัน/Grab${historyMeta}`;
    document.getElementById('monthlyNetRuntime').textContent = minutesLabel(data.operations.netRunMinutes);
    document.getElementById('monthlyAvailability').textContent = `Availability ${percentLabel(data.operations.availabilityPct)}`;
    document.getElementById('monthlySalesTons').textContent = `${revenueNumber(data.sales.totalTons)} ตัน`;
    document.getElementById('monthlySalesMeta').textContent = `${data.sales.transactionCount.toLocaleString('th-TH')} รายการ`;
    renderDailyChart(data);
    renderProduction(data);
    renderOperations(data);
    renderDiesel(data);
    renderRevenue(data);
    renderSales(data);
    renderWeeks(data);
  }

  async function loadMonthlyReport(force = false) {
    const month = monthValue();
    monthInput.value = month;
    if (!force && renderedMonth === month && !content.hidden) return;
    if (loadPromise) return loadPromise;
    panel.setAttribute('aria-busy', 'true');
    if (!renderedMonth) {
      skeleton.hidden = false;
      content.hidden = true;
    }
    loadPromise = (async () => {
      const data = await api(`/api/monthly-report?month=${encodeURIComponent(month)}`);
      renderMonthlyReport(data);
      renderedMonth = data.month;
      skeleton.hidden = true;
      content.hidden = false;
    })().finally(() => {
      panel.removeAttribute('aria-busy');
      loadPromise = null;
    });
    return loadPromise;
  }

  window.initMonthlyReport = () => loadMonthlyReport(false);

  document.getElementById('btnLoadMonthlyReport').addEventListener('click', () => {
    loadMonthlyReport(true).catch((error) => toast(error.message, true));
  });
  monthInput.addEventListener('change', () => {
    loadMonthlyReport(true).catch((error) => toast(error.message, true));
  });
  document.getElementById('btnMonthlyReportPrev').addEventListener('click', () => {
    monthInput.value = shiftMonth(monthValue(), -1);
    loadMonthlyReport(true).catch((error) => toast(error.message, true));
  });
  document.getElementById('btnMonthlyReportNext').addEventListener('click', () => {
    monthInput.value = shiftMonth(monthValue(), 1);
    loadMonthlyReport(true).catch((error) => toast(error.message, true));
  });
  onClickGuarded(document.getElementById('btnExportMonthlyReport'), async () => {
    try {
      await loadMonthlyReport(true);
      await exportDeliveryElement(
        document.getElementById('monthlyReportExport'),
        `GP1-Monthly-Report-${monthValue()}.png`,
      );
      toast('Export รายงานประจำเดือนแล้ว');
    } catch (error) {
      toast(`ไม่สามารถ Export ภาพได้: ${error.message}`, true);
    }
  });

  if (!monthInput.value) monthInput.value = todayStr().slice(0, 7);
  if (panel.classList.contains('active')) {
    loadMonthlyReport().catch((error) => toast(error.message, true));
  }
})();
