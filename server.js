'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { writeZip } = require('./zip');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.UD_HOST || '127.0.0.1'; // never 0.0.0.0
const ROOT_DIR = __dirname;
const STORAGE_TMP = path.join(ROOT_DIR, 'storage', 'tmp');
const TOOLS_DIR = process.env.UD_TOOLS_DIR || path.join(ROOT_DIR, 'tools');
const YT_DLP_BIN = process.env.UD_YT_DLP || path.join(TOOLS_DIR, 'yt-dlp.exe');
const GALLERY_DL_BIN = process.env.UD_GALLERY_DL || path.join(TOOLS_DIR, 'gallery-dl.exe');
const EXT_ID = (() => { try { return fs.readFileSync(path.join(ROOT_DIR, 'launcher', 'ext-id.txt'), 'utf8').trim(); } catch { return ''; } })();
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  ...(process.env.UD_EXT_ORIGINS ? process.env.UD_EXT_ORIGINS.split(',') : EXT_ID ? [`chrome-extension://${EXT_ID}`] : [])
]);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const HEARTBEAT_MS = Number(process.env.UD_HEARTBEAT_MS) || 10000;
const STALE_MS = 60 * 60 * 1000;

fs.mkdirSync(STORAGE_TMP, { recursive: true });
sweepStale();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.webm': 'video/webm'
};

