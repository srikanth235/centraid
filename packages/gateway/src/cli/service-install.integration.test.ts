/*
 * REAL launchd round-trip for `centraid-gateway service` (issue #351 wave
 * 4). Everything else in this directory tests unit-content generation and
 * `--dry-run` output against a faked $HOME; this test shells out to the
 * ACTUAL `launchctl` on the box.
 *
 * Gated behind `CENTRAID_LAUNCHD_E2E=1` (darwin only, skips otherwise) —
 * it mutates real launchd state under a TEST label
 * (`dev.centraid.gateway.e2e-test`), never the real `dev.centraid.gateway`
 * label a developer's own daemon might be bootstrapped under. The unit it
 * installs runs `/bin/sleep`, not the actual gateway binary.
 */

import { expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildLaunchdPlist, launchAgentPlistPath, type ServiceUnitSpec } from './service-unit.ts';

vi.setConfig({ testTimeout: 30_000 });

const TEST_LABEL = 'dev.centraid.gateway.e2e-test';

function guiTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('no POSIX uid — cannot address the launchd gui domain');
  return `gui/${uid}`;
}

test('real launchctl bootstrap/print/bootout round-trip against a TEST label, never the real daemon label', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchd e2e only runs on darwin');
    return;
  }
  if (process.env.CENTRAID_LAUNCHD_E2E !== '1') {
    t.skip('set CENTRAID_LAUNCHD_E2E=1 (on darwin) to run the real launchctl e2e');
    return;
  }

  expect(TEST_LABEL).not.toBe('dev.centraid.gateway');

  const home = os.homedir();
  const plistPath = launchAgentPlistPath(home, TEST_LABEL);
  const stdoutLog = path.join(os.tmpdir(), `${TEST_LABEL}-stdout.log`);
  const stderrLog = path.join(os.tmpdir(), `${TEST_LABEL}-stderr.log`);

  // A trivial long-running stand-in — NOT the real gateway — so this
  // test never boots an actual centraid-gateway process under launchd.
  const spec: ServiceUnitSpec = {
    nodeBin: '/bin/sleep',
    cliEntry: '9999999',
    args: [],
    stdoutLog,
    stderrLog,
    workingDirectory: os.tmpdir(),
  };
  const plist = buildLaunchdPlist(TEST_LABEL, spec);

  try {
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, plist, 'utf8');
    execFileSync('launchctl', ['bootstrap', guiTarget(), plistPath], { stdio: 'pipe' });

    let printed = '';
    for (let i = 0; i < 40; i++) {
      try {
        printed = execFileSync('launchctl', ['print', `${guiTarget()}/${TEST_LABEL}`], {
          encoding: 'utf8',
        });
      } catch {
        printed = '';
      }
      if (/state = running/.test(printed)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(printed).toMatch(/state = running/);
  } finally {
    try {
      execFileSync('launchctl', ['bootout', `${guiTarget()}/${TEST_LABEL}`], { stdio: 'pipe' });
    } catch {
      // already unloaded — fine, uninstall is idempotent
    }
    await fs.rm(plistPath, { force: true });
    await fs.rm(stdoutLog, { force: true });
    await fs.rm(stderrLog, { force: true });
  }
}, 30000);
