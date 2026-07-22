(() => {
  let lastLoadedAt = 0;
  let homeMotion = null;
  let homeLoadPromise = null;
  let hasLoadedDashboard = false;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const valueAnimations = new WeakMap();
  const launcher = document.getElementById('workspaceLauncher');
  const launcherDialog = launcher.querySelector('.workspace-launcher-dialog');
  const workspaceButton = document.getElementById('btnOpenWorkspace');
  let launcherTrigger = null;

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function markValueUpdated(element) {
    if (!element.dataset.motionReady) {
      element.dataset.motionReady = 'true';
      return;
    }
    element.classList.remove('value-updated');
    void element.offsetWidth;
    element.classList.add('value-updated');
    window.setTimeout(() => element.classList.remove('value-updated'), 900);
  }

  function animateNumericElement(element, endValue, formatter, duration = 720, delay = 0) {
    if (!element) return;
    const end = Number(endValue) || 0;
    const previousTarget = Number(element.dataset.motionValue);
    const start = Number.isFinite(previousTarget) ? previousTarget : 0;
    const active = valueAnimations.get(element);
    if (active?.frame) cancelAnimationFrame(active.frame);
    if (active?.timer) clearTimeout(active.timer);
    element.dataset.motionValue = String(end);
    if (Number.isFinite(previousTarget) && Math.abs(previousTarget - end) > 0.0001) markValueUpdated(element);
    else if (!element.dataset.motionReady) element.dataset.motionReady = 'true';

    if (reducedMotion.matches || Math.abs(start - end) < 0.0001) {
      element.textContent = formatter(end);
      return;
    }

    const state = { frame: 0, timer: 0 };
    const run = () => {
      const startedAt = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = formatter(start + (end - start) * eased);
        if (progress < 1) state.frame = requestAnimationFrame(step);
        else valueAnimations.delete(element);
      };
      state.frame = requestAnimationFrame(step);
    };
    if (delay) state.timer = window.setTimeout(run, delay);
    else run();
    valueAnimations.set(element, state);
  }

  function animateNumber(id, endValue, formatter, duration, delay) {
    animateNumericElement(document.getElementById(id), endValue, formatter, duration, delay);
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

  function setupHomeMotion() {
    const canvas = document.getElementById('homeMotionCanvas');
    if (!canvas) return null;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const state = { sales: 0.5, tipping: 0.5, kpi: 0.2 };
    const target = { ...state };
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let frame = 0;
    let inView = true;
    let lastTimestamp = 0;

    function signalY(x, startX, base, amplitude, speed, time, variation) {
      const progress = (x - startX) / Math.max(width - startX, 1);
      const primary = Math.sin(progress * (8 + variation * 2) + time * 0.00055 * speed);
      const detail = Math.sin(progress * (22 - variation * 3) - time * 0.00032 * speed);
      return base + primary * amplitude + detail * amplitude * 0.28;
    }

    function drawPerspectiveGrid(time) {
      const horizon = height * 0.52;
      const left = width * (width < 700 ? 0.08 : 0.4);
      const right = width * 1.08;
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(91, 167, 132, 0.12)';

      for (let index = 0; index <= 10; index += 1) {
        const ratio = index / 10;
        context.beginPath();
        context.moveTo(left + (right - left) * (0.44 + ratio * 0.24), horizon);
        context.lineTo(left - width * 0.12 + (right - left + width * 0.2) * ratio, height);
        context.stroke();
      }

      for (let index = 0; index < 11; index += 1) {
        const progress = (index / 11 + time * 0.000025) % 1;
        const depth = progress * progress;
        const y = horizon + (height - horizon) * depth;
        context.beginPath();
        context.moveTo(left - width * 0.12 * depth, y);
        context.lineTo(right + width * 0.05 * depth, y);
        context.stroke();
      }
    }

    function drawSignal(options, time) {
      const startX = width * (width < 700 ? 0.02 : 0.37);
      const endX = width + 16;
      const step = Math.max(5, width / 150);
      context.beginPath();
      for (let x = startX; x <= endX; x += step) {
        const y = signalY(x, startX, options.base, options.amplitude, options.speed, time, options.variation);
        if (x === startX) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.lineWidth = options.width;
      context.strokeStyle = options.color;
      context.stroke();

      const distance = endX - startX;
      const markerX = startX + ((time * options.markerSpeed + options.offset) % distance);
      const markerY = signalY(markerX, startX, options.base, options.amplitude, options.speed, time, options.variation);
      context.fillStyle = options.markerColor;
      context.fillRect(markerX - 3, markerY - 3, 6, 6);

      const secondX = startX + ((time * options.markerSpeed + options.offset + distance * 0.48) % distance);
      const secondY = signalY(secondX, startX, options.base, options.amplitude, options.speed, time, options.variation);
      context.fillStyle = options.secondaryMarkerColor;
      context.fillRect(secondX - 2, secondY - 2, 4, 4);
    }

    function paint(timestamp) {
      if (!width || !height) return;
      lastTimestamp = reducedMotion.matches ? 4200 : timestamp;
      const time = lastTimestamp;
      state.sales += (target.sales - state.sales) * 0.035;
      state.tipping += (target.tipping - state.tipping) * 0.035;
      state.kpi += (target.kpi - state.kpi) * 0.035;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#0d1728';
      context.fillRect(0, 0, width, height);

      drawPerspectiveGrid(time);

      const startX = width * (width < 700 ? 0.02 : 0.37);
      const scanDistance = width - startX + 24;
      const scanX = startX + ((time * 0.035) % scanDistance);
      context.fillStyle = 'rgba(52, 211, 153, 0.08)';
      context.fillRect(scanX, 0, 1, height);

      drawSignal({
        base: height * (0.34 + (1 - state.sales) * 0.08),
        amplitude: 13 + state.sales * 13,
        speed: 1,
        variation: 1,
        width: 1.6,
        color: 'rgba(52, 211, 153, 0.7)',
        markerColor: '#6ee7b7',
        secondaryMarkerColor: 'rgba(110, 231, 183, 0.58)',
        markerSpeed: 0.055,
        offset: 0,
      }, time);
      drawSignal({
        base: height * (0.56 - state.tipping * 0.07),
        amplitude: 10 + state.tipping * 12,
        speed: 0.82,
        variation: 2,
        width: 1.6,
        color: 'rgba(163, 230, 53, 0.58)',
        markerColor: '#bef264',
        secondaryMarkerColor: 'rgba(190, 242, 100, 0.5)',
        markerSpeed: 0.043,
        offset: width * 0.2,
      }, time);
      drawSignal({
        base: height * (0.75 - state.kpi * 0.1),
        amplitude: 7 + state.kpi * 10,
        speed: 0.68,
        variation: 3,
        width: 1,
        color: 'rgba(45, 212, 191, 0.25)',
        markerColor: 'rgba(94, 234, 212, 0.76)',
        secondaryMarkerColor: 'rgba(94, 234, 212, 0.38)',
        markerSpeed: 0.034,
        offset: width * 0.44,
      }, time);

      context.strokeStyle = 'rgba(110, 231, 183, 0.14)';
      context.lineWidth = 1;
      for (let y = 42; y < height - 34; y += 38) {
        context.beginPath();
        context.moveTo(width - 13, y);
        context.lineTo(width - (y % 76 === 42 ? 27 : 20), y);
        context.stroke();
      }
    }

    function loop(timestamp) {
      frame = 0;
      paint(timestamp);
      if (!reducedMotion.matches && !document.hidden && inView) frame = requestAnimationFrame(loop);
    }

    function start() {
      if (reducedMotion.matches) {
        paint(4200);
        return;
      }
      if (!frame && !document.hidden && inView) frame = requestAnimationFrame(loop);
    }

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      paint(lastTimestamp || 4200);
      start();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const visibilityObserver = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      if (inView) start();
      else stop();
    }, { threshold: 0.02 });
    visibilityObserver.observe(canvas);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
    reducedMotion.addEventListener('change', () => {
      stop();
      start();
    });

    resize();
    return {
      setData(values) {
        if (Number.isFinite(values.sales)) target.sales = Math.min(1, Math.max(0, values.sales));
        if (Number.isFinite(values.tipping)) target.tipping = Math.min(1, Math.max(0, values.tipping));
        if (Number.isFinite(values.kpi)) target.kpi = Math.min(1, Math.max(0, values.kpi));
        if (reducedMotion.matches) paint(4200);
        else start();
      },
    };
  }

  function setupSectionMotion() {
    const home = document.getElementById('tab-home');
    const sections = [...home.querySelectorAll('[data-motion-section]')];
    if (!sections.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sections.forEach((section) => section.classList.add('is-visible'));
      return;
    }
    home.classList.add('motion-ready');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px' });
    sections.forEach((section) => observer.observe(section));
  }

  function setWorkspaceMode(mode) {
    launcher.querySelectorAll('[data-workspace-mode]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.workspaceMode === mode));
    });
    launcher.querySelectorAll('[data-workspace-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.workspacePanel !== mode;
      panel.classList.remove('is-entering');
      if (!panel.hidden && !reducedMotion.matches) {
        void panel.offsetWidth;
        panel.classList.add('is-entering');
      }
    });
  }

  function openWorkspaceLauncher() {
    launcherTrigger = document.activeElement;
    launcher.hidden = false;
    launcher.setAttribute('aria-hidden', 'false');
    workspaceButton.setAttribute('aria-expanded', 'true');
    document.body.classList.add('workspace-launcher-open');
    const activePanel = launcher.querySelector('[data-workspace-panel]:not([hidden])');
    if (activePanel && !reducedMotion.matches) {
      activePanel.classList.remove('is-entering');
      void activePanel.offsetWidth;
      activePanel.classList.add('is-entering');
    }
    requestAnimationFrame(() => launcherDialog.focus());
  }

  function closeWorkspaceLauncher() {
    launcher.hidden = true;
    launcher.setAttribute('aria-hidden', 'true');
    workspaceButton.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('workspace-launcher-open');
    if (launcherTrigger instanceof HTMLElement) launcherTrigger.focus();
  }

  function animateDashboardUpdate() {
    const home = document.getElementById('tab-home');
    home.classList.remove('home-data-updated');
    requestAnimationFrame(() => requestAnimationFrame(() => home.classList.add('home-data-updated')));
  }

  function renderKPI(data) {
    const selected = data.selected;
    const kpiRatio = selected.passedCount / Math.max(selected.totalCount, 1);
    const ring = document.getElementById('homeKPIRing');
    ring.style.setProperty('--kpi-angle', `${kpiRatio * 360}deg`);
    animateNumber('homeKPIValue', selected.passedCount, (value) => `${Math.round(value)}/${selected.totalCount}`, 620);
    animateNumber('homeHeroKPI', selected.passedCount, (value) => `${Math.round(value)}/${selected.totalCount}`, 620, 80);
    homeMotion?.setData({ kpi: kpiRatio });
    setText('homeKPICycle', `${thaiDate(selected.startDate)} - ${thaiDate(selected.endDate)}`);
    setText('homeKPISource', `ข้อมูลระบบ ${selected.source.liveDays} วัน · ประวัติ ${selected.source.historyDays} วัน`);

    const metricsElement = document.getElementById('homeKPIMetrics');
    metricsElement.innerHTML = selected.metrics.map((metric, index) => {
      const digits = metric.key === 'complaints' ? 0 : 2;
      const target = metric.limit
        ? `เป้า < ${num(metric.target, digits)}`
        : `เป้า ${num(metric.target, digits)}`;
      const progress = Math.min(100, Math.max(0, Number(metric.completionPct) || 0));
      return `<div class="home-kpi-metric ${escapeHtml(metric.key)}" style="--metric-index:${index}">
        <div class="home-kpi-metric-head">
          <span>${escapeHtml(metric.label)}</span>
          <strong><span data-kpi-actual="${index}">0 ${escapeHtml(metric.unit)}</span> / ${escapeHtml(target)}</strong>
          <b class="${metric.achieved ? 'pass' : ''}">${metric.achieved ? 'PASS' : 'BELOW'}</b>
        </div>
        <div class="home-kpi-track"><i style="width:${progress}%"></i></div>
      </div>`;
    }).join('');
    selected.metrics.forEach((metric, index) => {
      const digits = metric.key === 'complaints' ? 0 : 2;
      animateNumericElement(
        metricsElement.querySelector(`[data-kpi-actual="${index}"]`),
        metric.actual,
        (value) => `${num(value, digits)} ${metric.unit}`,
        620,
        index * 70,
      );
    });
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
    animateNumber('homeRevenueValue', total, (value) => `${num(value, 0)} บาท`);
    animateNumber('homeRevenueSalesValue', sales, (value) => `${num(value, 0)} บาท`, 720, 70);
    animateNumber('homeRevenueTippingValue', tipping, (value) => `${num(value, 0)} บาท`, 720, 120);
    animateNumber('homeRevenueSalesShare', salesShare, (value) => `${num(value, 1)}%`, 620, 100);
    animateNumber('homeRevenueTippingShare', tippingShare, (value) => `${num(value, 1)}%`, 620, 150);
    animateNumber('homeHeroRevenue', total, (value) => `THB ${num(value, 0)}`, 820);
    setText('homeHeroMix', `Sales ${num(salesShare, 1)}% / Tipping ${num(tippingShare, 1)}%`);
    homeMotion?.setData({ sales: salesShare / 100, tipping: tippingShare / 100 });

    if (total <= 0) {
      setText('homeRevenueLead', 'ยังไม่มีข้อมูล');
      return;
    }
    const salesLeads = sales >= tipping;
    setText('homeRevenueLead', salesLeads ? 'Product Sales' : 'Tipping Fee');
  }

  async function fetchHomeDashboard() {
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
        animateNumber('homeLineValue', report.line.netRunMinutes, (value) => `${minutes(value)} · ${availability}`);
        setText('homeLineMeta', `${running ? 'Line Running' : 'Line Recorded'} · Downtime ${minutes(report.downtime.totalMinutes)} · ${report.grab.totalGrabs} Grab`);
      }

      if (weekly) {
        const mswKpi = weekly.kpi?.msw;
        const actualMSW = Number(mswKpi?.actualTons ?? weekly.incoming.totalTons) || 0;
        const weeklyTarget = mswKpi ? Number(mswKpi.weeklyTargetTons) || 0 : 2000;
        const achievement = Number(mswKpi?.attainmentPct)
          || (weeklyTarget > 0 ? actualMSW / weeklyTarget * 100 : 0);
        const diff = Number(mswKpi?.diffTons ?? (actualMSW - weeklyTarget)) || 0;
        animateNumber('homeWeeklyValue', actualMSW, (value) => `${num(value)} / ${num(weeklyTarget, 0)} ตัน`);
        setText('homeWeeklyMeta', `${num(achievement, 1)}% · ${diff >= 0 ? 'เกินเป้า' : 'ขาดอีก'} ${num(Math.abs(diff))} ตัน`);
      }

      if (delivery) {
        animateNumber('homeDeliveryValue', delivery.summary.opportunityLoss, (value) => `${num(value, 0)} บาท`);
        setText('homeDeliveryMeta', `ขาดแผน ${num(delivery.summary.shortfallTons)} ตัน · ${delivery.summary.customerCount} ลูกค้า`);
      }
      if (revenue) renderRevenue(revenue);
      if (kpi) renderKPI(kpi);

      const failed = results.filter((result) => result.status === 'rejected').length;
      setText('homeDataStatus', failed ? `${5 - failed}/5 Sources Online` : 'All Data Online');
      setText('homeLastSync', new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }));
      animateDashboardUpdate();
      lastLoadedAt = Date.now();
    } finally {
      refreshButton.disabled = false;
    }
  }

  function loadHomeDashboard() {
    if (homeLoadPromise) return homeLoadPromise;
    const home = document.getElementById('tab-home');
    if (!hasLoadedDashboard) {
      home.classList.add('home-is-loading');
      home.setAttribute('aria-busy', 'true');
    }
    homeLoadPromise = fetchHomeDashboard().finally(() => {
      hasLoadedDashboard = true;
      home.classList.remove('home-is-loading');
      home.setAttribute('aria-busy', 'false');
      homeLoadPromise = null;
    });
    return homeLoadPromise;
  }

  homeMotion = setupHomeMotion();
  setupSectionMotion();

  document.getElementById('btnRefreshHome').addEventListener('click', () => {
    loadHomeDashboard().catch((error) => toast(error.message, true));
  });
  workspaceButton.addEventListener('click', openWorkspaceLauncher);
  document.getElementById('btnCloseWorkspace').addEventListener('click', closeWorkspaceLauncher);
  document.getElementById('workspaceLauncherBackdrop').addEventListener('click', closeWorkspaceLauncher);
  launcher.querySelectorAll('[data-workspace-mode]').forEach((button) => {
    button.addEventListener('click', () => setWorkspaceMode(button.dataset.workspaceMode));
  });
  launcher.querySelectorAll('[data-open-tab]').forEach((button) => {
    button.addEventListener('click', closeWorkspaceLauncher);
  });
  document.addEventListener('keydown', (event) => {
    if (launcher.hidden) return;
    if (event.key === 'Escape') {
      closeWorkspaceLauncher();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [...launcher.querySelectorAll('button:not([disabled])')]
        .filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.addEventListener('gp1:tabchange', (event) => {
    if (event.detail?.tab === 'home' && Date.now() - lastLoadedAt > 60000) {
      loadHomeDashboard().catch((error) => toast(error.message, true));
    }
  });
  setText('footerYear', new Date().getFullYear());
  if (document.getElementById('tab-home').classList.contains('active')) {
    loadHomeDashboard().catch((error) => toast(error.message, true));
  }
})();
