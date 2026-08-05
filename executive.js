(() => {
  const panel = document.getElementById('tab-executive-report');
  if (!panel) return;

  const dateInput = document.getElementById('executiveReportDate');
  const report = document.getElementById('executiveReportExport');
  const skeleton = document.getElementById('executiveSkeleton');
  const content = document.getElementById('executiveContent');
  let renderedDate = '';
  let loadPromise = null;

  function numberLabel(value, digits = 2) {
    return (Number(value) || 0).toLocaleString('th-TH', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function percentLabel(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
    return `${numberLabel(value, 1)}%`;
  }

  function thaiDate(date) {
    return new Date(`${date}T12:00:00+07:00`).toLocaleDateString('th-TH', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function monthLabel(month) {
    return new Date(`${month}-01T12:00:00+07:00`).toLocaleDateString('th-TH', {
      month: 'long', year: 'numeric',
    });
  }

  function shiftDate(date, offset) {
    const value = new Date(`${date}T12:00:00+07:00`);
    value.setDate(value.getDate() + offset);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function achievement(actual, plan) {
    const target = Number(plan) || 0;
    return target > 0 ? (Number(actual) || 0) / target * 100 : null;
  }

  function setProgress(id, value) {
    const element = document.getElementById(id);
    if (element) element.style.width = `${Math.min(100, Math.max(0, Number(value) || 0))}%`;
  }

  function renderFuelList(id, rows) {
    const target = document.getElementById(id);
    target.innerHTML = rows.length
      ? rows.map((row) => {
        const usage = row.utilizationPct === null ? 0 : Math.max(0, Number(row.utilizationPct) || 0);
        return `<div class="fuel-limit-row ${row.exceeded ? 'exceeded' : ''}">
          <div><strong>${htmlEsc(row.machine)}</strong><span>${numberLabel(row.liters)} / ${Number(row.limitLiters) > 0 ? numberLabel(row.limitLiters) : '-'} L</span></div>
          <div class="fuel-limit-track"><i style="--fuel-progress:${Math.min(100, usage)}%"></i></div>
          <b>${row.utilizationPct === null ? 'ไม่ตั้งลิมิต' : percentLabel(row.utilizationPct)}</b>
        </div>`;
      }).join('')
      : '<div class="executive-empty-row">ยังไม่มีรายการเครื่องจักร</div>';
  }

  function renderDailyComparisons(data) {
    const rows = [
      { key: 'msw', label: 'MSW to Production', actual: data.production.dailyTons, plan: data.targets.dailyTons },
      { key: 'rdf2', label: 'RDF2', actual: data.output.daily.rdf2Tons, plan: data.output.plan.rdf2Tons },
      { key: 'rdf2lg', label: 'RDF2 LG', actual: data.output.daily.rdf2LGTons, plan: data.output.plan.rdf2LGTons },
    ];
    document.getElementById('executiveDailyComparisons').innerHTML = rows.map((row) => {
      const pct = achievement(row.actual, row.plan);
      const scale = Math.max(1, Number(row.actual) || 0, Number(row.plan) || 0);
      const planWidth = Number(row.plan) > 0 ? Number(row.plan) / scale * 100 : 0;
      const actualWidth = Number(row.actual) > 0 ? Number(row.actual) / scale * 100 : 0;
      const achieved = pct !== null && pct >= 100;
      return `<article class="executive-comparison-row ${row.key} ${achieved ? 'achieved' : ''}">
        <div class="executive-comparison-label"><strong>${row.label}</strong><span>${pct === null ? 'ยังไม่มีข้อมูลสำหรับแผน' : `${percentLabel(pct)} ของแผน`}</span></div>
        <div class="executive-comparison-bars">
          <div><span>PLAN</span><i><b style="width:${planWidth}%"></b></i><strong>${numberLabel(row.plan)} ตัน</strong></div>
          <div class="actual"><span>ACTUAL</span><i><b style="width:${actualWidth}%"></b></i><strong>${numberLabel(row.actual)} ตัน</strong></div>
        </div>
      </article>`;
    }).join('');
  }

  function renderTrend(data) {
    const target = document.getElementById('executiveTrendChart');
    const actualByDay = new Map(data.trend.map((row) => [Number(row.date.slice(8, 10)), Number(row.tons) || 0]));
    const currentAverage = Number(data.recovery.currentAverageTons) || 0;
    const dailyPlan = Number(data.targets.dailyTons) || 0;
    const values = [...actualByDay.values()];
    const maxValue = Math.max(1, dailyPlan, currentAverage, ...values) * 1.15;
    const planHeight = Math.min(100, dailyPlan / maxValue * 100);
    const averageHeight = Math.min(100, currentAverage / maxValue * 100);
    const bars = Array.from({ length: data.daysInMonth }, (_, index) => {
      const day = index + 1;
      const hasValue = actualByDay.has(day);
      const value = actualByDay.get(day) || 0;
      const height = Math.max(0, Math.min(100, value / maxValue * 100));
      return `<div class="executive-chart-bar ${day === data.elapsedDays ? 'current' : ''}" style="--bar-height:${height}%">
        ${hasValue && value > 0 ? `<strong>${numberLabel(value, 0)}</strong>` : ''}
        <i style="height:${height}%"></i><b>${day}</b>
      </div>`;
    }).join('');
    target.style.setProperty('--chart-days', String(data.daysInMonth));
    target.innerHTML = `
      <span class="executive-chart-y" style="bottom:100%">${numberLabel(maxValue, 0)}</span>
      <span class="executive-chart-y" style="bottom:50%">${numberLabel(maxValue / 2, 0)}</span>
      <span class="executive-chart-y" style="bottom:0">0</span>
      <div class="executive-chart-line target" style="bottom:${planHeight}%"><span>${numberLabel(dailyPlan, 0)}</span></div>
      <div class="executive-chart-line average" style="bottom:${averageHeight}%"><span>${numberLabel(currentAverage, 0)}</span></div>
      <div class="executive-chart-bars">${bars}</div>`;
  }

  function renderIncidents(data) {
    const target = document.getElementById('executiveIncidentList');
    setText('executiveIncidentMeta', data.incidents.totalCount
      ? `${data.incidents.totalCount.toLocaleString('th-TH')} เหตุ · รวม ${fmtMin(data.incidents.totalMinutes)}`
      : 'ไม่พบเหตุหยุดเครื่อง');
    if (!data.incidents.top.length) {
      target.innerHTML = '<div class="executive-incident-empty">ไม่มีรายการ Downtime ในวันที่เลือก</div>';
      return;
    }
    target.innerHTML = data.incidents.top.map((incident, index) => `<article class="executive-incident">
      <b>#${index + 1}</b>
      <div><strong>${htmlEsc(incident.reason)}</strong><p>${htmlEsc(incident.note || 'ไม่มีหมายเหตุ')}</p></div>
      <time>${htmlEsc(incident.startTime)}-${htmlEsc(incident.endTime)} · ${fmtMin(incident.minutes)}</time>
    </article>`).join('');
  }

  function renderExecutive(data) {
    setText('executiveDateLabel', thaiDate(data.date));
    setText('executiveIncomingDaily', numberLabel(data.incoming.dailyTons));
    setText('executiveIncomingStatus', `${data.incoming.hasData ? 'บันทึกแล้ว' : 'ยังไม่บันทึก'} · MTD ${numberLabel(data.incoming.mtdTons)} ตัน`);

    setText('executiveProductionPct', `${percentLabel(data.production.dailyAchievementPct)} ของแผน`);
    setText('executiveProductionDaily', numberLabel(data.production.dailyTons));

    setText('executiveRDF2Daily', numberLabel(data.output.daily.rdf2Tons));
    setText('executiveRDF2LGDaily', numberLabel(data.output.daily.rdf2LGTons));
    setText('executiveYieldNote', data.output.hasYieldSetting ? 'คำนวณจาก Yield ที่มีผล' : 'ยังไม่มีค่า Yield');

    setText('executiveDieselDaily', numberLabel(data.diesel.daily.totalLiters));
    setText('executiveDieselDailyLimit', numberLabel(data.diesel.daily.totalLimitLiters));
    setText('executiveDieselDailyPct', `${percentLabel(data.diesel.daily.utilizationPct)} ของลิมิต`);
    renderFuelList('executiveDieselDailyMachines', data.diesel.daily.byMachine);

    renderDailyComparisons(data);
    const plan = data.output.plan;
    setText('executiveOutputPlanMeta', plan.basisDays
      ? `Plan RDF จากค่าเฉลี่ยย้อนหลัง ${plan.basisDays.toLocaleString('th-TH')} วัน (${thaiDate(plan.startDate)} - ${thaiDate(plan.endDate)})`
      : 'ยังไม่มีข้อมูลย้อนหลังเพียงพอสำหรับ Plan RDF');

    setText('executiveMonthMeta', `${monthLabel(data.month)} · วันที่ ${data.elapsedDays} จาก ${data.daysInMonth}`);
    setText('executiveMTDPct', percentLabel(data.production.monthlyAchievementPct));
    setProgress('executiveMTDBar', data.production.monthlyAchievementPct);
    setText('executiveProductionMTD', `${numberLabel(data.production.mtdTons)} ตัน`);
    setText('executiveMonthlyTarget', `${numberLabel(data.targets.monthlyTons)} ตัน`);

    const rdf2MTDPct = achievement(data.output.mtd.rdf2Tons, plan.mtdRDF2Tons);
    const rdf2LGMTDPct = achievement(data.output.mtd.rdf2LGTons, plan.mtdRDF2LGTons);
    setText('executiveRDF2MTD', `${numberLabel(data.output.mtd.rdf2Tons)} ตัน`);
    setText('executiveRDF2MTDPlan', `${numberLabel(plan.mtdRDF2Tons)} ตัน`);
    setText('executiveRDF2MTDPct', percentLabel(rdf2MTDPct));
    setProgress('executiveRDF2MTDBar', rdf2MTDPct);
    setText('executiveRDF2LGMTD', `${numberLabel(data.output.mtd.rdf2LGTons)} ตัน`);
    setText('executiveRDF2LGMTDPlan', `${numberLabel(plan.mtdRDF2LGTons)} ตัน`);
    setText('executiveRDF2LGMTDPct', percentLabel(rdf2LGMTDPct));
    setProgress('executiveRDF2LGMTDBar', rdf2LGMTDPct);
    setText('executiveDieselMTD', `MTD ${numberLabel(data.diesel.mtd.totalLiters)} / ${numberLabel(data.diesel.mtd.totalLimitLiters)} ลิตร · ${percentLabel(data.diesel.mtd.utilizationPct)}`);
    renderFuelList('executiveDieselMTDMachines', data.diesel.mtd.byMachine);

    setText('executiveDaysRemaining', Number(data.recovery.daysRemaining).toLocaleString('th-TH'));
    setText('executiveShortfall', numberLabel(data.recovery.shortfallTons));
    setText('executiveNeedPerDay', data.recovery.requiredPerDayTons === null ? '-' : numberLabel(data.recovery.requiredPerDayTons));
    setText('executiveCurrentAverage', `${numberLabel(data.recovery.currentAverageTons)} ตัน/วัน`);
    setText('executiveRequiredAverage', data.recovery.requiredPerDayTons === null ? '-' : `${numberLabel(data.recovery.requiredPerDayTons)} ตัน/วัน`);
    const gap = data.recovery.gapPerDayTons;
    setText('executiveRateNote', gap === null
      ? 'สิ้นสุดรอบเดือน'
      : gap > 0
        ? `ต้องเพิ่ม ${numberLabel(gap)} ตัน/วัน จากค่าเฉลี่ยปัจจุบัน`
        : 'อัตราปัจจุบันเพียงพอต่อเป้าหมาย');

    setText('executiveTrendTotal', `MTD ${numberLabel(data.production.mtdTons)} ตัน`);
    renderTrend(data);
    renderIncidents(data);
  }

  async function loadExecutive(force = false) {
    const date = dateInput.value || shiftDate(todayStr(), -1);
    if (!force && renderedDate === date && !content.hidden) return;
    if (loadPromise) return loadPromise;
    skeleton.hidden = false;
    content.hidden = true;
    report.setAttribute('aria-busy', 'true');
    loadPromise = api(`/api/executive-report?date=${encodeURIComponent(date)}`)
      .then((data) => {
        renderExecutive(data);
        renderedDate = date;
        skeleton.hidden = true;
        content.hidden = false;
        return data;
      })
      .finally(() => {
        report.removeAttribute('aria-busy');
        loadPromise = null;
      });
    return loadPromise;
  }

  document.getElementById('btnLoadExecutive').addEventListener('click', () => {
    loadExecutive(true).catch((error) => toast(error.message, true));
  });
  dateInput.addEventListener('change', () => {
    loadExecutive(true).catch((error) => toast(error.message, true));
  });
  document.getElementById('btnExecutivePrev').addEventListener('click', () => {
    dateInput.value = shiftDate(dateInput.value, -1);
    loadExecutive(true).catch((error) => toast(error.message, true));
  });
  document.getElementById('btnExecutiveNext').addEventListener('click', () => {
    dateInput.value = shiftDate(dateInput.value, 1);
    loadExecutive(true).catch((error) => toast(error.message, true));
  });

  onClickGuarded(document.getElementById('btnExportExecutive'), async () => {
    try {
      await loadExecutive(true);
      if (document.fonts?.ready) await document.fonts.ready;
      const capture = await ensureHtml2Canvas();
      report.classList.add('exporting');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = await capture(report, {
        scale: 2,
        backgroundColor: '#eef3f0',
        logging: false,
        useCORS: true,
        windowWidth: 1080,
      });
      const link = document.createElement('a');
      link.download = `GP1-Daily-Report-${dateInput.value}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast('ดาวน์โหลด Daily Report แล้ว');
    } catch (error) {
      toast(`ไม่สามารถ Export ภาพได้: ${error.message}`, true);
    } finally {
      report.classList.remove('exporting');
    }
  });

  window.initExecutiveReport = function initExecutiveReport(force = false) {
    if (!dateInput.value) dateInput.value = shiftDate(todayStr(), -1);
    return loadExecutive(force);
  };
  if (panel.classList.contains('active')) {
    window.initExecutiveReport().catch((error) => toast(error.message, true));
  }
})();
