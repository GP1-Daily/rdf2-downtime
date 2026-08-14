(() => {
  const machineCodes = ['MC1', 'MC2', 'MC3', 'MC4', 'MC5'];
  let initialized = false;
  let loadingPromise = null;
  let currentProduction = null;

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

  function duration(minutes) {
    const total = Math.max(0, Math.round(number(minutes)));
    return `${Math.floor(total / 60)} ชม. ${total % 60} น.`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function setStatus(message, error = false) {
    const status = element('rdf3MachineStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function setMachineState(code, isOn) {
    const control = document.querySelector(`[data-machine="${code}"]`);
    const stageIndicator = document.querySelector(`[data-stage-machine="${code}"]`);
    const input = element(`rdf3${code}On`);
    if (input) input.checked = Boolean(isOn);
    control?.classList.toggle('is-off', !isOn);
    stageIndicator?.classList.toggle('is-on', Boolean(isOn));
    const label = control?.querySelector('.machine-switch b');
    if (label) label.textContent = isOn ? 'ON' : 'OFF';
  }

  function currentFormValues() {
    return {
      yieldPct: number(element('rdf3MachineYield')?.value),
      efficiencyPct: number(element('rdf3MachineEfficiency')?.value),
      machines: machineCodes.map((code) => ({
        code,
        capTPH: Math.max(0, number(element(`rdf3${code}Cap`)?.value)),
        active: Boolean(element(`rdf3${code}On`)?.checked),
      })),
    };
  }

  function renderCalculation() {
    const values = currentFormValues();
    const serverPreview = currentProduction?.rdf3Production || {};
    const runtimeMinutes = number(serverPreview.runtimeMinutes);
    const runtimeHours = runtimeMinutes / 60;
    const availableFeedTons = Math.max(
      number(serverPreview.availableFeedTons),
      number(serverPreview.feedTons),
    );
    const onMachines = values.machines.filter((machine) => machine.active);
    const activeMachines = values.machines.filter((machine) => machine.active && machine.capTPH > 0);
    const activeCapacityTPH = activeMachines.reduce((sum, machine) => sum + machine.capTPH, 0);
    const materialOutputTons = availableFeedTons * values.yieldPct / 100;
    const capacityOutputTons = activeCapacityTPH * runtimeHours * values.efficiencyPct / 100;
    const estimatedOutputTons = Math.min(materialOutputTons, capacityOutputTons);
    const inputConsumedTons = values.yieldPct > 0
      ? Math.min(availableFeedTons, estimatedOutputTons / (values.yieldPct / 100))
      : 0;

    const lineStage = element('rdf3LineStage');
    const lineStatus = element('rdf3LineStatusText');
    lineStage?.classList.toggle('is-running', onMachines.length > 0);
    lineStage?.classList.toggle('is-idle', onMachines.length === 0);
    if (lineStatus) {
      lineStatus.textContent = onMachines.length > 0
        ? `กำลังทำงาน ${onMachines.length} / 5 เครื่อง`
        : 'หยุดรอคำสั่ง';
    }

    element('rdf3MachineActive').textContent = `${activeMachines.length} / 5`;
    element('rdf3MachineActiveCap').textContent = `${format(activeCapacityTPH)} ตัน/ชม.`;
    element('rdf3MachineRuntime').textContent = duration(runtimeMinutes);
    element('rdf3MachineMaterialOutput').textContent = `${format(materialOutputTons)} ตัน`;
    element('rdf3MachineCapacityOutput').textContent = `${format(capacityOutputTons)} ตัน`;
    element('rdf3MachineEstimatedOutput').textContent = `${format(estimatedOutputTons)} ตัน`;
    element('rdf3MachineWIP').textContent = `${format(Math.max(0, availableFeedTons - inputConsumedTons))} ตัน`;
  }

  function renderHistory(rows) {
    const body = element('rdf3MachineHistory');
    if (!body) return;
    if (!rows?.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty-note">ยังไม่ได้ตั้งค่ากำลังผลิต RDF3</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => `<tr>
      <td>${escapeHtml(row.EffectiveDate)}</td>
      ${machineCodes.map((code) => `<td>${format(row[`${code}CapTPH`])}</td>`).join('')}
      <td>${format(row.YieldPct)}%</td><td>${format(row.EfficiencyPct)}%</td>
      <td><button class="danger" data-machine-setting-id="${escapeHtml(row.ID)}">ลบ</button></td>
    </tr>`).join('');
    body.querySelectorAll('[data-machine-setting-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm('ลบค่ากำลังผลิตชุดนี้ใช่หรือไม่')) return;
        try {
          await window.api(`/api/rdf3-machines/settings/${encodeURIComponent(button.dataset.machineSettingId)}`, { method: 'DELETE' });
          window.toast('ลบค่ากำลังผลิต RDF3 แล้ว');
          await loadMachines();
        } catch (error) {
          window.toast(error.message, true);
        }
      });
    });
  }

  function render(data, production) {
    currentProduction = production;
    const setting = data.formSetting || {};
    const dailyDate = data.date || element('rdf3MachineDailyDate').value || today();
    element('rdf3MachineDailyDate').value = dailyDate;
    element('rdf3MachineDailyLabel').textContent = new Date(`${dailyDate}T12:00:00`).toLocaleDateString('th-TH', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    element('rdf3SettingDate').value = setting.EffectiveDate || dailyDate;
    element('rdf3MachineYield').value = number(setting.YieldPct).toFixed(2);
    element('rdf3MachineEfficiency').value = number(setting.EfficiencyPct).toFixed(2);

    const machineMap = new Map((data.machines || []).map((machine) => [machine.code, machine]));
    for (const code of machineCodes) {
      const machine = machineMap.get(code) || {};
      element(`rdf3${code}Cap`).value = number(setting[`${code}CapTPH`] ?? machine.capTPH).toFixed(2);
      setMachineState(code, machine.active ?? false);
    }
    renderCalculation();
    renderHistory(data.history || []);
    const mode = production?.rdf3Production?.configured
      ? 'Machine Bottleneck พร้อมใช้งาน'
      : 'ยังไม่มีค่าที่มีผลในวันนี้ ระบบรายงานยังใช้ Yield ย้อนหลัง 82.35%';
    setStatus(`${mode} · ข้อมูล ${format(production?.rdf3Production?.feedTons)} ตันจาก RDF3 Grab Crane`);
  }

  async function loadMachines() {
    if (loadingPromise) return loadingPromise;
    const date = element('rdf3MachineDailyDate')?.value || today();
    setStatus('กำลังอ่านค่ากำลังผลิตและข้อมูล Grab Crane...');
    loadingPromise = Promise.all([
      window.api(`/api/rdf3-machines?date=${encodeURIComponent(date)}`),
      window.api(`/api/production?date=${encodeURIComponent(date)}`),
    ]).then(([machineData, production]) => render(machineData, production))
      .catch((error) => {
        setStatus(error.message, true);
        throw error;
      })
      .finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  async function saveSettings() {
    const values = currentFormValues();
    const effectiveDate = element('rdf3SettingDate').value;
    if (!effectiveDate) throw new Error('กรุณาระบุวันที่เริ่มใช้ค่ากำลังผลิต');
    await window.api('/api/rdf3-machines/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        effectiveDate,
        yieldPct: values.yieldPct,
        efficiencyPct: values.efficiencyPct,
        ...Object.fromEntries(values.machines.map((machine) => [
          `${machine.code.toLowerCase()}CapTPH`, machine.capTPH,
        ])),
      }),
    });
    window.toast('บันทึก Capacity, Yield และ Efficiency แล้ว');
    await loadMachines();
  }

  async function saveDaily() {
    const entryDate = element('rdf3MachineDailyDate').value;
    if (!entryDate) throw new Error('กรุณาระบุวันที่ใช้งานเครื่อง');
    const values = currentFormValues();
    await window.api('/api/rdf3-machines/daily', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryDate,
        ...Object.fromEntries(values.machines.map((machine) => [
          `${machine.code.toLowerCase()}On`, machine.active,
        ])),
      }),
    });
    window.toast('บันทึกสถานะ ON / OFF รายวันแล้ว');
    await loadMachines();
  }

  function bindEvents() {
    element('btnSaveRDF3MachineSettings')?.addEventListener('click', () => {
      saveSettings().catch((error) => window.toast(error.message, true));
    });
    element('btnSaveRDF3MachineDaily')?.addEventListener('click', () => {
      saveDaily().catch((error) => window.toast(error.message, true));
    });
    element('rdf3MachineDailyDate')?.addEventListener('change', () => {
      loadMachines().catch((error) => window.toast(error.message, true));
    });
    for (const code of machineCodes) {
      element(`rdf3${code}On`)?.addEventListener('change', (event) => {
        setMachineState(code, event.currentTarget.checked);
        renderCalculation();
      });
      element(`rdf3${code}Cap`)?.addEventListener('input', renderCalculation);
    }
    element('rdf3MachineYield')?.addEventListener('input', renderCalculation);
    element('rdf3MachineEfficiency')?.addEventListener('input', renderCalculation);
  }

  window.initProductionMachines = async function initProductionMachines() {
    if (!initialized) {
      initialized = true;
      element('rdf3MachineDailyDate').value ||= today();
      element('rdf3SettingDate').value ||= today();
      bindEvents();
    }
    return loadMachines();
  };
  window.refreshProductionMachines = loadMachines;
})();
