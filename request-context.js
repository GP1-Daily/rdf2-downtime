const { AsyncLocalStorage } = require('node:async_hooks');

const requestStorage = new AsyncLocalStorage();

function runWithRequestContext(context, handler) {
  return requestStorage.run(Object.freeze({ ...context }), handler);
}

function getRequestContext() {
  return requestStorage.getStore() || {
    requestId: 'system',
    ip: '',
    userAgent: '',
    user: null,
  };
}

module.exports = { runWithRequestContext, getRequestContext };
