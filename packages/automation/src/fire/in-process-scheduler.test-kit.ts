import type { Manifest } from '../manifest/manifest.js';
import type { Row } from '../scaffold/app.js';

const manifest = (enabled: boolean): Manifest => ({
  name: 'x',
  version: '0.1.0',
  enabled,
  prompt: 'do it',
  triggers: [],
  requires: {},
  history: { keep: 'all' },
  generated: { by: 'test', at: '2026-01-01T00:00:00.000Z' },
});

export function row(ref: string, enabled: boolean, exprs: readonly string[]): Row {
  const [ownerApp, id] = ref.split('/') as [string, string];
  return {
    id,
    dir: `/tmp/${id}`,
    name: id,
    ownerApp,
    ref,
    enabled,
    triggers: exprs.map((expr) => ({ kind: 'cron', expr })),
    manifest: manifest(enabled),
  };
}

export const at = (hour: number, minute: number): Date => new Date(2026, 0, 1, hour, minute, 0, 0);

export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export { manifest };