function sweepStale() {
  try {
    for (const d of fs.readdirSync(STORAGE_TMP)) {
      const p = path.join(STORAGE_TMP, d);
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}
function json(res, code, body) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function removeTaskDirectory(taskDir) {
  try {
    if (taskDir && path.resolve(taskDir).startsWith(STORAGE_TMP + path.sep)) fs.rmSync(taskDir, { recursive: true, force: true });
  } catch (e) { console.error('Error removing task dir:', e.message); }
}
function newTask() {
  const taskId = crypto.randomBytes(16).toString('hex');
  const taskDir = path.join(STORAGE_TMP, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  return { taskId, taskDir };
}
// Cookies live on disk only while the child process runs.
function writeCookies(cookiesText, taskDir) {
  if (typeof cookiesText !== 'string' || !cookiesText.trim()) return null;
  const p = path.join(taskDir, 'cookies.txt');
  fs.writeFileSync(p, cookiesText.trim(), { encoding: 'utf8', mode: 0o600 });
  return p;
}
function dropCookies(taskDir) { try { fs.rmSync(path.join(taskDir, 'cookies.txt'), { force: true }); } catch { /* ignore */ } }


// yt-dlp needs a JS runtime for YouTube. A long-running node.exe keeps the PATH it started with,
// so a freshly installed deno is invisible to it: locate deno explicitly.
function jsRuntimeArgs() {
  const cands = [process.env.UD_DENO,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'deno.exe'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.deno', 'bin', 'deno.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'deno', 'deno.exe')].filter(Boolean);
  const found = cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  return found ? ['--js-runtimes', `deno:${found}`] : [];
}

function validateMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '[::1]' ||
      /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
  return u.href;
}

// Blocks cross-site requests (CSRF / DNS rebinding) against the local API.
function guard(req, res, pathname) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) { json(res, 403, { error: 'Host não permitido.' }); return false; }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) { json(res, 403, { error: 'Origem não permitida.' }); return false; }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'Content-Type deve ser application/json.' }); return false; }
  }
  return true;
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') { res.writeHead(403); return res.end(); } // no CORS preflight approvals, ever
  if (!guard(req, res, pathname)) return;

  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && (pathname === '/api/info' || pathname === '/api/info.php')) return handleApiInfo(req, res);
  if (req.method === 'POST' && (pathname === '/api/stream-download' || pathname === '/api/download.php')) return handleStreamDownload(req, res);
  if (req.method === 'POST' && (pathname === '/api/insta-download' || pathname === '/api/insta_download.php')) return handleInstaStreamDownload(req, res);
  if (req.method === 'GET' && pathname.startsWith('/api/file/')) return handleFileServe(req, res, pathname);
  if (req.method === 'GET') return serveStatic(res, pathname);
  json(res, 404, { error: 'Endpoint não encontrado.' });
});

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Pedido inválido.' }); }
  if (rel === '/') rel = '/index.html';
  const filePath = path.resolve(ROOT_DIR, '.' + rel);
  const allowed = filePath === path.join(ROOT_DIR, 'index.html') || filePath.startsWith(path.join(ROOT_DIR, 'assets') + path.sep);
  if (allowed && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(filePath).pipe(res);
  }
  json(res, 404, { error: 'Endpoint não encontrado.' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > 3 * 1024 * 1024) { tooBig = true; reject(new Error('Payload muito grande')); }
    });
    req.on('end', () => { if (tooBig) return; try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

async function handleApiInfo(req, res) {
  let payload;
  try { payload = await readJsonBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
  const url = validateMediaUrl(payload.url);
  if (!url) return json(res, 400, { error: 'Envie uma URL válida.' });

  const { taskDir } = newTask();
  const cookieFile = writeCookies(payload.cookies_text, taskDir);
  const args = ['--dump-single-json', '--skip-download', '--no-warnings', '--ignore-no-formats-error', '--playlist-end', '1', ...jsRuntimeArgs()];
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', url);

  const child = spawn(YT_DLP_BIN, args, { cwd: taskDir, windowsHide: true });
  let stdout = '', stderr = '', done = false;
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const finish = (code, body) => { if (done) return; done = true; removeTaskDirectory(taskDir); json(res, code, body); };
  child.on('error', (e) => finish(500, { error: `Não consegui executar o yt-dlp: ${e.code || e.message}` }));
  child.on('close', (code) => {
    if (code !== 0) return finish(422, { error: `Falha ao obter metadados: ${stderr.slice(0, 300)}` });
    try {
      const info = JSON.parse(stdout.trim());
      const isPlaylist = Boolean(info.entries || info._type === 'playlist');
      const preview = isPlaylist && Array.isArray(info.entries) && info.entries[0] ? info.entries[0] : info;
      const formats = [], seen = new Set();
      for (const fmt of preview.formats || info.formats || []) {
        const h = fmt.height;
        if (h > 0 && !seen.has(h) && [144, 240, 360, 480, 720, 1080, 1440, 2160].includes(h)) {
          seen.add(h);
          formats.push({ height: h, ext: (fmt.ext || 'mp4').toLowerCase(), note: fmt.format_note || `${h}p` });
        }
      }
      formats.sort((a, b) => b.height - a.height);
      const sec = parseInt(preview.duration || info.duration || 0, 10) || 0;
      finish(200, {
        title: info.title || preview.title || 'Vídeo sem título',
        uploader: preview.uploader || info.uploader || 'Canal desconhecido',
        thumbnail: preview.thumbnail || info.thumbnail || '',
        duration: `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`,
        formats, original_url: url, is_playlist: isPlaylist
      });
    } catch { finish(500, { error: 'Erro ao interpretar resposta do yt-dlp.' }); }
  });
}

// Shared SSE plumbing: heartbeat, abort handling, single-finish guarantee.
function openSse(req, res, taskDir, getChild) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let finished = false;
  const beat = setInterval(() => { if (!finished) res.write(': ping\n\n'); }, HEARTBEAT_MS);
  const ctl = {
    send(event, data) { if (!finished) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (finished) return; finished = true; clearInterval(beat); res.end(); },
    get finished() { return finished; }
  };
  res.on('close', () => {
    if (finished) return;
    finished = true; clearInterval(beat);
    const child = getChild();
    if (child && child.exitCode === null) child.kill();
    removeTaskDirectory(taskDir);
  });
  return ctl;
}

async function handleStreamDownload(req, res) {
  let payload;
  try { payload = await readJsonBody(req); } catch { return json(res, 400, { error: 'JSON inválido' }); }
  const url = validateMediaUrl(payload.url);
  if (!url) return json(res, 400, { error: 'URL necessária.' });

  const { taskId, taskDir } = newTask();
  let child = null;
  const sse = openSse(req, res, taskDir, () => child);
  const cookieFile = writeCookies(payload.cookies_text, taskDir);

  const type = payload.type === 'audio' ? 'audio' : 'video';
  const quality = /^\d{3,4}$/.test(String(payload.quality)) ? String(payload.quality) : 'best';
  const playlistStart = Math.max(1, parseInt(payload.playlist_start || 1, 10) || 1);
  const playlistLimit = payload.playlist_limit ? Math.max(1, parseInt(payload.playlist_limit, 10) || 0) : null;
  const isPlaylist = payload.is_playlist === true || (playlistLimit !== null && playlistLimit > 1) || playlistStart > 1;

  const args = [
    '--output', path.join(taskDir, '%(title).160B.%(ext)s'), '--no-part', '--no-warnings',
    '--ffmpeg-location', TOOLS_DIR, '--print', 'after_move:filepath', '--playlist-start', String(playlistStart),
    '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg', '--newline', ...jsRuntimeArgs()
  ];
  if (isPlaylist) args.push('--min-sleep-interval', '3', '--max-sleep-interval', '12', '--sleep-requests', '1'); // anti-ban only for playlists
  if (playlistLimit) args.push('--playlist-end', String(playlistStart + playlistLimit - 1));
  if (payload.playlist_reverse) args.push('--playlist-reverse');
  if (type === 'audio') {
    args.push('--format', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '320K');
  } else {
    const qf = quality === 'best' ? '' : `[height<=${quality}]`;
    args.push('--format', `bv*[ext=mp4][vcodec^=avc]${qf}+ba[ext=m4a][acodec^=mp4a]/b[ext=mp4][vcodec^=avc][acodec^=mp4a]${qf}/b[ext=mp4]${qf}`,
      '--merge-output-format', 'mp4', '--postprocessor-args', 'ffmpeg:-movflags +faststart');
  }
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', url);

  sse.send('status', { message: 'A iniciar download...' });
  child = spawn(YT_DLP_BIN, args, { cwd: taskDir, windowsHide: true });
  child.on('error', (e) => { sse.send('error', { error: `Não consegui executar o yt-dlp: ${e.code || e.message}` }); removeTaskDirectory(taskDir); sse.end(); });
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) sse.send('progress', { percent: parseFloat(m[1]), text: line.trim() });
      else if (line.includes('[download]') || line.includes('[ExtractAudio]') || line.includes('[Merger]')) sse.send('status', { message: line.trim() });
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text && !text.includes('Deprecated Feature') && !text.includes('WARNING:')) sse.send('status', { message: text });
  });
  child.on('close', async () => {
    dropCookies(taskDir);
    if (sse.finished) return;
    const exts = type === 'audio' ? ['.mp3'] : ['.mp4', '.webm', '.mkv', '.mov', '.m4v'];
    await deliver(sse, taskId, taskDir, exts, 'playlist_downloads.zip', 'O yt-dlp não conseguiu descarregar nenhum ficheiro válido.');
  });
}

