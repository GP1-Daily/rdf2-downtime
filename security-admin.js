let currentUser = null;

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )gp1_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.method && opts.method !== 'GET') {
    opts.headers = { ...(opts.headers || {}), 'X-CSRF-Token': csrfToken() };
  }
  const response = await fetch(path, opts);
  if (response.status === 401) {
    window.location.replace('/login.html');
    throw new Error('Session หมดอายุ');
  }
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'ไม่สามารถดำเนินการได้');
  return data;
}

function toast(message, error = false) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.className = `admin-toast show${error ? ' error' : ''}`;
  setTimeout(() => { element.className = 'admin-toast'; }, 3000);
}

function fmtDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

async function loadSession() {
  const data = await api('/api/auth/session');
  currentUser = data.user;
  if (currentUser.role !== 'admin') return window.location.replace('/');
  document.getElementById('accountName').textContent = currentUser.displayName;
  document.getElementById('accountRole').textContent = currentUser.role;
}

async function loadStatus() {
  const data = await api('/api/security/status');
  const values = [
    [data.authEnabled ? (data.authConfigured ? 'พร้อมใช้งาน' : 'ต้องตั้งค่า') : 'Local development', data.authEnabled ? data.authConfigured : true],
    [data.database === 'postgres' ? 'PostgreSQL' : 'Local Excel', data.database === 'postgres'],
    [data.verifiedDatabaseTls === null ? 'ไม่เกี่ยวข้อง' : (data.verifiedDatabaseTls ? 'ตรวจสอบ Certificate' : 'ไม่ปลอดภัย'), data.verifiedDatabaseTls !== false],
    [data.scheduledBackupConfigured ? 'พร้อมใช้งาน' : 'ยังไม่ตั้งค่า', data.scheduledBackupConfigured],
  ];
  document.querySelectorAll('#securityStatus strong').forEach((node, index) => {
    node.textContent = values[index][0];
    node.className = values[index][1] ? 'ok' : 'warn';
  });
}

async function loadUsers() {
  const data = await api('/api/security/users');
  const body = document.getElementById('usersBody');
  body.replaceChildren();
  if (!data.rows.length) {
    const row = document.createElement('tr');
    const empty = cell('ยังไม่มีบัญชีผู้ใช้ในฐานข้อมูล');
    empty.colSpan = 5;
    row.append(empty);
    body.append(row);
    return;
  }
  for (const user of data.rows) {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = user.displayName;
    const email = document.createElement('small');
    email.textContent = user.email;
    identity.append(name, email);
    const roleCell = document.createElement('td');
    const select = document.createElement('select');
    for (const role of ['viewer', 'operator', 'supervisor', 'admin']) {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role[0].toUpperCase() + role.slice(1);
      option.selected = user.role === role;
      select.append(option);
    }
    roleCell.append(select);
    const activeCell = document.createElement('td');
    const active = document.createElement('input');
    active.type = 'checkbox';
    active.checked = user.active;
    active.setAttribute('aria-label', `เปิดใช้งาน ${user.email}`);
    activeCell.append(active);
    const updated = cell(fmtDate(user.updatedAt || user.createdAt));
    const action = document.createElement('td');
    action.className = 'user-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'save-user';
    save.textContent = 'บันทึก';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api(`/api/security/users/${user.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: select.value, active: active.checked }),
        });
        toast('อัปเดตสิทธิ์เรียบร้อย');
        await loadUsers();
      } catch (error) { toast(error.message, true); } finally { save.disabled = false; }
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-user';
    reset.textContent = 'ตั้งรหัสใหม่';
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      try {
        await api(`/api/security/users/${user.id}/reset-password`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        toast('ส่งลิงก์ตั้งรหัสผ่านใหม่แล้ว');
      } catch (error) { toast(error.message, true); } finally { reset.disabled = false; }
    });
    action.append(save, reset);
    row.append(identity, roleCell, activeCell, updated, action);
    body.append(row);
  }
}

async function loadTrash() {
  const data = await api('/api/security/trash?limit=200');
  const body = document.getElementById('trashBody');
  body.replaceChildren();
  if (!data.rows.length) {
    const row = document.createElement('tr');
    const empty = cell('ไม่มีรายการที่รอกู้คืน');
    empty.colSpan = 5;
    row.append(empty);
    return body.append(row);
  }
  for (const item of data.rows) {
    const row = document.createElement('tr');
    row.append(cell(item.Entity), cell(item.OriginalID), cell(item.DeletedByEmail || item.DeletedBy), cell(fmtDate(item.DeletedAt)));
    const action = document.createElement('td');
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'restore-button';
    restore.textContent = 'กู้คืน';
    restore.addEventListener('click', async () => {
      if (!window.confirm(`กู้คืน ${item.Entity} รหัส ${item.OriginalID}?`)) return;
      restore.disabled = true;
      try {
        await api(`/api/security/trash/${item.ID}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        toast('กู้คืนข้อมูลเรียบร้อย');
        await Promise.all([loadTrash(), loadAudit()]);
      } catch (error) { toast(error.message, true); } finally { restore.disabled = false; }
    });
    action.append(restore);
    row.append(action);
    body.append(row);
  }
}

async function loadAudit() {
  const data = await api('/api/security/audit?limit=200');
  const body = document.getElementById('auditBody');
  body.replaceChildren();
  for (const item of data.rows) {
    const row = document.createElement('tr');
    const actionCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `audit-action${String(item.Action).includes('DELETE') ? ' delete' : ''}`;
    badge.textContent = item.Action;
    actionCell.append(badge);
    row.append(cell(fmtDate(item.CreatedAt)), actionCell, cell(`${item.Entity}${item.RecordID ? ` #${item.RecordID}` : ''}`), cell(item.ActorEmail || item.ActorUserID || '-'), cell(item.RequestID || '-'));
    body.append(row);
  }
}

document.getElementById('inviteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.getElementById('userMessage');
  message.hidden = true;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('/api/security/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: document.getElementById('inviteName').value,
        email: document.getElementById('inviteEmail').value,
        role: document.getElementById('inviteRole').value,
      }),
    });
    event.currentTarget.reset();
    message.textContent = 'ส่งคำเชิญแล้ว ผู้ใช้จะได้รับอีเมลสำหรับตั้งรหัสผ่าน';
    message.className = 'inline-message';
    message.hidden = false;
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'inline-message error';
    message.hidden = false;
  } finally { submit.disabled = false; }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
  window.location.replace('/login.html');
});
document.getElementById('backupButton').addEventListener('click', () => { window.location.href = '/api/security/backup'; });
document.getElementById('refreshTrash').addEventListener('click', () => loadTrash().catch((error) => toast(error.message, true)));
document.getElementById('refreshAudit').addEventListener('click', () => loadAudit().catch((error) => toast(error.message, true)));

(async () => {
  try {
    await loadSession();
    await Promise.all([loadStatus(), loadUsers(), loadTrash(), loadAudit()]);
  } catch (error) { toast(error.message, true); }
})();
