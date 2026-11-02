'use strict';
// Universal Downloader - diagnóstico automático.
// Quando algo falha, grava um relatório .md detalhado em Downloads/UniversalDownloader-erros/
(() => {
  if (self.__udDiag) return;
  self.__udDiag = true;
  const IS_POPUP = typeof document !== 'undefined';
  const CTX = IS_POPUP ? 'popup' : 'service-worker';
  const API = 'http://127.0.0.1:3000';
  const HOST = 'com.universaldownloader.launcher';
  const KEY = 'ud-diag:' + CTX;
  const MAX = 200;
  const DEDUPE_MS = 60000;
  const origFetch = self.fetch.bind(self);
  const origDownload = chrome.downloads && chrome.downloads.download ? chrome.downloads.download.bind(chrome.downloads) : null;
  const ownDownloads = new Set();
  const F = '```';
  let log = [];
  let saveTimer = null;

  const pad = (n) => String(n).padStart(2, '0');
  const trunc = (s, n = 600) => { s = String(s); return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' car.]' : s; };
  const redact = (s) => String(s)
    .replace(/("?cookies_text"?\s*[:=]\s*)"(?:[^"\\]|\\.)*"/g, '$1"[REMOVIDO]"')
    .replace(/(sessionid|csrftoken|SAPISID|LOGIN_INFO|__Secure-[\w-]+)=[^;\s"]+/gi, '$1=[REMOVIDO]');
  const ser = (v) => {
    try {
      if (v instanceof Error) return v.name + ': ' + v.message + '\n' + (v.stack || '');
      if (typeof v === 'string') return v;
      return JSON.stringify(v);
    } catch { return String(v); }
  };
  const safe = async (fn) => { try { return await fn(); } catch (e) { return 'indisponível: ' + (e && e.message ? e.message : e); } };
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const stripQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?[query removida]' : ''); } catch { return String(u || ''); } };

  const restored = (chrome.storage && chrome.storage.session)
    ? chrome.storage.session.get(KEY).then((r) => { const old = r && r[KEY]; if (Array.isArray(old)) log = old.concat(log).slice(-MAX); }).catch(() => {})
    : Promise.resolve();
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { chrome.storage.session.set({ [KEY]: log.slice(-80) }).catch(() => {}); } catch {}
    }, 500);
  }
  function add(kind, msg, extra) {
    const m = trunc(redact(msg), 1500);
    const last = log[log.length - 1];
    if (last && last.kind === kind && last.msg === m) { last.n = (last.n || 1) + 1; last.t2 = Date.now(); persist(); return; }
    log.push({ t: Date.now(), kind, msg: m, extra: extra === undefined ? undefined : trunc(redact(ser(extra)), 3000) });
    if (log.length > MAX) log.shift();
    persist();
  }

  // ---------- captura passiva ----------
  for (const lvl of ['error', 'warn']) {
    const o = console[lvl].bind(console);
    console[lvl] = (...a) => { try { add('console.' + lvl, a.map(ser).join(' ')); } catch {} o(...a); };
  }
  self.addEventListener('error', (e) => {
    add('erro-global', e.message + ' @ ' + baseName(e.filename) + ':' + e.lineno + ':' + e.colno, e.error);
    report('Erro de JavaScript não tratado', e.message, { stack: e.error && e.error.stack, ficheiro: baseName(e.filename), linha: e.lineno, coluna: e.colno });
  });
  self.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    add('promessa-rejeitada', r && r.message ? r.message : ser(r), r);
    report('Promessa rejeitada sem tratamento', r && r.message ? r.message : ser(r), { stack: r && r.stack });
  });

  function summarizeBody(body) {
    try {
      const o = JSON.parse(body);
      if (typeof o.cookies_text === 'string') o.cookies_text = '[REMOVIDO: ' + o.cookies_text.split('\n').length + ' linhas]';
      return JSON.stringify(o);
    } catch { return trunc(body, 300); }
  }
  async function tapSse(res, url) {
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', lastBucket = -1;
      for (;;) {
        const { done, value } = await reader.read();
        buf += dec.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buf.replace(/\r\n/g, '\n').split('\n\n');
        buf = blocks.pop() || '';
        for (const b of blocks) {
          let name = 'message'; const data = [];
          for (const line of b.split('\n')) { if (line.startsWith('event:')) name = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trim()); }
          if (!data.length) continue;
          if (name === 'progress') {
            let p; try { p = Math.floor(Number(JSON.parse(data.join('\n')).percent) / 20); } catch {}
            if (p === lastBucket) continue; lastBucket = p;
          }
          add('sse:' + name, url.replace(API, ''), data.join('\n'));
        }
        if (done) { add('sse', 'stream terminou ' + url.replace(API, '')); break; }
      }
    } catch (e) { add('sse-falhou', url.replace(API, ''), e); }
  }
  self.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const isApi = url.startsWith(API);
    const started = Date.now();
    const body = isApi && init && typeof init.body === 'string' ? summarizeBody(init.body) : '';
    try {
      const res = await origFetch(input, init);
      if (isApi) {
        const ct = res.headers.get('content-type') || '';
        add('fetch', method + ' ' + url.replace(API, '') + ' -> ' + res.status + ' [' + ct + ']', { ms: Date.now() - started, pedido: body || undefined });
        if (!res.ok) { try { add('fetch-corpo-erro', res.status + ' ' + url.replace(API, ''), await res.clone().text()); } catch {} }
        else if (ct.includes('text/event-stream') && res.body) tapSse(res.clone(), url);
      }
      return res;
    } catch (e) {
      if (isApi) add('fetch-falhou', method + ' ' + url.replace(API, '') + ' falhou: ' + (e && e.message), { ms: Date.now() - started, erro: e, pedido: body || undefined });
      throw e;
    }
  };
  if (chrome.runtime && chrome.runtime.sendNativeMessage) {
    const orig = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
    chrome.runtime.sendNativeMessage = function (host, msg, cb) {
      const p = orig(host, msg).then(
        (r) => { add('native', 'sendNativeMessage ' + host + ' respondeu', { enviado: msg, resposta: r }); return r; },
        (e) => { add('native-falhou', 'sendNativeMessage ' + host + ' falhou: ' + (e && e.message), e); throw e; }
      );
      if (typeof cb === 'function') { p.then(cb, () => cb()); return; }
      return p;
    };
  }
  if (origDownload) {
    chrome.downloads.download = function (opts, cb) {
      const p = origDownload(opts).then(
        (id) => { add('downloads.download', 'iniciado id=' + id + ' ficheiro=' + baseName(opts && opts.filename), { url: stripQuery(opts && opts.url) }); return id; },
        (e) => { add('downloads.download-falhou', 'falhou: ' + (e && e.message), { ficheiro: baseName(opts && opts.filename), url: stripQuery(opts && opts.url) }); throw e; }
      );
      if (typeof cb === 'function') { p.then(cb, () => cb()); return; }
      return p;
    };
  }

  // ---------- recolha de contexto ----------
  async function health() {
    const out = {};
    const s = Date.now();
    try {
      const r = await origFetch(API + '/api/health', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      out['/api/health'] = { status: r.status, ms: Date.now() - s, corpo: trunc(await r.text(), 500) };
    } catch (e) { out['/api/health'] = { falhou: String(e && e.message || e), ms: Date.now() - s }; }
    return out;
  }
  async function cookieInfo() {
    const want = { 'instagram.com': ['sessionid', 'csrftoken', 'ds_user_id'], 'youtube.com': ['SAPISID', '__Secure-3PSID', 'LOGIN_INFO', 'VISITOR_INFO1_LIVE'] };
    const out = {};
    for (const d of Object.keys(want)) {
      const list = await chrome.cookies.getAll({ domain: d });
      const names = new Set(list.map((c) => c.name));
      out[d] = { total: list.length, presentes: want[d].filter((n) => names.has(n)), ausentes: want[d].filter((n) => !names.has(n)) };
    }
    return out;
  }
  async function tabInfo(tab) {
    if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ? { url: stripQuery(tab.url), titulo: trunc(tab.title || '', 120), estado: tab.status, id: tab.id } : 'sem separador ativo';
  }
  async function jobStates() {
    const all = await chrome.storage.session.get(null);
    const out = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith('job:')) out[k] = v;
    return out;
  }
  async function recentDownloads() {
    const items = await chrome.downloads.search({ limit: 6, orderBy: ['-startTime'] });
    return items.map((i) => ({ id: i.id, estado: i.state, erro: i.error, ficheiro: baseName(i.filename), recebido: i.bytesReceived, total: i.totalBytes, mime: i.mime, inicio: i.startTime, perigo: i.danger }));
  }
  async function platform() { return chrome.runtime.getPlatformInfo(); }

  // ---------- análise automática ----------
  function analyze(text, env) {
    const out = [];
    const t = text;
    const id = env.id;
    const has = (re) => re.test(t);
    if (has(/native messaging host not found/i)) out.push(['O Brave não encontra o launcher nativo (' + HOST + ').', ['Correr instalar.bat (pasta UniversalDownloader) outra vez.', 'Verificar o registo: HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\' + HOST + ' (algumas instalações só criam a chave do Chrome).', 'Confirmar que o caminho do .json do host no registo existe mesmo.']]);
    if (has(/forbidden/i) && has(/native/i)) out.push(['O launcher nativo recusa esta extensão (allowed_origins).', ['Confirmar que o .json do host tem "chrome-extension://' + id + '/" em allowed_origins.']]);
    if (has(/host has exited|Error when communicating with the native messaging host/i)) out.push(['O launcher nativo arrancou mas fechou/crashou.', ['Correr o launcher à mão numa consola para ver o erro.', 'Ver se Node/Python estão no PATH do utilizador.']]);
    if (has(/arranque automático não está instalado/i)) out.push(['O servidor estava desligado e não foi possível arrancá-lo via launcher.', ['Ver a entrada "native-falhou" na cronologia: tem o erro real.', 'Arrancar o servidor à mão (pasta UniversalDownloader) para testar.']]);
    if (has(/não respondeu depois de arrancar/i)) out.push(['O launcher disse que arrancou, mas a porta 3000 nunca respondeu.', ['Ver se a porta 3000 está ocupada: netstat -ano | findstr :3000', 'Ver o log/consola do servidor por erros no arranque.']]);
    if (has(/Sem resposta do servidor local|Failed to fetch|NetworkError|fetch-falhou/i)) out.push(['Ligação ao servidor local (127.0.0.1:3000) falhou ou caiu a meio.', ['Ver a secção "Servidor local" abaixo.', 'Ver se antivírus/firewall bloqueiam o servidor.']]);
    if (has(/\b403\b|Sign in to confirm|not a bot|login required|cookies|\b429\b|Too Many Requests|rate.?limit/i)) out.push(['Possível bloqueio/autenticação do Instagram ou YouTube.', ['Ver secção "Cookies": confirmar sessão iniciada no MESMO perfil do Brave.', 'Atualizar o yt-dlp (yt-dlp -U ou pip install -U yt-dlp).']]);
    if (has(/ffmpeg|ffprobe/i)) out.push(['Falta ou falha o ffmpeg no servidor.', ['Instalar ffmpeg e pô-lo no PATH.']]);
    if (has(/Requested format is not available|format/i)) out.push(['Formato/qualidade pedida não disponível.', ['Tentar "Melhor qualidade".', 'Atualizar o yt-dlp.']]);
    if (has(/yt-dlp|Unsupported URL|Unable to extract|ERROR:/i)) out.push(['Erro vindo do yt-dlp/servidor ao extrair o conteúdo.', ['Atualizar o yt-dlp.', 'Ver o corpo do erro na cronologia (sse:error / fetch-corpo-erro).']]);
    if (has(/Extension context invalidated/i)) out.push(['A extensão foi recarregada com a página aberta.', ['Recarregar (F5) o separador do Instagram.']]);
    if (has(/NETWORK_|SERVER_|FILE_|interrupted|USER_/i)) out.push(['O Brave interrompeu o download já iniciado.', ['Ver "Downloads recentes" (campo erro).', 'Verificar espaço em disco, permissões da pasta e antivírus.']]);
    if (has(/resposta inválida|terminou sem indicar o ficheiro|não iniciou a transferência|endereço de ficheiro inesperado/i)) out.push(['Protocolo servidor ↔ extensão inconsistente (versões diferentes?).', ['Comparar o servidor com o shared.js (eventos SSE "complete" com downloadUrl e filename).']]);
    if (has(/endereço válido do Instagram|Pedido inválido/i)) out.push(['O URL enviado não passou na validação.', ['Ver o URL da aba nesta página; a publicação pode ter um formato novo.']]);
    return out;
  }

  function buildMd(r) {
    const { title, msg, details, env, now } = r;
    const J = (v) => F + 'json\n' + redact(JSON.stringify(v, null, 2)) + '\n' + F;
    const clock = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
    const tail = log.slice(-80);
    const corpus = [msg, ser(details), ...tail.map((e) => e.kind + ' ' + e.msg + ' ' + (e.extra || ''))].join('\n');
    const causes = analyze(corpus, env);
    const L = [];
    L.push('# Relatório de erro – Universal Downloader', '', '> Gerado automaticamente em ' + new Date(now).toLocaleString('pt-PT') + ' (' + new Date(now).toISOString() + '). Dá este ficheiro ao Claude e pede para corrigir o problema.', '');
    L.push('## 1. Resumo', '', '- **Tipo:** ' + title, '- **Mensagem:** ' + msg, '- **Contexto:** ' + CTX, '- **Versão da extensão:** ' + (env.manifest && env.manifest.version), '- **ID da extensão:** ' + env.id, '');
    L.push('## 2. Causas prováveis (análise automática)', '');
    if (causes.length) causes.forEach(([c, steps], i) => { L.push((i + 1) + '. **' + c + '**'); steps.forEach((s) => L.push('   - ' + s)); });
    else L.push('Nenhuma causa conhecida reconhecida. Analisar a cronologia (secção 6) e o stack trace (secção 4).');
    L.push('', '## 3. Servidor local', '', J(env.health), '');
    L.push('## 4. Detalhes técnicos do erro', '', details === undefined ? '(sem detalhes adicionais)' : J(details), '');
    L.push('## 5. Estado dos jobs (chrome.storage.session)', '', J(env.jobs), '');
    L.push('## 6. Cronologia (mais antigo → mais recente)', '', 'Relatório gerado a ' + clock(now) + '. Linhas repetidas aparecem agrupadas (×n).', '');
    for (const e of tail) {
      L.push('- `' + clock(e.t) + '` **' + e.kind + '** ' + e.msg + (e.n > 1 ? ' (×' + e.n + ')' : ''));
      if (e.extra) L.push('  - ' + trunc(e.extra.replace(/\s*\n\s*/g, ' ⏎ '), 1200));
    }
    L.push('', '## 7. Cookies (apenas presença, sem valores)', '', J(env.cookies), '');
    L.push('## 8. Separador ativo', '', J(env.tab), '');
    L.push('## 9. Downloads recentes do navegador', '', J(env.downloads), '');
    L.push('## 10. Ambiente', '', J({ userAgent: env.ua, plataforma: env.platform, idioma: env.lang, fusoHorario: env.tz, permissoes: env.manifest && env.manifest.permissions, hosts: env.manifest && env.manifest.host_permissions, hostNativo: HOST, api: API }), '');
    L.push('## 11. Para quem vai analisar', '', 'Ficheiros relevantes (pasta UniversalDownloader-Brave-Extension): background.js (jobs/downloads), shared.js (servidor, SSE, native messaging), popup.js, instagram-content.js, diagnostics.js (este relatório), sw.js. O servidor local fica na pasta UniversalDownloader. Cookies e valores sensíveis foram removidos deste relatório.', '');
    return L.join('\n');
  }

  // ---------- geração do relatório ----------
  async function report(title, message, details, tab) {
    try {
      await restored;
      const msg = String(message || title);
      const key = msg.slice(0, 200);
      const last = ((await chrome.storage.session.get('ud-diag:last').catch(() => ({})))['ud-diag:last']) || {};
      if (last.key === key && Date.now() - last.at < DEDUPE_MS) return last.file || null;
      await chrome.storage.session.set({ 'ud-diag:last': { key, at: Date.now() } }).catch(() => {});
      const now = Date.now();
      const manifest = await safe(() => chrome.runtime.getManifest());
      const env = {
        id: chrome.runtime.id,
        manifest: typeof manifest === 'object' ? { version: manifest.version, permissions: manifest.permissions, host_permissions: manifest.host_permissions } : manifest,
        ua: navigator.userAgent, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: await safe(platform), health: await safe(health), cookies: await safe(cookieInfo),
        tab: await safe(() => tabInfo(tab)), jobs: await safe(jobStates), downloads: await safe(recentDownloads)
      };
      const md = buildMd({ title, msg, details, env, now });
      const d = new Date(now);
      const file = 'UniversalDownloader-erros/erro-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds()) + '.md';
      const id = await origDownload({ url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md), filename: file, conflictAction: 'uniquify', saveAs: false });
      ownDownloads.add(id);
      await chrome.storage.session.set({ 'ud-diag:last': { key, at: Date.now(), file } }).catch(() => {});
      try { chrome.action.setBadgeBackgroundColor({ color: '#d93025' }); chrome.action.setBadgeText({ text: '!' }); } catch {}
      return file;
    } catch (e) { try { console.log('[UD diag] não consegui gerar o relatório', e); } catch {} return null; }
  }

  // ---------- gatilhos ----------
  if (!IS_POPUP) {
    const seen = {};
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      for (const [k, v] of Object.entries(changes)) {
        if (!k.startsWith('job:') || !v.newValue) continue;
        const j = v.newValue;
        const sig = j.phase + ':' + (Number.isFinite(j.percent) ? Math.floor(j.percent / 20) : '');
        if (j.phase === 'error') report('Erro num download (' + k + ')', j.message, { job: j });
        else if (seen[k] !== sig) { seen[k] = sig; add('job', k + ' fase=' + j.phase + ' ' + (j.message || '')); }
      }
    });
    chrome.downloads.onChanged.addListener(async (d) => {
      if (ownDownloads.has(d.id)) return;
      if (d.state && d.state.current === 'interrupted') {
        const [it] = await chrome.downloads.search({ id: d.id }).catch(() => []);
        const reason = (it && it.error) || (d.error && d.error.current) || 'motivo desconhecido';
        add('download-interrompido', 'id=' + d.id + ' motivo=' + reason);
        report('Download interrompido pelo navegador', 'Download interrompido: ' + reason, { item: it && { id: it.id, erro: it.error, ficheiro: baseName(it.filename), recebido: it.bytesReceived, total: it.totalBytes } });
      } else if (d.state && d.state.current === 'complete') add('download', 'id=' + d.id + ' concluído');
    });
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === 'ud-diag-event') {
        add(msg.kind || 'content-script', msg.message, { stack: msg.stack, pagina: msg.page, readyState: msg.readyState });
        report('Erro no content script (' + (msg.kind || '?') + ')', msg.message, { stack: msg.stack, pagina: msg.page, readyState: msg.readyState, ua: msg.ua }, sender && sender.tab);
      }
      return false;
    });
    add('arranque', 'service worker iniciado v' + (chrome.runtime.getManifest().version));
  } else {
    try { chrome.action.setBadgeText({ text: '' }); } catch {}
    const statusEl = document.getElementById('status');
    let timer = null;
    const check = () => {
      if (!statusEl || statusEl.dataset.kind !== 'error') return;
      const text = statusEl.textContent.trim();
      if (!text || text.includes('Relatório de erro guardado')) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const saved = ((await chrome.storage.session.get('job:popup').catch(() => ({})))['job:popup']);
        if (saved && saved.phase === 'error' && saved.message === text) return; // o service worker já reporta este
        await report('Erro mostrado no popup', text, { servidorLigado: document.getElementById('server') && document.getElementById('server').dataset.on });
      }, 400);
    };
    if (statusEl) new MutationObserver(check).observe(statusEl, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-kind'] });
    chrome.storage.onChanged.addListener((changes, area) => {
      const v = area === 'session' && changes['ud-diag:last'] && changes['ud-diag:last'].newValue;
      if (v && v.file && statusEl && statusEl.dataset.kind === 'error' && !statusEl.textContent.includes('Relatório de erro guardado')) {
        statusEl.textContent = statusEl.textContent + '  ·  Relatório de erro guardado em Downloads/' + v.file;
      }
    });
  }
})();
