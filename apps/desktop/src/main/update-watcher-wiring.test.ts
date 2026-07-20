import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * I4 — the live update path must call admitUpdate (pure rollout), not only
 * define the pure core. This structural test fails if wiring is removed.
 */
describe('update-watcher rollout wiring (I4)', () => {
  it('gates announces through admitUpdate and has a packaged checker', () => {
    const src = readFileSync(path.join(here, 'update-watcher.ts'), 'utf8');
    expect(src).toContain("from './update-rollout.js'");
    expect(src).toContain('admitUpdate');
    expect(src).toContain('export async function announceUpdateIfAdmitted');
    expect(src).toContain('startPackagedUpdateChecker');
    expect(src).toContain('autoInstallOnAppQuit = false');
    // Dev mtime path still exists but must announce via admit gate.
    expect(src).toContain('announceUpdateIfAdmitted({ version, releasedAtMs })');
  });
});
