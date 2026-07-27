/*
 * Every bundled automation template must be deployable as-is: its
 * `automation.json` parses under the REAL manifest validator (trigger
 * kinds, vault block, history), and its handler is syntactically loadable.
 * This is the automation-side twin of blueprints' app-manifests gate — it
 * lives here because blueprints cannot depend on this package (the
 * dependency points the other way).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

const require = createRequire(import.meta.url);
const BLUEPRINTS_ROOT = path.dirname(require.resolve('@centraid/blueprints/package.json'));
const AUTOMATIONS_DIR = path.join(BLUEPRINTS_ROOT, 'automations');

function templateIds(): string[] {
  return readdirSync(AUTOMATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .toSorted();
}

describe('bundled automation templates', () => {
  const ids = templateIds();
  // Pull connectors export a declarative spec; every other template exports a
  // handler function. Partitioning up front keeps both expectations
  // unconditional — a branch inside one case could silently never run.
  const pullIds = ids.filter((id) => id.endsWith('-pull'));
  const handlerFnIds = ids.filter((id) => !id.endsWith('-pull'));

  it('finds the bundled template set', () => {
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  it('covers both handler shapes', () => {
    // Guards the partition itself: an empty side would make one of the
    // `it.each` blocks below register zero tests and prove nothing.
    expect(pullIds.length).toBeGreaterThan(0);
    expect(handlerFnIds.length).toBeGreaterThan(0);
  });

  it.each(ids.map((id) => [id] as const))('%s: automation.json parses', (id) => {
    const raw = readFileSync(
      path.join(AUTOMATIONS_DIR, id, 'automations', id, 'automation.json'),
      'utf8',
    );
    const manifest = parseManifest(raw);
    expect(manifest.name.length).toBeGreaterThan(0);
    // A condition/data trigger without a vault block is unvalidatable —
    // parseManifest enforces it; assert the vault-native templates carry one.
    // Templates with no such trigger are free to omit the block.
    const needsVault = manifest.triggers.some((t) => t.kind === 'condition' || t.kind === 'data');
    expect(manifest.vault !== undefined || !needsVault).toBe(true);
  });

  // A real import: a template with a syntax error would fail every fire at
  // load time. Importing either handler form executes no side effects.
  it.each(pullIds.map((id) => [id] as const))(
    '%s: handler.js loads and exports a pull-connector spec',
    async (id) => {
      const file = path.join(AUTOMATIONS_DIR, id, 'automations', id, 'handler.js');
      const mod = (await import(`${'file://'}${file}`)) as { default?: unknown };
      expect(mod.default).toMatchObject({
        protocol: 'centraid.pull/v1',
        principal: expect.any(Function),
        pull: expect.any(Function),
      });
    },
  );

  it.each(handlerFnIds.map((id) => [id] as const))(
    '%s: handler.js loads and exports a handler function',
    async (id) => {
      const file = path.join(AUTOMATIONS_DIR, id, 'automations', id, 'handler.js');
      const mod = (await import(`${'file://'}${file}`)) as { default?: unknown };
      expect(mod.default).toBeTypeOf('function');
    },
  );
});
