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
      const source = nativeImage.createFromPath(resolve(root, 'build/icon-source.png'));
      if (source.isEmpty()) throw new Error('ICON_SOURCE_INVALID');
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
