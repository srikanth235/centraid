import { describe, expect, it } from 'vitest';
import type { ScaffoldFile } from '@centraid/blueprints';
import { scaffoldAppFiles, setEnabledInFiles, deleteFromFiles } from './scaffold.js';
import { lintHandlerSource } from '../handler/lint.js';

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('scaffoldAppFiles', () => {
  it('emits app.json + manifest + handler under the derived automation id', () => {
    const out = byPath(scaffoldAppFiles('briefing', { name: 'Briefing', cronExpr: '0 8 * * *' }));
    expect(out.has('app.json')).toBeTruthy();
    // The app.json marks itself an automation app via `kind` (not a dotted id).
    expect((JSON.parse(out.get('app.json')!) as { kind?: string }).kind).toBe('automation');
    expect(out.has('automations/briefing/automation.json')).toBeTruthy();
    expect(out.has('automations/briefing/handler.js')).toBeTruthy();
    const mf = JSON.parse(out.get('automations/briefing/automation.json')!) as {
      enabled: boolean;
      triggers: { kind: string; expr: string }[];
    };
    expect(mf.enabled).toBe(true);
    expect(mf.triggers).toEqual([{ kind: 'cron', expr: '0 8 * * *' }]);
  });

  it('rejects a dotted / path-unsafe app id', () => {
    expect(() => scaffoldAppFiles('auto.briefing')).toThrow(/Invalid automation app id/);
  });

  it('emits a replay-safe default handler (passes the determinism lint)', () => {
    const out = byPath(scaffoldAppFiles('briefing'));
    expect(lintHandlerSource(out.get('automations/briefing/handler.js')!)).toEqual([]);
  });

  it('emits the requires.tools allowlist slot (and model when given)', () => {
    const plain = byPath(scaffoldAppFiles('briefing'));
    const reqs = (
      JSON.parse(plain.get('automations/briefing/automation.json')!) as {
        requires: { tools?: unknown; model?: unknown };
      }
    ).requires;
    expect(reqs.tools).toEqual([]);
    expect(reqs.model).toBe(undefined);

    const withModel = byPath(scaffoldAppFiles('briefing', { model: 'anthropic/x' }));
    const reqs2 = (
      JSON.parse(withModel.get('automations/briefing/automation.json')!) as {
        requires: { model?: unknown };
      }
    ).requires;
    expect(reqs2.model).toBe('anthropic/x');
  });
});

describe('setEnabledInFiles / deleteFromFiles', () => {
  const draft = (): ScaffoldFile[] =>
    scaffoldAppFiles('briefing', { name: 'Briefing', enabled: true });

  it('flips enabled and returns only the changed manifest', () => {
    const changed = setEnabledInFiles(draft(), 'briefing', false);
    expect(changed.length).toBe(1);
    expect(changed[0]!.path).toBe('automations/briefing/automation.json');
    expect((JSON.parse(changed[0]!.content) as { enabled: boolean }).enabled).toBe(false);
  });

  it('no-ops when already at the requested state or absent', () => {
    expect(setEnabledInFiles(draft(), 'briefing', true)).toEqual([]);
    expect(setEnabledInFiles(draft(), 'nope', false)).toEqual([]);
  });

  it('removes every file under the automation subdir', () => {
    const { keep, removed } = deleteFromFiles(draft(), 'briefing');
    expect(removed.sort()).toEqual([
      'automations/briefing/automation.json',
      'automations/briefing/handler.js',
    ]);
    expect(keep.map((f) => f.path)).toEqual(['app.json']);
  });
});
