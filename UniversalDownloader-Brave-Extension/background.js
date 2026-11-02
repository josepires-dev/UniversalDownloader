'use strict';
importScripts('shared.js');

const IG_DOMAINS = ['instagram.com'];
const YT_DOMAINS = ['youtube.com'];
let running = 0;
let keepTimer = null;

// MV3 service worker dies after ~30s idle; any extension API call resets the timer.
function keepAliveOn() { if (!keepTimer) keepTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000); }
function keepAliveOff() { if (running === 0 && keepTimer) { clearInterval(keepTimer); keepTimer = null; } }

function report(job, state) {
  const full = { ...state, id: job.id, at: Date.now() };
  chrome.storage.session.set({ [`job:${job.source}`]: full }).catch(() => {});
  if (job.source === 'tab' && typeof job.tabId === 'number') {
    chrome.tabs.sendMessage(job.tabId, { type: 'ud-status', requestId: job.id, ...full }).catch(() => {});
  }
}

async function runJob(job) {
  running++; keepAliveOn();
  try {
    report(job, { phase: 'start', message: 'A ligar ao servidor...' });
    const domains = job.endpoint === '/api/insta-download' ? IG_DOMAINS : YT_DOMAINS;
    const cookies_text = await UD.getCookiesText(domains);
    const file = await UD.runStream(job.endpoint, { ...job.payload, cookies_text }, (name, data) => {
      if (name === 'progress' && Number.isFinite(Number(data.percent))) report(job, { phase: 'progress', percent: Math.round(data.percent), message: `A transferir: ${Math.round(data.percent)}%` });
      else if (name === 'status') report(job, { phase: 'status', message: String(data.message || '').slice(0, 200) });
    });
    const downloadId = await chrome.downloads.download({ url: file.url, filename: file.filename, conflictAction: 'uniquify', saveAs: false });
    report(job, { phase: 'done', message: file.filename, filename: file.filename, downloadId });
    return { ok: true, filename: file.filename, downloadId };
  } catch (err) {
    const message = String((err && err.message) || 'O download falhou.');
    report(job, { phase: 'error', message });
    return { ok: false, error: message };
  } finally { running--; keepAliveOff(); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ud-job') {
    const endpoint = msg.endpoint;
    if (!['/api/insta-download', '/api/stream-download'].includes(endpoint) || typeof msg.payload?.url !== 'string') {
      sendResponse({ ok: false, error: 'Pedido inválido.' }); return false;
    }
    if (endpoint === '/api/insta-download') {
      let host; try { host = new URL(msg.payload.url); } catch { host = null; }
      if (!host || host.protocol !== 'https:' || !/(^|\.)instagram\.com$/.test(host.hostname)) {
        sendResponse({ ok: false, error: 'A publicação não tem um endereço válido do Instagram.' }); return false;
      }
    }
    const source = sender.tab ? 'tab' : 'popup';
    const job = { id: String(msg.requestId || `${source}-${Date.now()}`), source, tabId: sender.tab?.id, endpoint, payload: msg.payload };
    runJob(job).then(sendResponse);
    return true;
  }
  return false;
});
