'use strict';
// node register.js            -> install (native host + autostart at login)
// node register.js --uninstall
// UD_DRY_RUN=1 prints registry commands instead of running them.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.universaldownloader.launcher';
const DIR = __dirname;
const SERVER_DIR = path.resolve(DIR, '..');
const EXT_ID = fs.readFileSync(path.join(DIR, 'ext-id.txt'), 'utf8').trim();
const DRY = !!process.env.UD_DRY_RUN;
const OUT = process.env.UD_OUT_DIR || DIR;
const KEYS = [
  `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
];
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'UniversalDownloader';

function reg(args) {
  if (DRY) return console.log('reg ' + args.join(' '));
  try { execFileSync('reg', args, { stdio: 'pipe' }); } catch (e) { if (!args.includes('delete')) throw e; }
}

if (process.argv.includes('--uninstall')) {
  for (const k of KEYS) reg(['delete', k, '/f']);
  reg(['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
  console.log('Desinstalado. A extensão em brave://extensions pode ser removida à mão.');
  process.exit(0);
}

const bat = path.join(OUT, 'ud-launcher.bat');
const manifestPath = path.join(OUT, `${HOST_NAME}.json`);
const vbs = path.join(OUT, 'start-server-hidden.vbs');
fs.writeFileSync(bat, `@echo off\r\n"${process.execPath}" "${path.join(DIR, 'ud-launcher.js')}"\r\n`);
fs.writeFileSync(manifestPath, JSON.stringify({
  name: HOST_NAME, description: 'Universal Downloader launcher', path: bat, type: 'stdio',
  allowed_origins: [`chrome-extension://${EXT_ID}/`]
}, null, 2));
fs.writeFileSync(vbs, [
  'Set sh = CreateObject("WScript.Shell")',
  `sh.CurrentDirectory = "${SERVER_DIR}"`,
  `sh.Run """${process.execPath}"" ""${path.join(SERVER_DIR, 'server.js')}""", 0, False`
].join('\r\n') + '\r\n');

for (const k of KEYS) reg(['add', k, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', `wscript.exe //B "${vbs}"`, '/f']);
console.log('Instalado.');
console.log(`  ID da extensão: ${EXT_ID}`);
console.log('  Servidor arranca no login e, se faltar, a extensão arranca-o.');
