'use strict';
// Native Messaging host: browser -> this -> starts server.js if port is closed.
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const SERVER = process.env.UD_SERVER_JS || path.join(__dirname, '..', 'server.js');

function send(obj, cb) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]), cb);
}
function isUp() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
async function ensureServer() {
  if (await isUp()) return { ok: true, started: false };
  const child = spawn(process.execPath, [SERVER], { cwd: path.dirname(SERVER), detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isUp()) return { ok: true, started: true };
  }
  return { ok: false, error: 'O servidor não arrancou em 10s.' };
}

let buf = Buffer.alloc(0);
let handled = false;
process.stdin.on('data', async (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (handled || buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  handled = true;
  let result;
  try {
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    result = msg && msg.type === 'start' ? await ensureServer() : { ok: false, error: 'Mensagem desconhecida.' };
  } catch (e) { result = { ok: false, error: e.message }; }
  send(result, () => process.exit(0));
});
process.stdin.on('end', () => { if (!handled) process.exit(0); });
