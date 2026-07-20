import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICE_WORKER_VERSION } from './sw-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SERVICE_WORKER_VERSION (K8 single source)', () => {
  it('is the only hand-authored version token; public/sw.js mirrors it', () => {
    expect(SERVICE_WORKER_VERSION).toMatch(/^v\d+$/);
    const sw = readFileSync(path.join(root, 'public/sw.js'), 'utf8');
    const m = sw.match(/const VERSION = ['"]([^'"]+)['"]/);
    expect(m?.[1]).toBe(SERVICE_WORKER_VERSION);
    // Stamp script is what keeps them in lockstep on build.
    const stamp = readFileSync(path.join(root, 'scripts/stamp-sw-version.mjs'), 'utf8');
    expect(stamp).toContain('sw-version.ts');
    expect(stamp).toContain('public/sw.js');
  });
});
