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

  function renderMachineChips(id, rows) {
    const target = document.getElementById(id);
    target.innerHTML = rows.length
      ? rows.map((row) => `<span>${htmlEsc(row.machine)} ${numberLabel(row.liters)} L</span>`).join('')
      : '<span>ไม่มีการบันทึก</span>';
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
    setText('executiveIncomingMTD', `${numberLabel(data.incoming.mtdTons)} ตัน`);
    setText('executiveIncomingStatus', data.incoming.hasData ? 'RECORDED' : 'NO ENTRY');

    setText('executiveProductionPct', percentLabel(data.production.dailyAchievementPct));
    setText('executiveProductionDaily', numberLabel(data.production.dailyTons));
    setText('executiveProductionPlan', numberLabel(data.targets.dailyTons));
    const productionCard = document.querySelector('.executive-metric.production');
    productionCard.classList.toggle('achieved', Number(data.production.dailyAchievementPct) >= 100);

    setText('executiveRDF2Daily', numberLabel(data.output.daily.rdf2Tons));
    setText('executiveRDF2LGDaily', numberLabel(data.output.daily.rdf2LGTons));
    setText('executiveYieldNote', data.output.hasYieldSetting ? 'คำนวณจาก Yield ที่มีผลในวันที่รายงาน' : 'ยังไม่มีค่า Yield สำหรับวันที่รายงาน');

    setText('executiveDieselDaily', numberLabel(data.diesel.daily.totalLiters));
    renderMachineChips('executiveDieselDailyMachines', data.diesel.daily.byMachine);

    setText('executiveMonthMeta', `${monthLabel(data.month)} · วันที่ ${data.elapsedDays} จาก ${data.daysInMonth}`);
    setText('executiveMTDPct', percentLabel(data.production.monthlyAchievementPct));
    document.getElementById('executiveMTDBar').style.width = `${Math.min(100, Math.max(0, Number(data.production.monthlyAchievementPct) || 0))}%`;
    setText('executiveProductionMTD', `${numberLabel(data.production.mtdTons)} ตัน`);
    setText('executiveMonthlyTarget', `${numberLabel(data.targets.monthlyTons)} ตัน`);
    setText('executiveRDF2MTD', `${numberLabel(data.output.mtd.rdf2Tons)} ตัน`);
    setText('executiveRDF2LGMTD', `${numberLabel(data.output.mtd.rdf2LGTons)} ตัน`);
    setText('executiveDieselMTD', `${numberLabel(data.diesel.mtd.totalLiters)} ลิตร`);
    renderMachineChips('executiveDieselMTDMachines', data.diesel.mtd.byMachine);

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
        backgroundColor: '#f5f8fb',
        logging: false,
        useCORS: true,
        windowWidth: 1080,
      });
      const link = document.createElement('a');
      link.download = `GP1-Executive-Daily-${dateInput.value}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast('ดาวน์โหลด Executive Daily Report แล้ว');
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
