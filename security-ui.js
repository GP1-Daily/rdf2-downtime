(async () => {
  const levels = { viewer: 1, operator: 2, supervisor: 3, admin: 4 };
  try {
    const data = await api('/api/auth/session');
    const user = data.user;
    document.body.dataset.role = user.role;
    document.getElementById('topbarUserName').textContent = user.displayName;
    document.getElementById('topbarUserRole').textContent = user.role;
    document.getElementById('topbarUser').hidden = false;
    document.getElementById('securityAdminLink').hidden = user.role !== 'admin';
    document.querySelectorAll('[data-min-role]').forEach((element) => {
      element.hidden = levels[user.role] < levels[element.dataset.minRole];
    });
    if (user.role === 'viewer') {
      const entryMode = document.querySelector('[data-workspace-mode="entry"]');
      const insightMode = document.querySelector('[data-workspace-mode="insights"]');
      const entryPanel = document.querySelector('[data-workspace-panel="entry"]');
      const insightPanel = document.querySelector('[data-workspace-panel="insights"]');
      entryMode.hidden = true;
      entryMode.setAttribute('aria-selected', 'false');
      insightMode.setAttribute('aria-selected', 'true');
      entryPanel.hidden = true;
      insightPanel.hidden = false;
    }
  } catch (error) {
    if (!location.pathname.endsWith('/login.html')) toast(error.message, true);
  }
})();

document.getElementById('appLogoutButton').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  } catch {}
  location.replace('/login.html');
});

document.getElementById('securityLauncherItem').addEventListener('click', () => {
  location.href = '/security.html';
});
