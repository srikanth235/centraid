import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const artifacts = path.join(root, 'artifacts');
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

async function zip(name, cwd, entries) {
  const output = path.join(artifacts, name);
  const process = Bun.spawn(['zip', '-q', '-r', output, ...entries], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await process.exited) !== 0) throw new Error(`Could not create ${name}`);
}

await zip('centraid-companion-chrome.zip', path.join(root, 'dist'), [
  'manifest.json',
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
]);
await zip('centraid-companion-firefox.zip', path.join(root, 'dist/firefox'), ['.']);
