// Copy the canonical kit (kit.js + kit.css) next to every template app's
// index.html, mirroring the wall.css "standalone copy per app" convention.
// Run after editing packages/blueprints/kit/*: node scripts/sync-kit.mjs
import { copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kitDir = path.join(root, 'kit');
const appsDir = path.join(root, 'apps');

const files = ['kit.js', 'kit.css'];
let copied = 0;
for (const entry of await readdir(appsDir)) {
  const appDir = path.join(appsDir, entry);
  if (!(await stat(appDir)).isDirectory()) continue;
  for (const file of files) {
    await copyFile(path.join(kitDir, file), path.join(appDir, file));
    copied += 1;
  }
  console.log(`synced kit → apps/${entry}`);
}
console.log(`${copied} files copied`);
