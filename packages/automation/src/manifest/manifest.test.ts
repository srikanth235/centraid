import { describe, expect, it } from 'vitest';
import {
  ManifestError,
  isPendingWebhookTrigger,
  isValidCronExpression,
  parseManifest,
  validateManifest,
  type Manifest,
} from './manifest.js';

/** A minimal valid `automation.json` object. */
function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Daily digest',
    version: '0.1.0',
    enabled: true,
    prompt: 'Summarize my open PRs every morning',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    requires: {},
    history: { keep: { count: 50 } },
    generated: { by: 'centraid-builder', at: '2026-05-22T00:00:00Z' },
    ...over,
  };
}

describe('isValidCronExpression', () => {
  it('accepts canonical 5-field expressions', () => {
    expect(isValidCronExpression('*/30 * * * *')).toBe(true);
    expect(isValidCronExpression('0 9 * * MON-FRI')).toBe(true);
    expect(isValidCronExpression('15,45 * * * *')).toBe(true);
  });

  it('rejects empty / non-5-field / illegal-char expressions', () => {
    expect(isValidCronExpression('')).toBe(false);
    expect(isValidCronExpression('* * * *')).toBe(false);
    expect(isValidCronExpression('* * * * * *')).toBe(false);
    expect(isValidCronExpression('@hourly')).toBe(false);
    expect(isValidCronExpression('rm -rf / * * * *')).toBe(false);
  });
});

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(baseManifest());
    expect(m.name).toBe('Daily digest');
    expect(m.version).toBe('0.1.0');
    expect(m.enabled).toBe(true);
    // Legacy single `trigger` is dual-read into the plural `triggers`.
    expect(m.triggers.length).toBe(1);
    expect(m.triggers[0]).toEqual({ kind: 'cron', expr: '0 9 * * *' });
  });

  it('reads a plural triggers list with multiple crons', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [
      { kind: 'cron', expr: '0 9 * * *' },
      { kind: 'cron', expr: '0 17 * * *' },
    ];
    const m = validateManifest(raw);
    expect(m.triggers.length).toBe(2);
  });

  it('accepts a webhook trigger with an id + secret hash', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [{ kind: 'webhook', id: 'abc123', secretHash: 'deadbeef' }];
    const m = validateManifest(raw);
    expect(m.triggers[0]?.kind).toBe('webhook');
  });

  it('accepts a pending webhook trigger (un-provisioned)', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [{ kind: 'webhook', pending: true }];
    const m = validateManifest(raw);
    expect(m.triggers[0]?.kind).toBe('webhook');
    expect(isPendingWebhookTrigger(m.triggers[0]!)).toBe(true);
  });

  it('rejects a webhook trigger that is neither provisioned nor pending', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [{ kind: 'webhook' }];
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it('treats an empty triggers list as legal (manual fire only)', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [];
    expect(validateManifest(raw).triggers).toEqual([]);
  });

  it('rejects more than one webhook trigger', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [
      { kind: 'webhook', id: 'a', secretHash: 'h1' },
      { kind: 'webhook', id: 'b', secretHash: 'h2' },
    ];
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it('defaults version to 0.1.0 and enabled to true when absent', () => {
    const raw = baseManifest();
    delete raw.version;
    delete raw.enabled;
    const m = validateManifest(raw);
    expect(m.version).toBe('0.1.0');
    expect(m.enabled).toBe(true);
  });

  it('treats a non-true enabled as disabled', () => {
    expect(validateManifest(baseManifest({ enabled: false })).enabled).toBe(false);
  });

  it('carries the apps association list', () => {
    const m = validateManifest(baseManifest({ apps: ['todos', 'habits'] }));
    expect(m.apps).toEqual(['todos', 'habits']);
  });

  it('rejects a missing name', () => {
    const raw = baseManifest();
    delete raw.name;
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it('rejects a missing prompt', () => {
    const raw = baseManifest();
    delete raw.prompt;
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it('rejects a missing generated block', () => {
    const raw = baseManifest();
    delete raw.generated;
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it('rejects an invalid trigger', () => {
    expect(() => validateManifest(baseManifest({ trigger: { kind: 'webhook' } }))).toThrow(
      ManifestError,
    );
    expect(() =>
      validateManifest(baseManifest({ trigger: { kind: 'cron', expr: 'nope' } })),
    ).toThrow(ManifestError);
  });

  it('rejects apps that is not an array of non-empty strings', () => {
    expect(() => validateManifest(baseManifest({ apps: 'todos' }))).toThrow(ManifestError);
    expect(() => validateManifest(baseManifest({ apps: [''] }))).toThrow(ManifestError);
  });

  it('rejects a requires.model pointing at the mock provider', () => {
    expect(() =>
      validateManifest(baseManifest({ requires: { model: 'centraid-mock/run' } })),
    ).toThrow(ManifestError);
  });

  it('defaults history.keep to {count:100} when history is absent', () => {
    const raw = baseManifest();
    delete raw.history;
    const m: Manifest = validateManifest(raw);
    expect(m.history.keep).toEqual({ count: 100 });
  });
});

describe('parseManifest', () => {
  it('round-trips a JSON string', () => {
    const m = parseManifest(JSON.stringify(baseManifest()));
    expect(m.name).toBe('Daily digest');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseManifest('{not json')).toThrow(ManifestError);
  });
});
