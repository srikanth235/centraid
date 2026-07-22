/**
 * Tests for lean runtime assemble + symlink rewrite (issue #504).
 * Run: node --test scripts/gateway-package/assemble-runtime.test.mjs
 *
 * Requires a built monorepo gateway closure (each package dist present).
 * One assemble per file — full node_modules copy is expensive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleRuntime,
  GATEWAY_WORKSPACE_PACKAGES,
  rewriteRuntimeSymlinks,
} from './assemble-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function canAssemble() {
  return GATEWAY_WORKSPACE_PACKAGES.every((p) => existsSync(path.join(root, p, 'dist')));
}

function underOut(resolved, out) {
  const outR = realpathSync(out);
  const resR = realpathSync(resolved);
  return resR === outR || resR.startsWith(outR + path.sep);
}

test('assembleRuntime rewrites @centraid links and resolves under out only', (t) => {
  if (!canAssemble()) {
    t.skip('gateway package dist missing — build @centraid/gateway first');
    return;
  }
  const out = mkdtempSync(path.join(tmpdir(), 'centraid-assemble-'));
  try {
    assembleRuntime({ root, out });
    const scope = path.join(out, 'node_modules', '@centraid');

    for (const pkg of GATEWAY_WORKSPACE_PACKAGES) {
      const name = pkg.replace(/^packages\//, '');
      const link = path.join(scope, name);
      assert.ok(existsSync(link), `missing link ${name}`);
      const target = readlinkSync(link);
      assert.equal(
        path.isAbsolute(target),
        false,
        `@centraid/${name} must be relative, got ${target}`,
      );
      const resolved = realpathSync(link);
      assert.ok(underOut(resolved, out), `@centraid/${name} resolves outside out: ${resolved}`);
      assert.ok(
        resolved.includes(`${path.sep}packages${path.sep}${name}`),
        `@centraid/${name} should resolve into packages/${name}, got ${resolved}`,
      );
    }

    // Non-closure workspace names must not remain under @centraid.
    assert.equal(existsSync(path.join(scope, 'tsconfig')), false);
    assert.equal(existsSync(path.join(scope, 'client')), false);

    // Module resolution from assembled gateway must not hit monorepo packages/.
    const fromFile = path.join(out, 'packages/gateway/dist/cli/cli.js');
    const req = createRequire(fromFile);
    const resolved = req.resolve('@centraid/app-engine');
    assert.ok(underOut(resolved, out), `resolve must stay under out, got ${resolved}`);
    const monoPkg = realpathSync(path.join(root, 'packages', 'app-engine'));
    const resR = realpathSync(resolved);
    assert.equal(
      resR === monoPkg || resR.startsWith(monoPkg + path.sep),
      false,
      `resolved into monorepo packages: ${resolved}`,
    );

    // Idempotent rewrite.
    rewriteRuntimeSymlinks(out);
    assert.equal(path.isAbsolute(readlinkSync(path.join(scope, 'gateway'))), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
