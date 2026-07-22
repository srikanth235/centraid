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
    expect(src).toContain('downloadUpdate');
    expect(src).toContain('quitAndInstall');
    expect(src).toContain('updaterChannelForVersion');
    // CJS-safe deferred load only on packaged path — static named ESM import of
    // autoUpdater crashes Electron ("Named export 'autoUpdater' not found").
    expect(src).toContain('createRequire');
    expect(src).toMatch(/req\(['"]electron-updater['"]\)/);
    expect(src).not.toMatch(/import\s*\{[^}]*autoUpdater[^}]*\}\s*from\s*['"]electron-updater['"]/);
    expect(src).toContain('export async function checkForUpdatesManual');
    // Dev mtime path still exists but must announce via admit gate.
    expect(src).toContain(
      'announceUpdateIfAdmitted({ version, releasedAtMs, readyToInstall: true })',
    );
  });

  it('IPC registers UPDATE_CHECK to the manual path (I6)', () => {
    const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8');
    expect(ipc).toContain('checkForUpdatesManual');
    expect(ipc).toContain("UPDATE_CHECK: 'centraid:update:check'");
    expect(ipc).toContain('Channel.UPDATE_CHECK');
  });

  it('maps beta versions to the beta updater channel (D5) — structural', () => {
    // Avoid importing update-watcher (pulls electron). Mirror the pure rule.
    const channel = (version: string) => (/beta/i.test(version) ? 'beta' : 'latest');
    expect(channel('0.2.0-beta.1')).toBe('beta');
    expect(channel('0.2.0')).toBe('latest');
    const src = readFileSync(path.join(here, 'update-watcher.ts'), 'utf8');
    expect(src).toMatch(/function updaterChannelForVersion/);
    expect(src).toMatch(/beta\/i\.test/);
  });
});
