const params = new URLSearchParams(window.location.hash.slice(1));
const accessToken = params.get('access_token');
const refreshToken = params.get('refresh_token');
const flowType = params.get('type');
const form = document.getElementById('inviteForm');
const errorBox = document.getElementById('inviteError');
const button = document.getElementById('inviteButton');

history.replaceState(null, '', '/accept-invite.html');

if (flowType === 'recovery') {
  document.getElementById('inviteTitle').textContent = 'ตั้งรหัสผ่านใหม่';
  document.querySelector('.auth-brand span').textContent = 'ACCOUNT RECOVERY';
  document.querySelector('.auth-brand h1').innerHTML = 'กลับเข้าสู่<br>GP1 Connect';
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

if (!accessToken || !refreshToken) {
  showError('ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอให้ผู้ดูแลส่งลิงก์ใหม่');
  button.disabled = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const password = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  if (password.length < 10) return showError('รหัสผ่านต้องมีอย่างน้อย 10 ตัวอักษร');
  if (password !== confirmation) return showError('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
  button.disabled = true;
  button.textContent = 'กำลังเปิดใช้งานบัญชี...';
  try {
    const response = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, refreshToken, password }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'ไม่สามารถเปิดใช้งานบัญชีได้');
    window.location.replace('/');
  } catch (error) {
    showError(error.message);
    button.disabled = false;
    button.textContent = 'ยืนยันและเข้าสู่ระบบ';
  }
});
