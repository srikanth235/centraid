import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

await Promise.all(
  ['artifacts/test-results', 'artifacts/e2e', 'artifacts/perf', 'artifacts/scale'].map(
    (directory) => mkdir(directory, { recursive: true }),
  ),
);

const laneIndex = process.argv.indexOf('--lane');
const lane = laneIndex === -1 ? undefined : process.argv[laneIndex + 1];
if (lane) {
  const markerPath = path.resolve('artifacts/test-results/lane-starts.json');
  let markers = {};
  try {
    markers = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    markers = {};
  }
  markers[lane] = new Date().toISOString();
  await writeFile(markerPath, `${JSON.stringify(markers, null, 2)}\n`, 'utf8');
}
