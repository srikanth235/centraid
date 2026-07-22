import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dir, '..');
const repo = path.resolve(root, '../..');
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await Bun.build({
  entrypoints: ['worker.ts', 'content.ts', 'popup.ts', 'pair.ts'].map((name) =>
    path.join(root, 'src', name),
  ),
  outdir: out,
  target: 'browser',
  format: 'esm',
  minify: false,
  sourcemap: 'external',
  naming: '[dir]/[name].[ext]',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const file of ['popup.html', 'popup.css', 'pair.html']) {
  await cp(path.join(root, 'static', file), path.join(out, file));
}
await cp(
  path.join(repo, 'apps/web/src/generated/centraid_web_iroh_bg.wasm'),
  path.join(out, 'centraid_web_iroh_bg.wasm'),
);

const iconSource = path.join(repo, 'apps/web/public/icon-192.png');
for (const size of [16, 32, 48, 128]) {
  await sharp(iconSource)
    .resize(size, size)
    .png()
    .toFile(path.join(out, `icon-${size}.png`));
}

for (const browser of ['chrome', 'firefox']) {
  const target = browser === 'chrome' ? out : path.join(out, 'firefox');
  if (browser === 'firefox') {
    await mkdir(target, { recursive: true });
    for (const entry of [
      'worker.js',
      'content.js',
      'popup.js',
      'pair.js',
      'popup.html',
      'popup.css',
      'pair.html',
      'centraid_web_iroh_bg.wasm',
      'icon-16.png',
      'icon-32.png',
      'icon-48.png',
      'icon-128.png',
    ]) {
      await cp(path.join(out, entry), path.join(target, entry));
    }
  }
  const manifest = await readFile(path.join(root, 'static', `manifest.${browser}.json`), 'utf8');
  await writeFile(path.join(target, 'manifest.json'), manifest);
}
