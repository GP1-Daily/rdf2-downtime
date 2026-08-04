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
      return `<div class="diesel-machine-item ${active ? '' : 'inactive'}">
        <strong>${htmlEsc(row.Name)}</strong>
        <button type="button" data-machine-id="${htmlEsc(row.ID)}" data-machine-active="${active ? 'true' : 'false'}">${active ? 'พักใช้งาน' : 'เปิดใช้งาน'}</button>
      </div>`;
    }).join('');
    target.querySelectorAll('[data-machine-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/diesel/machines/${encodeURIComponent(button.dataset.machineId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: button.dataset.machineActive !== 'true' }),
          });
          await loadMachines();
          toast('อัปเดตสถานะเครื่องจักรแล้ว');
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
    document.getElementById('dieselDailyCount').textContent = Number(count || 0).toLocaleString('th-TH');
    const breakdown = document.getElementById('dieselDailyBreakdown');
    breakdown.innerHTML = summary.byMachine.length
      ? summary.byMachine.map((row) => `<span class="diesel-breakdown-chip">${htmlEsc(row.machine)} · ${numberLabel(row.liters)} ลิตร</span>`).join('')
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
      const name = input.value.trim();
      if (!name) throw new Error('กรุณาระบุชื่อเครื่องจักร');
      await api('/api/diesel/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      input.value = '';
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