async function handleInstaStreamDownload(req, res) {
  let payload;
  try { payload = await readJsonBody(req); } catch { return json(res, 400, { error: 'JSON inválido' }); }
  const url = validateMediaUrl(payload.url);
  if (!url) return json(res, 400, { error: 'URL necessária.' });

  const { taskId, taskDir } = newTask();
  let child = null;
  const sse = openSse(req, res, taskDir, () => child);
  const cookieFile = writeCookies(payload.cookies_text, taskDir);
  // Anti-ban delays: the Instagram private API throttles (429/500) fast, uninterrupted requests.
  const args = ['--directory', taskDir, '--sleep', '2', '--sleep-request', '1', '--sleep-429', '10'];
  if (new URL(url).hostname.toLowerCase().endsWith('instagram.com')) args.push('-o', 'extractor.instagram.static-videos=false');
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', url);

  sse.send('status', { message: 'A extrair do Instagram...' });
  child = spawn(GALLERY_DL_BIN, args, { cwd: taskDir, windowsHide: true });
  child.on('error', (e) => { sse.send('error', { error: `Não consegui executar o gallery-dl: ${e.code || e.message}` }); removeTaskDirectory(taskDir); sse.end(); });
  child.stdout.on('data', (c) => sse.send('status', { message: c.toString().trim().slice(-200) }));
  let lastErr = '';
  child.stderr.on('data', (c) => { const m = c.toString().match(/\[[^\]]+\]\[(?:error|warning)\][^\r\n]*/g); if (m) lastErr = m[m.length - 1]; });
  child.on('close', async () => {
    dropCookies(taskDir);
    if (sse.finished) return;
    let hint = '';
    if (/login|401|403|redirect/i.test(lastErr)) hint = ' Sessão do Instagram inválida: abre instagram.com no Brave, inicia sessão e tenta de novo.';
    else if (/429|rate/i.test(lastErr)) hint = ' O Instagram limitou os pedidos: espera uns minutos.';
    else if (/not.?found|404|unavailable|expired/i.test(lastErr)) hint = ' O conteúdo já não existe ou expirou.';
    await deliver(sse, taskId, taskDir, ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm', '.mkv', '.mov'], 'galeria_downloads.zip',
      `Não foi possível encontrar mídias visuais no link informado.${hint}${lastErr ? ` (${lastErr.slice(0, 160)})` : ''}`);
  });
}

