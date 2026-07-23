const { ROLE_LEVEL } = require('./auth');

function requiredRole(pathname, method) {
  if (pathname.startsWith('/api/security/')) return 'admin';
  if (method === 'GET' || method === 'HEAD') return 'viewer';
  if (method === 'DELETE') return 'supervisor';
  if (
    pathname.startsWith('/api/yield')
    || pathname.startsWith('/api/stock')
    || pathname.startsWith('/api/delivery-plans')
    || pathname.startsWith('/api/revenue/customers')
    || pathname.startsWith('/api/revenue/prices')
    || pathname.startsWith('/api/revenue/tipping-settings')
    || pathname.startsWith('/api/kpi/targets')
  ) return 'supervisor';
  return 'operator';
}

function hasRole(user, required) {
  return Boolean(user && ROLE_LEVEL[user.role] >= ROLE_LEVEL[required]);
}

module.exports = { requiredRole, hasRole };
