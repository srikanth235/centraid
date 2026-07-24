import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Always resolve to the monorepo root so lanes run from apps/* still write
// evidence where the report generator and upload-artifact steps look
// (repo-root `artifacts/`). Relative cwd paths previously landed under
// apps/desktop/artifacts and apps/web/artifacts, so the e2e upload of
// `path: artifacts/` found nothing (#535 F2).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

await Promise.all(
  ['artifacts/test-results', 'artifacts/e2e', 'artifacts/perf', 'artifacts/scale'].map(
    (directory) => mkdir(path.join(root, directory), { recursive: true }),
  ),
);

const laneIndex = process.argv.indexOf('--lane');
const lane = laneIndex === -1 ? undefined : process.argv[laneIndex + 1];
if (lane) {
  // Per-lane marker files so merge-multiple downloads never last-write-win
  // collide on a shared lane-starts.json across nightly evidence artifacts.
  const safe = String(lane).replace(/[^A-Za-z0-9._-]/g, '_');
  const markerPath = path.join(root, 'artifacts/test-results', `lane-starts-${safe}.json`);
  const markers = { [lane]: new Date().toISOString() };
  await writeFile(markerPath, `${JSON.stringify(markers, null, 2)}\n`, 'utf8');
}