function listFiles(dir, exts, base = dir, out = []) {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) listFiles(full, exts, base, out);
    else if (exts.includes(path.extname(full).toLowerCase())) out.push({ path: full, name: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}
const fileUrl = (taskId, rel) => `/api/file/${taskId}/${rel.split('/').map(encodeURIComponent).join('/')}`;

async function deliver(sse, taskId, taskDir, exts, zipName, emptyMsg) {
  const files = listFiles(taskDir, exts);
  if (files.length === 0) { sse.send('error', { error: emptyMsg }); removeTaskDirectory(taskDir); return sse.end(); }
  if (files.length === 1) {
    sse.send('complete', { downloadUrl: fileUrl(taskId, files[0].name), filename: path.basename(files[0].name) });
    return sse.end();
  }
  sse.send('status', { message: 'A compactar em ZIP...' });
  try {
    const zipPath = path.join(taskDir, zipName);
    await writeZip(zipPath, files); // only media files: cookies.txt can never end up in here
    sse.send('complete', { downloadUrl: fileUrl(taskId, zipName), filename: zipName });
  } catch (err) {
    sse.send('error', { error: `Erro ao compactar ZIP: ${err.message}` });
    removeTaskDirectory(taskDir);
  }
  sse.end();
}

function handleFileServe(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // api, file, taskId, ...name
  if (parts.length < 4 || !/^[a-f0-9]{32}$/.test(parts[2])) return json(res, 400, { error: 'Caminho de ficheiro inválido.' });
  const taskDir = path.join(STORAGE_TMP, parts[2]);
  let rel;
  try { rel = parts.slice(3).map(decodeURIComponent).join('/'); } catch { return json(res, 400, { error: 'Caminho de ficheiro inválido.' }); }
  const filePath = path.resolve(taskDir, rel);
  if (!filePath.startsWith(taskDir + path.sep) || path.basename(filePath) === 'cookies.txt' ||
      !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return json(res, 404, { error: 'Ficheiro não encontrado ou expirado.' });
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => setTimeout(() => removeTaskDirectory(taskDir), 10000).unref());
}

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log(`[+] Universal Downloader (Node.js Engine) rodando!`);
  console.log(`[+] http://localhost:${PORT}  (só acessível neste PC)`);
  console.log('==================================================');
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `[!] Porta ${PORT} já em uso (servidor provavelmente já está a correr).` : e); process.exit(1); });
module.exports = server;
