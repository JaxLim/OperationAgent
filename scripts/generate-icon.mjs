// Generates build/icon.ico (16–256 px PNG frames) for the Windows app and installer.
// Pure Node: the brand mark from the Workbench design, rasterized with simple anti-aliasing.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out;
}
// Signed distance to a rounded rectangle centred at (cx, cy).
function roundedBox(x, y, cx, cy, half, radius) {
  const qx = Math.abs(x - cx) - (half - radius), qy = Math.abs(y - cy) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1)); const s = size / 256;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const outer = Math.min(1, Math.max(0, 0.5 - roundedBox(px, py, size / 2, size / 2, 118 * s, 54 * s)));
      const inner = Math.min(1, Math.max(0, 0.5 - roundedBox(px, py, size / 2, size / 2, 46 * s, 16 * s)));
      const t = (px + py) / (2 * size); // diagonal gradient: accent blue → violet
      let r = 58 + (110 - 58) * t, g = 85 + (82 - 85) * t, b = 217 + (224 - 217) * t;
      r += (251 - r) * inner; g += (250 - g) * inner; b += (248 - b) * inner;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = Math.round(r); raw[offset + 1] = Math.round(g); raw[offset + 2] = Math.round(b); raw[offset + 3] = Math.round(255 * outer);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 24, 32, 48, 64, 128, 256]; const images = sizes.map(png);
const directory = Buffer.alloc(6 + 16 * sizes.length); directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16; directory[entry] = size === 256 ? 0 : size; directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8); directory.writeUInt32LE(offset, entry + 12); offset += images[index].length;
});
const root = resolve(import.meta.dirname, '..');
writeFileSync(resolve(root, 'build/icon.ico'), Buffer.concat([directory, ...images]));
writeFileSync(resolve(root, 'build/icon.png'), images.at(-1));
console.log(JSON.stringify({ check: 'APP_ICON', sizes }));
