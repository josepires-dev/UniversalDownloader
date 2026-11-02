(() => {
  'use strict';
  if (window.__udLoaded) return;
  window.__udLoaded = true;

  const POST_PATH = /^\/(?:[^/]+\/)?(?:p|reels?|tv)\/[^/]+/i;
  const STORY_PATH = /^\/stories\/[^/]+/i;
  const REELS_ROOT = /^\/reels\/?$/i;
  const SIZE = 44, MARGIN = 12;

  let host, button, bubble;
  let current = null;          // { mode, url, rect? }
  let busy = false, requestId = '', doneTimer = 0, raf = 0, softTimer = 0, lastStyle = '';
  let pos = { right: 24, bottom: 24 };
  let drag = null, suppressClick = false;

  // ---------- target detection ----------
  function pageTarget() {
    const p = location.pathname;
    if (STORY_PATH.test(p) || POST_PATH.test(p)) return { mode: 'page', url: location.origin + p };
    return null;
  }
  function postUrlFrom(root) {
    for (const a of root.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (u.origin === location.origin && POST_PATH.test(u.pathname)) return u.origin + u.pathname;
    }
    return null;
  }
  function clipToOverflow(el) {
    const r = el.getBoundingClientRect();
    let clip = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    let node = el.parentElement;
    while (node && node !== document.body) {
      const st = getComputedStyle(node);
      if (st.overflow !== 'visible' || st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        const pr = node.getBoundingClientRect();
        clip.left = Math.max(clip.left, pr.left);
        clip.top = Math.max(clip.top, pr.top);
        clip.right = Math.min(clip.right, pr.right);
        clip.bottom = Math.min(clip.bottom, pr.bottom);
      }
      node = node.parentElement;
    }
    const w = Math.max(0, clip.right - clip.left);
    const h = Math.max(0, clip.bottom - clip.top);
    if (w < 1 || h < 1) return null;
    return clip;
  }
  function biggestMedia(root) {
    let best = null, area = 0;
    for (const el of root.querySelectorAll('video, img')) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      const vr = clipToOverflow(el);
      if (!vr) continue;
      const va = (vr.right - vr.left) * (vr.bottom - vr.top);
      if (va > area) { area = va; best = vr; }
    }
    return best;
  }
  function visibleHeight(r) { return Math.min(r.bottom, innerHeight) - Math.max(r.top, 0); }
  function cardTarget() {
    let best = null, bestVis = 80;
    for (const art of document.querySelectorAll('article')) {
      if (art.querySelector('article')) continue;
      const r = biggestMedia(art);
      if (!r) continue;
      const vis = visibleHeight(r);
      if (vis < bestVis) continue;
      const url = postUrlFrom(art);
      if (!url) continue;
      best = { mode: 'card', url, rect: r }; bestVis = vis;
    }
    return best;
  }
  function reelsTarget() {
    if (!REELS_ROOT.test(location.pathname)) return null;
    let best = null, bestVis = innerHeight * 0.5;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const vis = visibleHeight(r);
      if (vis < bestVis) continue;
      let node = v.parentElement, url = null;
      while (node && node !== document.body && !(url = postUrlFrom(node))) node = node.parentElement;
      if (url) { best = { mode: 'card', url, rect: r }; bestVis = vis; }
    }
    return best;
  }

  // ---------- UI ----------
  function build() {
    host = document.createElement('ud-instagram-download');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        .wrap{position:relative;width:${SIZE}px;height:${SIZE}px}
        button{all:unset;box-sizing:border-box;width:${SIZE}px;height:${SIZE}px;border-radius:50%;background:#c81e4b;color:#fff;
          display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4);
          transition:transform .12s,background .12s;touch-action:none}
        button:hover{transform:scale(1.08);background:#a8173e}
        button:focus-visible{outline:3px solid #fff;outline-offset:2px}
        button[data-state=busy]{background:#555;cursor:progress}
        button[data-state=done]{background:#1f8f4e}
        button[data-state=error]{background:#b4233e}
        button[data-drag=true]{cursor:grabbing;transform:scale(1.08)}
        svg{width:22px;height:22px;pointer-events:none}
        .spin{animation:s 1s linear infinite;transform-origin:50% 50%}@keyframes s{to{transform:rotate(360deg)}}
        .bubble{position:absolute;right:${SIZE + 8}px;top:50%;transform:translateY(-50%);max-width:240px;padding:6px 10px;border-radius:8px;
          background:rgba(20,20,20,.92);color:#fff;font:12px/1.35 Arial,sans-serif;white-space:normal;word-break:break-word;pointer-events:none;display:none}
        .bubble.show{display:block}
        .bubble[data-kind=error]{background:#b4233e}
      </style>
      <div class="wrap">
        <button type="button" part="btn" aria-label="Descarregar do Instagram" title="Descarregar (arrasta para mover)" data-state="idle"></button>
        <div class="bubble" role="status" aria-live="polite"></div>
      </div>`;
    button = shadow.querySelector('button');
    bubble = shadow.querySelector('.bubble');
    setIcon('idle');
    button.addEventListener('click', onClick);
    button.addEventListener('pointerdown', onPointerDown);
    button.addEventListener('pointermove', onPointerMove);
    button.addEventListener('pointerup', onPointerUp);
    document.documentElement.append(host);
  }
  function setIcon(state) {
    const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10M7 10l5 5 5-5M5 20h14"/></svg>';
    const spin = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';
    const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    const warn = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v9M12 19h.01"/></svg>';
    button.innerHTML = state === 'busy' ? spin : state === 'done' ? check : state === 'error' ? warn : arrow;
  }
  function setState(state, text) {
    button.dataset.state = state;
    setIcon(state);
    bubble.textContent = text || '';
    bubble.dataset.kind = state === 'error' ? 'error' : 'info';
    bubble.classList.toggle('show', !!text);
    window.clearTimeout(doneTimer);
    if (state === 'done' || state === 'error') {
      doneTimer = window.setTimeout(() => { if (!busy) setState('idle', ''); }, state === 'done' ? 5000 : 9000);
    }
  }

  // ---------- position ----------
  function place(left, top) {
    const css = `all:initial;position:fixed;z-index:2147483647;display:block;left:${Math.round(left)}px;top:${Math.round(top)}px;`;
    if (css !== lastStyle) { host.style.cssText = css; lastStyle = css; }
  }
  function clamp(v, min, max) { return Math.min(Math.max(v, min), Math.max(min, max)); }
  function position() {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    if (current.mode === 'card') {
      place(clamp(current.rect.right - SIZE - MARGIN, MARGIN, vw - SIZE - MARGIN), clamp(Math.max(current.rect.top, 0) + MARGIN, MARGIN, vh - SIZE - MARGIN));
    } else {
      place(clamp(vw - SIZE - pos.right, MARGIN, vw - SIZE - MARGIN), clamp(vh - SIZE - pos.bottom, MARGIN, vh - SIZE - MARGIN));
    }
  }

  function update() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    const next = pageTarget() || cardTarget() || reelsTarget();
    if (!next) { current = null; if (lastStyle !== 'hidden') { host.style.cssText = 'all:initial;display:none;'; lastStyle = 'hidden'; } return; }
    if (!current || current.url !== next.url) { if (!busy) setState('idle', ''); }
    current = next;
    position();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); }
  function scheduleSoft() { if (!softTimer) softTimer = window.setTimeout(() => { softTimer = 0; schedule(); }, 150); }

  // ---------- drag (page mode) ----------
  function onPointerDown(e) {
    if (!current || current.mode !== 'page') return;
    drag = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false };
    button.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; button.dataset.drag = 'true';
    pos = { right: Math.max(MARGIN, drag.right - dx), bottom: Math.max(MARGIN, drag.bottom - dy) };
    position();
  }
  function onPointerUp() {
    if (!drag) return;
    if (drag.moved) {
      suppressClick = true; window.setTimeout(() => { suppressClick = false; }, 0);
      try { chrome.storage.local.set({ udPos: pos }); } catch { /* extension reloaded */ }
    }
    delete button.dataset.drag; drag = null;
  }

  // ---------- download ----------
  async function onClick() {
    if (suppressClick || busy || !current) return;
    busy = true; requestId = `ig-${Date.now()}`;
    setState('busy', 'A ligar...');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ud-job', endpoint: '/api/insta-download', payload: { url: current.url }, requestId });
      if (!res?.ok) throw new Error(res?.error || 'Não foi possível iniciar o download.');
      busy = false; setState('done', res.filename);
    } catch (err) {
      busy = false;
      const msg = String((err && err.message) || 'O download falhou.');
      setState('error', /context invalidated|Receiving end/i.test(msg) ? 'Extensão atualizada: recarrega esta página (F5).' : msg);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'ud-status' || msg.requestId !== requestId || !busy || !button) return;
    bubble.textContent = msg.message || ''; bubble.classList.toggle('show', !!msg.message);
  });

  // ---------- boot ----------
  try { chrome.storage.local.get('udPos').then((r) => { if (r?.udPos) { pos = r.udPos; schedule(); } }).catch(() => {}); } catch { /* ignore */ }
  new MutationObserver((muts) => {
    if (host && muts.every((m) => host === m.target || host.contains(m.target))) return;
    scheduleSoft();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('popstate', scheduleSoft);
  schedule();
})();
