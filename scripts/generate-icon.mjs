// Converts the supplied OA artwork into Windows icon frames using Electron's image resampler.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (!process.versions.electron) {
  const require = createRequire(import.meta.url);
  const electron = require(resolve(root, 'apps/desktop/node_modules/electron'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [import.meta.filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  const { app, nativeImage } = await import('electron');
  app.disableHardwareAcceleration();
  void app.whenReady().then(() => {
    try {
      let source = nativeImage.createFromPath(resolve(root, 'build/icon-source.png'));
      if (source.isEmpty()) throw new Error('ICON_SOURCE_INVALID');
      const { width, height } = source.getSize();
      const bitmap = source.toBitmap();
      const corners = [0, width - 1, width * (height - 1), width * height - 1];
      if (corners.some(pixel => bitmap[pixel * 4 + 3] !== 0)) {
        // Clip the original opaque artwork inside its cream tile, with one-pixel antialiasing.
        const inset = Math.ceil(Math.min(width, height) * 0.018);
        const radius = Math.min(width, height) * 0.2;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const dx = Math.abs(x + 0.5 - width / 2) - (width / 2 - inset - radius);
            const dy = Math.abs(y + 0.5 - height / 2) - (height / 2 - inset - radius);
            const distance = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
            const coverage = Math.max(0, Math.min(1, 0.5 - distance));
            const pixel = (y * width + x) * 4;
            for (let channel = 0; channel < 4; channel++) bitmap[pixel + channel] = Math.round(bitmap[pixel + channel] * coverage);
          }
        }
        source = nativeImage.createFromBitmap(bitmap, { width, height });
        writeFileSync(resolve(root, 'build/icon-source.png'), source.toPNG());
      }
      if (corners.some(pixel => source.toBitmap()[pixel * 4 + 3] !== 0)) throw new Error('ICON_CORNERS_MUST_BE_TRANSPARENT');
      const sizes = [16, 24, 32, 48, 64, 128, 256];
      const images = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
      const directory = Buffer.alloc(6 + 16 * sizes.length);
      directory.writeUInt16LE(1, 2);
      directory.writeUInt16LE(sizes.length, 4);
      let offset = directory.length;
      sizes.forEach((size, index) => {
        const entry = 6 + index * 16;
        directory[entry] = size === 256 ? 0 : size;
        directory[entry + 1] = size === 256 ? 0 : size;
        directory.writeUInt16LE(1, entry + 4);
        directory.writeUInt16LE(32, entry + 6);
        directory.writeUInt32LE(images[index].length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += images[index].length;
      });
      writeFileSync(resolve(root, 'build/icon.ico'), Buffer.concat([directory, ...images]));
      writeFileSync(resolve(root, 'build/icon.png'), images.at(-1));
      console.log(JSON.stringify({ check: 'APP_ICON', sizes }));
    } finally { app.quit(); }
  });
}
