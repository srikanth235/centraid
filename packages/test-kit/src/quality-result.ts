import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface QualityMeasurement {
  name: string;
  value: number;
  unit: string;
  budget?: number;
}

export interface QualityResult {
  lane: 'perf' | 'scale';
  owner: string;
  name: string;
  status: 'passed' | 'failed';
  measurements: QualityMeasurement[];
}

/** Emit one stable, report-consumable result while retaining a short local trend. */
export async function recordQualityResult(result: QualityResult): Promise<void> {
  const directory = path.resolve('artifacts', result.lane);
  const slug = result.owner.replaceAll(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const file = path.join(directory, `${slug}.json`);
  await mkdir(directory, { recursive: true });
  let previous: { history?: Array<{ at: string; value: number }> } | undefined;
  try {
    previous = JSON.parse(await readFile(file, 'utf8')) as typeof previous;
  } catch {
    previous = undefined;
  }
  const value = result.measurements[0]?.value ?? 0;
  const history = [...(previous?.history ?? []), { at: new Date().toISOString(), value }].slice(
    -30,
  );
  await writeFile(file, `${JSON.stringify({ ...result, history }, null, 2)}\n`, 'utf8');
}
