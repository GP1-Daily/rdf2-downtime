(() => {
  const panel = document.getElementById('tab-diesel');
  if (!panel) return;

  const dateInput = document.getElementById('dieselDate');
  const machineSelect = document.getElementById('dieselMachine');
  let machines = [];
  let latestUsageRows = [];
  let initialized = false;
  let initPromise = null;

  function activeValue(value) {
    return value !== false && value !== 0 && String(value).toLowerCase() !== 'false';
  }

  function numberLabel(value) {
    return (Number(value) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function percentLabel(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
    return `${Number(value).toLocaleString('th-TH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }

  function canManage() {
    return ['supervisor', 'admin'].includes(document.body.dataset.role || '');
  }

  function renderMachineSelect() {
    const selected = machineSelect.value;
    const activeMachines = machines.filter((row) => activeValue(row.Active));
    machineSelect.innerHTML = '<option value="">เลือกเครื่องจักร</option>'
      + activeMachines.map((row) => `<option value="${htmlEsc(row.Name)}">${htmlEsc(row.Name)}</option>`).join('');
    if (activeMachines.some((row) => row.Name === selected)) machineSelect.value = selected;
    document.getElementById('btnAddDiesel').disabled = activeMachines.length === 0;
  }

  function renderMachineList() {
    const target = document.getElementById('dieselMachineList');
    if (!machines.length) {
      target.innerHTML = '<div class="diesel-empty">ยังไม่มีรายชื่อเครื่องจักร</div>';
      return;
    }
    target.innerHTML = machines.map((row) => {
      const active = activeValue(row.Active);
      const limit = Math.max(0, Number(row.DailyLimitLiters) || 0);
      return `<div class="diesel-machine-item ${active ? '' : 'inactive'}">
        <div class="diesel-machine-readonly">
          <div><strong>${htmlEsc(row.Name)}</strong><small>ลิมิต ${limit > 0 ? `${numberLabel(limit)} ลิตร/วัน` : 'ยังไม่ตั้งค่า'}</small></div>
          <div class="diesel-machine-actions">
            <button type="button" data-machine-edit="${htmlEsc(row.ID)}">แก้ไข</button>
            <button type="button" data-machine-status="${htmlEsc(row.ID)}" data-machine-active="${active ? 'true' : 'false'}">${active ? 'พักใช้งาน' : 'เปิดใช้งาน'}</button>
            <button type="button" class="danger" data-machine-delete="${htmlEsc(row.ID)}">ลบ</button>
          </div>
        </div>
        <div class="diesel-machine-editor" data-machine-editor="${htmlEsc(row.ID)}" hidden>
          <label><span>ชื่อเครื่องจักร</span><input type="text" maxlength="100" value="${htmlEsc(row.Name)}" data-machine-name></label>
          <label><span>ลิมิต/วัน (ลิตร)</span><input type="number" min="0.01" max="100000" step="0.01" value="${limit || ''}" data-machine-limit></label>
          <div><button type="button" class="primary" data-machine-save="${htmlEsc(row.ID)}">บันทึก</button><button type="button" data-machine-cancel="${htmlEsc(row.ID)}">ยกเลิก</button></div>
        </div>
      </div>`;
    }).join('');
    target.querySelectorAll('[data-machine-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = button.closest('.diesel-machine-item');
        item.querySelector('.diesel-machine-readonly').hidden = true;
        item.querySelector('.diesel-machine-editor').hidden = false;
        item.querySelector('[data-machine-name]').focus();
      });
    });
    target.querySelectorAll('[data-machine-cancel]').forEach((button) => {
      button.addEventListener('click', () => renderMachineList());
    });
    target.querySelectorAll('[data-machine-save]').forEach((button) => {
      button.addEventListener('click', async () => {
        const editor = button.closest('.diesel-machine-editor');
        const name = editor.querySelector('[data-machine-name]').value.trim();
        const dailyLimitLiters = Number(editor.querySelector('[data-machine-limit]').value);
        if (!name || !Number.isFinite(dailyLimitLiters) || dailyLimitLiters <= 0) {
          toast('กรุณาระบุชื่อและลิมิตน้ำมันต่อวันให้ถูกต้อง', true);
          return;
        }
        try {
          await api(`/api/diesel/machines/${encodeURIComponent(button.dataset.machineSave)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, dailyLimitLiters }),
          });
          await Promise.all([loadMachines(), loadUsage()]);
          toast('บันทึกการตั้งค่าเครื่องจักรแล้ว');
        } catch (error) {
          toast(error.message, true);
        }
      });
    });
    target.querySelectorAll('[data-machine-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/diesel/machines/${encodeURIComponent(button.dataset.machineStatus)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: button.dataset.machineActive !== 'true' }),
          });
          await Promise.all([loadMachines(), loadUsage()]);
          toast('อัปเดตสถานะเครื่องจักรแล้ว');
        } catch (error) {
          toast(error.message, true);
        }
      });
    });
    target.querySelectorAll('[data-machine-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = machines.find((item) => String(item.ID) === String(button.dataset.machineDelete));
        if (!window.confirm(`ลบเครื่องจักร "${row?.Name || ''}" ใช่หรือไม่`)) return;
        try {
          await api(`/api/diesel/machines/${encodeURIComponent(button.dataset.machineDelete)}`, { method: 'DELETE' });
          await Promise.all([loadMachines(), loadUsage()]);
          toast('ลบเครื่องจักรแล้ว');
        } catch (error) {
          toast(error.message, true);
        }
      });
    });
  }

  async function loadMachines() {
    const data = await api('/api/diesel/machines');
    machines = data.rows || [];
    renderMachineSelect();
    renderMachineList();
  }

  function renderDailySummary(summary, count) {
    document.getElementById('dieselDailyTotal').textContent = numberLabel(summary.totalLiters);
    document.getElementById('dieselDailyLimit').textContent = numberLabel(summary.totalLimitLiters);
    document.getElementById('dieselDailyUtilization').textContent = percentLabel(summary.utilizationPct);
    const exceeded = Number(summary.totalLimitLiters) > 0 && Number(summary.totalLiters) > Number(summary.totalLimitLiters);
    const status = document.getElementById('dieselDailyStatus');
    status.textContent = Number(summary.totalLimitLiters) > 0 ? (exceeded ? 'เกินลิมิต' : 'อยู่ในลิมิต') : 'ยังไม่ตั้งลิมิต';
    status.classList.toggle('danger', exceeded);
    document.getElementById('dieselDailyCount').textContent = Number(count || 0).toLocaleString('th-TH');
    const breakdown = document.getElementById('dieselDailyBreakdown');
    breakdown.innerHTML = summary.byMachine.length
      ? summary.byMachine.map((row) => {
        const utilization = row.utilizationPct === null ? 0 : Math.max(0, Number(row.utilizationPct) || 0);
        return `<div class="fuel-limit-row ${row.exceeded ? 'exceeded' : ''}">
          <div><strong>${htmlEsc(row.machine)}</strong><span>${numberLabel(row.liters)} / ${row.limitLiters > 0 ? numberLabel(row.limitLiters) : '-'} ลิตร</span></div>
          <div class="fuel-limit-track"><i style="--fuel-progress:${Math.min(100, utilization)}%"></i></div>
          <b>${row.utilizationPct === null ? 'ไม่ตั้งลิมิต' : percentLabel(row.utilizationPct)}</b>
        </div>`;
      }).join('')
      : '<small>ยังไม่มีข้อมูล</small>';
  }

  function renderUsageTable(rows) {
    latestUsageRows = rows;
    const tbody = document.getElementById('dieselUsageTable');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="diesel-empty">ยังไม่มีรายการใช้น้ำมันในวันนี้</td></tr>';
      return;
    }
    const allowDelete = canManage();
    tbody.innerHTML = rows.map((row) => `<tr>
      <td class="left"><strong>${htmlEsc(row.Machine)}</strong></td>
      <td class="diesel-row-liters">${numberLabel(row.Liters)}</td>
      <td class="left">${htmlEsc(row.Note || '-')}</td>
      <td>${allowDelete ? `<button type="button" class="danger" data-diesel-delete="${htmlEsc(row.ID)}">ลบ</button>` : '-'}</td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-diesel-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/diesel/usage/${encodeURIComponent(button.dataset.dieselDelete)}`, { method: 'DELETE' });
          await loadUsage();
          toast('ลบรายการน้ำมันแล้ว');
        } catch (error) {
          toast(error.message, true);
        }
      });
    });
  }

  async function loadUsage() {
    const data = await api(`/api/diesel/usage?date=${encodeURIComponent(dateInput.value)}`);
    renderDailySummary(data.summary, data.rows.length);
    renderUsageTable(data.rows);
  }

  onClickGuarded(document.getElementById('btnAddDiesel'), async () => {
    try {
      const liters = Number(document.getElementById('dieselLiters').value);
      if (!machineSelect.value || !Number.isFinite(liters) || liters <= 0) {
        throw new Error('กรุณาเลือกเครื่องจักรและระบุจำนวนน้ำมัน');
      }
      await api('/api/diesel/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryDate: dateInput.value,
          machine: machineSelect.value,
          liters,
          note: document.getElementById('dieselNote').value,
        }),
      });
      document.getElementById('dieselLiters').value = '';
      document.getElementById('dieselNote').value = '';
      await loadUsage();
      toast('บันทึกการใช้น้ำมันแล้ว');
    } catch (error) {
      toast(error.message, true);
    }
  });

  onClickGuarded(document.getElementById('btnAddDieselMachine'), async () => {
    try {
      const input = document.getElementById('dieselMachineName');
      const limitInput = document.getElementById('dieselMachineLimit');
      const name = input.value.trim();
      const dailyLimitLiters = Number(limitInput.value);
      if (!name || !Number.isFinite(dailyLimitLiters) || dailyLimitLiters <= 0) {
        throw new Error('กรุณาระบุชื่อและลิมิตน้ำมันต่อวัน');
      }
      await api('/api/diesel/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, dailyLimitLiters }),
      });
      input.value = '';
      limitInput.value = '';
      await loadMachines();
      toast('เพิ่มเครื่องจักรแล้ว');
    } catch (error) {
      toast(error.message, true);
    }
  });

  dateInput.addEventListener('change', () => {
    loadUsage().catch((error) => toast(error.message, true));
  });
  document.addEventListener('gp1:sessionready', () => renderUsageTable(latestUsageRows));

  window.initDieselUsage = function initDieselUsage(force = false) {
    if (initPromise) return initPromise;
    if (initialized && !force) return loadUsage();
    if (!dateInput.value) dateInput.value = todayStr();
    initPromise = Promise.all([loadMachines(), loadUsage()])
      .then(() => { initialized = true; })
      .finally(() => { initPromise = null; });
    return initPromise;
  };
  if (panel.classList.contains('active')) {
    window.initDieselUsage().catch((error) => toast(error.message, true));
  }
})();
