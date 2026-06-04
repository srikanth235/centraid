import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScaffoldFile } from '@centraid/blueprints';
import {
  scaffoldAutomationAppFiles,
  setAutomationEnabledInFiles,
  deleteAutomationFromFiles,
} from './scaffold-automation.js';
import { lintAutomationHandlerSource } from './automation-handler-lint.js';

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('scaffoldAutomationAppFiles', () => {
  it('emits app.json + manifest + handler under the derived automation id', () => {
    const out = byPath(
      scaffoldAutomationAppFiles('briefing', { name: 'Briefing', cronExpr: '0 8 * * *' }),
    );
    assert.ok(out.has('app.json'));
    // The app.json marks itself an automation app via `kind` (not a dotted id).
    assert.equal((JSON.parse(out.get('app.json')!) as { kind?: string }).kind, 'automation');
    assert.ok(out.has('automations/briefing/automation.json'));
    assert.ok(out.has('automations/briefing/handler.js'));
    const mf = JSON.parse(out.get('automations/briefing/automation.json')!) as {
      enabled: boolean;
      triggers: { kind: string; expr: string }[];
    };
    assert.equal(mf.enabled, true);
    assert.deepEqual(mf.triggers, [{ kind: 'cron', expr: '0 8 * * *' }]);
  });

  it('rejects a dotted / path-unsafe app id', () => {
    assert.throws(() => scaffoldAutomationAppFiles('auto.briefing'), /Invalid automation app id/);
  });

  it('emits a replay-safe default handler (passes the determinism lint)', () => {
    const out = byPath(scaffoldAutomationAppFiles('briefing'));
    assert.deepEqual(lintAutomationHandlerSource(out.get('automations/briefing/handler.js')!), []);
  });

  it('emits the requires.tools allowlist slot (and model when given)', () => {
    const plain = byPath(scaffoldAutomationAppFiles('briefing'));
    const reqs = (
      JSON.parse(plain.get('automations/briefing/automation.json')!) as {
        requires: { tools?: unknown; model?: unknown };
      }
    ).requires;
    assert.deepEqual(reqs.tools, []);
    assert.equal(reqs.model, undefined);

    const withModel = byPath(scaffoldAutomationAppFiles('briefing', { model: 'anthropic/x' }));
    const reqs2 = (
      JSON.parse(withModel.get('automations/briefing/automation.json')!) as {
        requires: { model?: unknown };
      }
    ).requires;
    assert.equal(reqs2.model, 'anthropic/x');
  });
});

describe('setAutomationEnabledInFiles / deleteAutomationFromFiles', () => {
  const draft = (): ScaffoldFile[] =>
    scaffoldAutomationAppFiles('briefing', { name: 'Briefing', enabled: true });

  it('flips enabled and returns only the changed manifest', () => {
    const changed = setAutomationEnabledInFiles(draft(), 'briefing', false);
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.path, 'automations/briefing/automation.json');
    assert.equal((JSON.parse(changed[0]!.content) as { enabled: boolean }).enabled, false);
  });

  it('no-ops when already at the requested state or absent', () => {
    assert.deepEqual(setAutomationEnabledInFiles(draft(), 'briefing', true), []);
    assert.deepEqual(setAutomationEnabledInFiles(draft(), 'nope', false), []);
  });

  it('removes every file under the automation subdir', () => {
    const { keep, removed } = deleteAutomationFromFiles(draft(), 'briefing');
    assert.deepEqual(removed.sort(), [
      'automations/briefing/automation.json',
      'automations/briefing/handler.js',
    ]);
    assert.deepEqual(
      keep.map((f) => f.path),
      ['app.json'],
    );
  });
});
