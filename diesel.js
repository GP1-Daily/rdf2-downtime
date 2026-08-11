(() => {
  const panel = document.getElementById('tab-diesel');
  if (!panel) return;

  const dateInput = document.getElementById('dieselDate');
  const machineSelect = document.getElementById('dieselMachine');
  let machines = [];
  let latestUsageRows = [];
  let latestReceiptRows = [];
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
    status.textContent = Number(summary.totalLimitLiters) > 0 ? (exceeded ? 'เกินลิมิต' : 'อยู่ในลิมิต') : 'ยังไม่มีเครื่องที่ใช้ในวันนี้';
    status.classList.toggle('danger', exceeded);
    document.getElementById('dieselDailyCount').textContent = Number(count || 0).toLocaleString('th-TH');
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
          await Promise.all([loadUsage(), loadStock()]);
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

  function renderReceiptTable(rows) {
    latestReceiptRows = rows;
    const tbody = document.getElementById('dieselReceiptTable');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="diesel-empty">ยังไม่มีรายการรับเข้าน้ำมันในวันนี้</td></tr>';
      return;
    }
    const allowDelete = canManage();
    tbody.innerHTML = rows.map((row) => `<tr>
      <td class="diesel-row-liters">${numberLabel(row.Liters)}</td>
      <td class="left">${htmlEsc(row.Reference || '-')}</td>
      <td class="left">${htmlEsc(row.Note || '-')}</td>
      <td>${allowDelete ? `<button type="button" class="danger" data-receipt-delete="${htmlEsc(row.ID)}">ลบ</button>` : '-'}</td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-receipt-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/diesel/stock/receipt/${encodeURIComponent(button.dataset.receiptDelete)}`, { method: 'DELETE' });
          await loadStock();
          toast('ลบรายการรับเข้าน้ำมันแล้ว');
        } catch (error) {
          toast(error.message, true);
        }
      });
    });
  }

  function renderStock(data) {
    const summary = data.summary || {};
    const balance = document.getElementById('dieselStockBalance');
    const status = document.getElementById('dieselStockStatus');
    document.getElementById('dieselDailyReceived').textContent = numberLabel(summary.periodReceivedLiters);
    balance.textContent = summary.configured ? numberLabel(summary.balanceLiters) : '-';
    balance.classList.toggle('danger', summary.configured && Number(summary.balanceLiters) < 0);
    status.textContent = summary.configured
      ? `ลิตร · ตั้งต้น ${numberLabel(summary.openingLiters)} ลิตร วันที่ ${summary.openingDate}`
      : 'ยังไม่ตั้งยอดตั้งต้น';
    status.classList.toggle('danger', summary.configured && Number(summary.balanceLiters) < 0);

    const baselineTarget = document.getElementById('dieselBaselineCurrent');
    if (data.baseline) {
      baselineTarget.innerHTML = `<div><span>ยอดที่ใช้คำนวณปัจจุบัน</span><strong>${numberLabel(data.baseline.OpeningLiters)} ลิตร</strong><small>${htmlEsc(data.baseline.EffectiveDate)}${data.baseline.Note ? ` · ${htmlEsc(data.baseline.Note)}` : ''}</small></div>
        <button type="button" class="danger" data-baseline-delete="${htmlEsc(data.baseline.ID)}">ลบยอดนี้</button>`;
      baselineTarget.querySelector('[data-baseline-delete]')?.addEventListener('click', async (event) => {
        if (!window.confirm('ลบยอดตั้งต้นสต๊อกนี้ใช่หรือไม่')) return;
        try {
          await api(`/api/diesel/stock/baseline/${encodeURIComponent(event.currentTarget.dataset.baselineDelete)}`, { method: 'DELETE' });
          await loadStock();
          toast('ลบยอดตั้งต้นแล้ว');
        } catch (error) {
          toast(error.message, true);
        }
      });
    } else {
      baselineTarget.textContent = 'ยังไม่ตั้งยอดสต๊อกเริ่มต้นสำหรับวันที่เลือก';
    }
    renderReceiptTable(data.rows || []);
  }

  async function loadStock() {
    const data = await api(`/api/diesel/stock?date=${encodeURIComponent(dateInput.value)}`);
    renderStock(data);
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
      await Promise.all([loadUsage(), loadStock()]);
      toast('บันทึกการใช้น้ำมันแล้ว');
    } catch (error) {
      toast(error.message, true);
    }
  });

  onClickGuarded(document.getElementById('btnAddDieselReceipt'), async () => {
    try {
      const litersInput = document.getElementById('dieselReceiptLiters');
      const liters = Number(litersInput.value);
      if (!Number.isFinite(liters) || liters <= 0) throw new Error('กรุณาระบุจำนวนน้ำมันรับเข้า');
      await api('/api/diesel/stock/receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryDate: dateInput.value,
          liters,
          reference: document.getElementById('dieselReceiptReference').value,
          note: document.getElementById('dieselReceiptNote').value,
        }),
      });
      litersInput.value = '';
      document.getElementById('dieselReceiptReference').value = '';
      document.getElementById('dieselReceiptNote').value = '';
      await loadStock();
      toast('บันทึกน้ำมันรับเข้าแล้ว');
    } catch (error) {
      toast(error.message, true);
    }
  });

  onClickGuarded(document.getElementById('btnSaveDieselBaseline'), async () => {
    try {
      const effectiveDate = document.getElementById('dieselBaselineDate').value;
      const openingLiters = Number(document.getElementById('dieselBaselineLiters').value);
      if (!effectiveDate || !Number.isFinite(openingLiters) || openingLiters < 0) {
        throw new Error('กรุณาระบุวันที่และยอดตั้งต้นให้ถูกต้อง');
      }
      await api('/api/diesel/stock/baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveDate,
          openingLiters,
          note: document.getElementById('dieselBaselineNote').value,
        }),
      });
      document.getElementById('dieselBaselineLiters').value = '';
      document.getElementById('dieselBaselineNote').value = '';
      await loadStock();
      toast('บันทึกยอดตั้งต้นสต๊อกแล้ว');
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
    document.getElementById('dieselBaselineDate').value = dateInput.value;
    Promise.all([loadUsage(), loadStock()]).catch((error) => toast(error.message, true));
  });
  document.addEventListener('gp1:sessionready', () => {
    renderUsageTable(latestUsageRows);
    renderReceiptTable(latestReceiptRows);
  });

  window.initDieselUsage = function initDieselUsage(force = false) {
    if (initPromise) return initPromise;
    if (initialized && !force) return Promise.all([loadUsage(), loadStock()]);
    if (!dateInput.value) dateInput.value = todayStr();
    if (!document.getElementById('dieselBaselineDate').value) {
      document.getElementById('dieselBaselineDate').value = dateInput.value;
    }
    initPromise = Promise.all([loadMachines(), loadUsage(), loadStock()])
      .then(() => { initialized = true; })
      .finally(() => { initPromise = null; });
    return initPromise;
  };
  if (panel.classList.contains('active')) {
    window.initDieselUsage().catch((error) => toast(error.message, true));
  }
})();
