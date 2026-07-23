const authFlowHash = window.location.hash;
const authFlowParams = new URLSearchParams(authFlowHash.slice(1));

if (authFlowParams.has('access_token') && authFlowParams.has('refresh_token')) {
  window.location.replace(`/accept-invite.html${authFlowHash}`);
}

const form = document.getElementById('loginForm');
const button = document.getElementById('loginButton');
const errorBox = document.getElementById('loginError');
const password = document.getElementById('password');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

fetch('/api/auth/session', { credentials: 'same-origin' })
  .then((response) => { if (response.ok) window.location.replace('/'); })
  .catch(() => {});

document.getElementById('togglePassword').addEventListener('click', (event) => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  event.currentTarget.textContent = visible ? 'แสดง' : 'ซ่อน';
  event.currentTarget.setAttribute('aria-label', visible ? 'แสดงรหัสผ่าน' : 'ซ่อนรหัสผ่าน');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = 'กำลังเข้าสู่ระบบ...';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: password.value,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'ไม่สามารถเข้าสู่ระบบได้');
    window.location.replace('/');
  } catch (error) {
    showError(error.message || 'ไม่สามารถเชื่อมต่อระบบได้');
    button.disabled = false;
    button.textContent = 'เข้าสู่ GP1 Connect';
  }
});
