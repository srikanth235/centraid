/**
 * Merge a generated test-health report into a Pages site tree.
 *
 * Usage:
 *   node scripts/test-report/prepare-pages-site.mjs \
 *     --report dist/test-report \
 *     --site site \
 *     --slot pr/465
 *
 * Copies report files to site/test-report/<slot>/ and writes a small landing
 * page at site/index.html that links known slots (for one-hop browsing).
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flags = parseFlags(process.argv.slice(2));
const reportDir = path.resolve(flags.report ?? path.join(root, 'dist/test-report'));
const siteDir = path.resolve(flags.site ?? path.join(root, 'site'));
const slot = String(flags.slot ?? 'latest').replace(/^\/+|\/+$/g, '');

if (!slot || slot.includes('..')) {
  console.error(`invalid --slot: ${flags.slot}`);
  process.exit(1);
}

const dest = path.join(siteDir, 'test-report', slot);
await mkdir(dest, { recursive: true });
await cp(reportDir, dest, { recursive: true });

// Pages must not run Jekyll (underscored dirs / raw HTML).
await writeFile(path.join(siteDir, '.nojekyll'), '', 'utf8');

const slots = await listSlots(path.join(siteDir, 'test-report'));
const landing = renderLanding(slots, {
  repo: process.env.GITHUB_REPOSITORY ?? 'centraid',
  generatedAt: new Date().toISOString(),
  highlight: slot,
});
await writeFile(path.join(siteDir, 'index.html'), landing, 'utf8');

console.log(`pages site: slot=test-report/${slot} → ${path.relative(root, dest)}`);
console.log(`pages site: landing lists ${slots.length} slot(s)`);

async function listSlots(base) {
  const found = [];
  async function walk(dir, prefix) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const indexPath = path.join(dir, entry.name, 'index.html');
      try {
        await stat(indexPath);
        found.push(rel);
      } catch {
        await walk(path.join(dir, entry.name), rel);
      }
    }
  }
  await walk(base, '');
  return found.sort();
}

function renderLanding(slots, { repo, generatedAt, highlight }) {
  const items = slots
    .map((s) => {
      const href = `test-report/${s}/`;
      const label = s === highlight ? `${s} (this deploy)` : s;
      return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Centraid test health reports</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.35rem; }
    a { color: #0b57d0; }
    .meta { color: #555; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Centraid test health reports</h1>
  <p class="meta">${escapeHtml(repo)} · updated ${escapeHtml(generatedAt)}</p>
  <p>Open a report below, or use the sticky link on the pull request.</p>
  <ul>
${items || '    <li><em>No reports published yet.</em></li>'}
  </ul>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    result[current.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

