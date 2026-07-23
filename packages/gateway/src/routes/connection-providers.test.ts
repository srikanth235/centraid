import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, capabilitiesFromConnectors } from './connection-providers.js';

describe('PROVIDER_PRESETS capabilities', () => {
  it('declares capabilities on every preset with no secret cells', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
    for (const p of PROVIDER_PRESETS) {
      expect(p.capabilities).toBeDefined();
      expect(p.capabilities.syncs.length + p.capabilities.actions.length).toBeGreaterThan(0);
      // Capability / action DTOs must never carry secret cells (credKind is not a secret).
      const capJson = JSON.stringify(p.capabilities);
      expect(capJson).not.toMatch(/client_secret|access_token|refresh_token|"apiKey"/);
      // Syncs map to real pull templates that are not -send.
      for (const s of p.capabilities.syncs) {
        expect(s.templateId.endsWith('-send')).toBe(false);
        expect(s.kind.length).toBeGreaterThan(0);
        expect(s.defaultCron).toMatch(/\S/);
      }
      for (const a of p.capabilities.actions) {
        expect(a.toolName.startsWith('connector.')).toBe(true);
      }
    }
  });

  it('maps pull connectors to syncs and send templates to actions', () => {
    const caps = capabilitiesFromConnectors([
      { templateId: 'github-pull', kind: 'pull.github' },
      { templateId: 'google-gmail-send', kind: 'pull.gmail' },
    ]);
    expect(caps.syncs.map((s) => s.templateId)).toEqual(['github-pull']);
    expect(caps.actions.some((a) => a.templateId === 'google-gmail-send')).toBe(true);
    expect(caps.actions.some((a) => a.toolName === 'connector.pull_github.list')).toBe(true);
  });

  it('google preset includes gmail sync and send action', () => {
    const google = PROVIDER_PRESETS.find((p) => p.id === 'google')!;
    expect(google.capabilities.syncs.some((s) => s.kind === 'pull.gmail')).toBe(true);
    expect(
      google.capabilities.actions.some(
        (a) => a.toolName.includes('gmail') && a.approval === 'outbox',
      ),
    ).toBe(true);
    expect(new Set(google.capabilities.actions.map((action) => action.toolName)).size).toBe(
      google.capabilities.actions.length,
    );
  });

  it('pins the GitLab token only to the API host the preset actually uses', () => {
    const gitlab = PROVIDER_PRESETS.find((preset) => preset.id === 'gitlab')!;
    expect(gitlab.allowedHosts).toEqual(['gitlab.com']);
  });
});
