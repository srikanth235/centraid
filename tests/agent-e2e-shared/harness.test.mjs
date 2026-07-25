import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultRunId, writeFlowVerdict } from './harness.mjs';

const scratchDirs = [];

afterEach(async () => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRunDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'centraid-harness-'));
  scratchDirs.push(dir);
  return dir;
}

describe('defaultRunId', () => {
  test('returns an ISO-stamp plus hex suffix without colons/dots/Z', () => {
    const id = defaultRunId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{6}$/);
    expect(id).not.toContain(':');
    expect(id).not.toContain('.');
    expect(id.endsWith('Z')).toBe(false);
  });

  test('is unique across rapid calls', () => {
    const a = defaultRunId();
    const b = defaultRunId();
    expect(a).not.toBe(b);
  });
});

describe('writeFlowVerdict', () => {
  test('writes PASS verdict.md and optional evidence JSON', async () => {
    const runDir = await makeRunDir();
    const repoRoot = runDir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pass = await writeFlowVerdict({
        repoRoot,
        slug: 'pairing-smoke',
        runDir,
        elapsedMs: 42,
        error: null,
        notes: ['device paired'],
        result: { pass: true, notes: 'all green' },
        metadata: { platform: 'desktop' },
        owner: 'pairing',
      });
      expect(pass).toBe(true);
      const verdict = await readFile(path.join(runDir, 'verdict.md'), 'utf8');
      expect(verdict).toContain('# pairing-smoke');
      expect(verdict).toContain('**PASS** — 42ms');
      expect(verdict).toContain('- platform: `desktop`');
      expect(verdict).toContain('- device paired');
      expect(verdict).toContain('all green');
      const evidence = JSON.parse(
        await readFile(path.join(repoRoot, 'artifacts', 'e2e', 'pairing-smoke.json'), 'utf8'),
      );
      expect(evidence).toMatchObject({
        lane: 'e2e',
        owner: 'pairing',
        name: 'pairing-smoke',
        status: 'passed',
      });
      expect(evidence.measurements[0]).toMatchObject({ name: 'wall clock', value: 42, unit: 'ms' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pairing-smoke PASS'));
    } finally {
      log.mockRestore();
    }
  });

  test('FAIL when error is set, including stack and debug sections', async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const err = new Error('timeout waiting for pair');
      const pass = await writeFlowVerdict({
        repoRoot: runDir,
        slug: 'mobile-share',
        runDir,
        elapsedMs: 9,
        error: err,
        notes: [],
        result: undefined,
        debug: 'screenshot: /tmp/x.png',
        owner: null,
      });
      expect(pass).toBe(false);
      const verdict = await readFile(path.join(runDir, 'verdict.md'), 'utf8');
      expect(verdict).toContain('**FAIL** — 9ms');
      expect(verdict).toContain('## Error');
      expect(verdict).toContain('timeout waiting for pair');
      expect(verdict).toContain('## Debug');
      expect(verdict).toContain('screenshot: /tmp/x.png');
    } finally {
      log.mockRestore();
    }
  });

  test('FAIL when result.pass is explicitly false', async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pass = await writeFlowVerdict({
        repoRoot: runDir,
        slug: 'soft-fail',
        runDir,
        elapsedMs: 1,
        error: null,
        notes: [],
        result: { pass: false, notes: 'assertion missed' },
      });
      expect(pass).toBe(false);
      const verdict = await readFile(path.join(runDir, 'verdict.md'), 'utf8');
      expect(verdict).toContain('**FAIL**');
      expect(verdict).toContain('assertion missed');
    } finally {
      log.mockRestore();
    }
  });
});
