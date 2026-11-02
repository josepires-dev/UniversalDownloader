// Minimal streaming ZIP writer (method 0 = store). No deps, no PowerShell.
const fs = require('fs');
const T = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }

function crcFile(p) {
  return new Promise((resolve, reject) => {
    let c = 0xFFFFFFFF, size = 0;
    fs.createReadStream(p)
      .on('data', (b) => { size += b.length; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); })
      .on('end', () => resolve({ crc: (c ^ 0xFFFFFFFF) >>> 0, size }))
      .on('error', reject);
  });
}
function dos(d) {
  const y = Math.max(d.getFullYear(), 1980);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function write(out, buf) {
  return new Promise((res, rej) => out.write(buf, (e) => (e ? rej(e) : res())));
}
function pipeFile(out, p) {
  return new Promise((res, rej) => {
    const rs = fs.createReadStream(p);
    rs.on('error', rej); rs.on('end', res);
    rs.pipe(out, { end: false });
  });
}

// entries: [{ name: 'dir/file.jpg', path: '/abs/file.jpg' }]
async function writeZip(zipPath, entries) {
  const out = fs.createWriteStream(zipPath);
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      const { crc, size } = await crcFile(e.path);
      if (size >= 0xFFFFFFFF) throw new Error('Ficheiro demasiado grande para ZIP.');
      const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
      const { time, date } = dos(fs.statSync(e.path).mtime);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
      await write(out, h); await write(out, name); await pipeFile(out, e.path);
      central.push({ name, crc, size, time, date, offset });
      offset += 30 + name.length + size;
    }
    let cdSize = 0;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
      h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24); h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.offset, 42);
      await write(out, h); await write(out, c.name); cdSize += 46 + c.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
    await write(out, end);
  } finally {
    await new Promise((r) => out.end(r));
  }
}
module.exports = { writeZip };
