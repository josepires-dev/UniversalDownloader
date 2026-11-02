'use strict';
const $ = (id) => document.getElementById(id);
const el = {
  pageLabel: $('pageLabel'), unsupportedPanel: $('unsupportedPanel'), instagramPanel: $('instagramPanel'), youtubePanel: $('youtubePanel'),
  instagramDownload: $('instagramDownload'), analyzeVideo: $('analyzeVideo'), videoTitle: $('videoTitle'), youtubeOptions: $('youtubeOptions'),
  qualitySelect: $('qualitySelect'), playlistOptions: $('playlistOptions'), playlistStart: $('playlistStart'), playlistLimit: $('playlistLimit'),
  playlistReverse: $('playlistReverse'), downloadVideo: $('downloadVideo'), downloadAudio: $('downloadAudio'), status: $('status'),
  bar: $('bar'), server: $('server')
};
const JOB_KEY = 'job:popup';
let activeTabUrl = '';
let videoInfo = null;
let busy = false;

el.instagramDownload.addEventListener('click', () => startJob('/api/insta-download', { url: activeTabUrl }));
el.analyzeVideo.addEventListener('click', analyzeVideo);
el.downloadVideo.addEventListener('click', () => downloadYoutube('video'));
el.downloadAudio.addEventListener('click', () => downloadYoutube('audio'));
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes[JOB_KEY]) renderJob(changes[JOB_KEY].newValue); });
document.addEventListener('DOMContentLoaded', initialize);
if (document.readyState !== 'loading') initialize();

let started = false;
async function initialize() {
  if (started) return; started = true;
  warmServer();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabUrl = typeof tab?.url === 'string' ? tab.url : '';
    const url = new URL(activeTabUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      el.instagramPanel.classList.remove('hidden');
      el.pageLabel.textContent = describeInstagram(url);
      el.instagramDownload.classList.toggle('hidden', !/^\/(?:[^/]+\/)?(?:p|reels?|tv|stories)\//i.test(url.pathname));
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      el.youtubePanel.classList.remove('hidden');
      el.pageLabel.textContent = 'YouTube · separador atual';
    } else {
      el.unsupportedPanel.classList.remove('hidden');
      el.pageLabel.textContent = 'Página não suportada';
    }
  } catch {
    el.unsupportedPanel.classList.remove('hidden');
    el.pageLabel.textContent = 'Não foi possível ler o separador atual';
  }
  const saved = (await chrome.storage.session.get(JOB_KEY).catch(() => ({})))[JOB_KEY];
  if (saved && (saved.phase !== 'done' && saved.phase !== 'error' ? Date.now() - saved.at < 3600000 : Date.now() - saved.at < 60000)) renderJob(saved);
}

async function warmServer() {
  try { await UD.ensureServer(); el.server.dataset.on = 'true'; el.server.title = 'Servidor ligado'; }
  catch (e) { el.server.dataset.on = 'false'; el.server.title = e.message; setStatus(e.message, 'error'); }
}
function describeInstagram(url) {
  const p = url.pathname.toLowerCase();
  if (p.includes('/stories/')) return 'Instagram · Story ou Destaque';
  if (p.includes('/reel')) return 'Instagram · Reel';
  if (/\/(p|tv)\//.test(p)) return 'Instagram · publicação';
  return 'Instagram · página atual';
}

function setStatus(message, kind = 'info') { el.status.textContent = message; el.status.dataset.kind = kind; }
function setBusy(value) {
  busy = value;
  for (const b of [el.instagramDownload, el.analyzeVideo, el.downloadVideo, el.downloadAudio]) b.disabled = value;
  if (!value) el.bar.classList.add('hidden');
}
function renderJob(job) {
  if (!job) return;
  if (job.phase === 'done') { setBusy(false); setStatus(`Transferência iniciada: ${job.filename}`, 'success'); return; }
  if (job.phase === 'error') { setBusy(false); setStatus(job.message, 'error'); return; }
  setBusy(true);
  setStatus(job.message || 'A processar...', 'info');
  if (Number.isFinite(job.percent)) { el.bar.classList.remove('hidden'); el.bar.value = job.percent; } else el.bar.classList.add('hidden');
}

// Job runs in the background worker: closing the popup does NOT cancel it.
async function startJob(endpoint, payload) {
  if (busy) return;
  setBusy(true); setStatus('A ligar...', 'info');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ud-job', endpoint, payload });
    if (res && !res.ok) { setBusy(false); setStatus(res.error, 'error'); }
  } catch { /* popup closed or worker restarted: progress still arrives via storage */ }
}

async function analyzeVideo() {
  if (busy) return;
  setBusy(true); setStatus('A carregar informações...', 'info');
  try {
    const cookies_text = await UD.getCookiesText(['youtube.com']);
    videoInfo = await UD.postJson('/api/info', { url: activeTabUrl, cookies_text });
    el.videoTitle.textContent = videoInfo.is_playlist ? `Playlist: ${videoInfo.title || 'sem título'}` : `${videoInfo.title || 'Vídeo sem título'}${videoInfo.uploader ? ` · ${videoInfo.uploader}` : ''}`;
    populateQualities(videoInfo.formats);
    el.playlistOptions.classList.toggle('hidden', !videoInfo.is_playlist);
    el.youtubeOptions.classList.remove('hidden');
    el.analyzeVideo.textContent = 'Atualizar informações';
    setBusy(false); setStatus('Pronto. Escolhe MP4 ou MP3.', 'success');
  } catch (e) { setBusy(false); setStatus(e.message, 'error'); }
}
function populateQualities(formats) {
  el.qualitySelect.replaceChildren(new Option('Melhor qualidade', 'best'));
  const seen = new Set();
  for (const f of Array.isArray(formats) ? formats : []) {
    const h = Number(f?.height);
    if (!Number.isInteger(h) || h < 1 || seen.has(h)) continue;
    seen.add(h);
    el.qualitySelect.append(new Option(`${h}p (${String(f.ext || 'mp4').toUpperCase()})`, String(h)));
  }
}
function posInt(v, fallback) { const n = Number.parseInt(v, 10); return Number.isSafeInteger(n) && n > 0 ? n : fallback; }
function downloadYoutube(type) {
  if (!videoInfo) return setStatus('Carrega primeiro as informações do vídeo.', 'error');
  return startJob('/api/stream-download', {
    url: activeTabUrl, type, quality: el.qualitySelect.value, is_playlist: !!videoInfo.is_playlist,
    playlist_start: posInt(el.playlistStart.value, 1), playlist_limit: el.playlistLimit.value.trim() ? posInt(el.playlistLimit.value, null) : null,
    playlist_reverse: el.playlistReverse.checked
  });
}
