'use strict';
// Content script de diagnóstico: envia erros do próprio script para o service worker gerar o relatório.
(() => {
  const send = (kind, message, stack) => {
    try {
      chrome.runtime.sendMessage({ type: 'ud-diag-event', kind, message: String(message).slice(0, 2000), stack: String(stack || '').slice(0, 4000), page: location.origin + location.pathname, readyState: document.readyState, ua: navigator.userAgent }).catch(() => {});
    } catch {}
  };
  window.addEventListener('error', (e) => {
    if (e.filename && !String(e.filename).startsWith('chrome-extension://')) return;
    send('erro-content-script', e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const stack = r && r.stack;
    if (!stack || !String(stack).includes('chrome-extension://')) return;
    send('rejeicao-content-script', (r && r.message) || r, stack);
  });
})();
