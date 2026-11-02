'use strict';
// Shared by popup (script tag) and background (importScripts).
const UD = (() => {
  const API_BASE = 'http://127.0.0.1:3000';
  const HOST_NAME = 'com.universaldownloader.launcher';
  const NOT_INSTALLED = 'Servidor desligado e o arranque automático não está instalado. Corre instalar.bat (pasta UniversalDownloader) uma vez e tenta de novo.';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ping() {
    try {
      const r = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  // Server up? If not, ask the native launcher to start it, then wait.
  async function ensureServer() {
    if (await ping()) return;
    let reply;
    try { reply = await chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'start' }); }
    catch { throw new Error(NOT_INSTALLED); }
    if (!reply?.ok) throw new Error(reply?.error || NOT_INSTALLED);
    for (let i = 0; i < 20; i++) { if (await ping()) return; await sleep(250); }
    throw new Error('O servidor não respondeu depois de arrancar.');
  }

  async function getCookiesText(domains) {
    const sets = await Promise.all(domains.map((domain) => chrome.cookies.getAll({ domain })));
    const unique = new Map();
    for (const c of sets.flat()) unique.set(`${c.domain}\t${c.path}\t${c.name}`, c);
    const clean = (s) => String(s).replace(/[\t\r\n]/g, '');
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of unique.values()) {
      lines.push([
        c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
        c.expirationDate ? Math.floor(c.expirationDate) : 0, clean(c.name), clean(c.value)
      ].join('\t'));
    }
    return lines.join('\n');
  }

  async function readError(response) {
    try { const b = await response.json(); return typeof b.error === 'string' ? b.error : `Erro do servidor (${response.status}).`; }
    catch { return `Erro do servidor local (${response.status}).`; }
  }

  async function postJson(path, payload) {
    await ensureServer();
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120000)
      });
    } catch { throw new Error('Sem resposta do servidor local.'); }
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  }

  function parseEvent(block) {
    let name = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return null; // comment/heartbeat
    try { return { name, data: JSON.parse(data.join('\n')) }; }
    catch { throw new Error('O servidor local devolveu uma resposta inválida.'); }
  }

  // POST -> SSE stream -> { downloadUrl, filename }. onEvent(name, data) for status/progress.
  async function runStream(endpoint, payload, onEvent) {
    await ensureServer();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60 * 60 * 1000);
    try {
      let response;
      try {
        response = await fetch(`${API_BASE}${endpoint}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          credentials: 'omit', redirect: 'error', signal: ctl.signal
        });
      } catch { throw new Error('Sem resposta do servidor local.'); }
      if (!response.ok) throw new Error(await readError(response));
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('O servidor local não iniciou a transferência.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', result = null;
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const ev = parseEvent(block);
          if (!ev) continue;
          if (ev.name === 'error') throw new Error(ev.data.error || 'O servidor não conseguiu obter o conteúdo.');
          if (ev.name === 'complete') result = ev.data; else onEvent?.(ev.name, ev.data);
        }
        if (done) break;
      }
      if (!result?.downloadUrl || !result?.filename) throw new Error('O servidor terminou sem indicar o ficheiro.');
      const url = new URL(result.downloadUrl, API_BASE);
      if (url.origin !== API_BASE) throw new Error('O servidor devolveu um endereço de ficheiro inesperado.');
      return { url: url.href, filename: safeFilename(result.filename) };
    } finally { clearTimeout(timer); }
  }

  function safeFilename(name, fallback = 'media') {
    const base = String(name || fallback).split(/[\\/]/).pop()
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
    return base || fallback;
  }

  return { API_BASE, HOST_NAME, ensureServer, ping, getCookiesText, postJson, runStream, safeFilename, parseEvent };
})();
if (typeof module !== 'undefined') module.exports = UD;
