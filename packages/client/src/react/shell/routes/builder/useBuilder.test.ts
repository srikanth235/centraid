/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Names useBuilder.ts (issue #545 B8). The builder surface is ref-driven (no
 * pure reducer export); pure turn/chat helpers live in builderModel (already
 * tested). This file pins the module export shape for cold-import reachability.
 */

import { describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted so gateway-client-core never touches window.CentraidApi.
vi.mock(import('../../../../gateway-client.js'), () => ({}));
vi.mock(import('../../../../format.js'), () => ({
  generateAppId: () => 'app',
  // Matches the real `(v: { versionId, declaredVersion? }) => string` param
  // shape rather than a bare `string`.
  shortVersionTitle: (v: { versionId: string; declaredVersion?: string }) => v.versionId,
}));
vi.mock(import('../../../../app-format.js'), () => ({
  // `color` uses a real palette hex (violet, matching `colorKey`) so it's a
  // valid `ColorHex` literal rather than the arbitrary `'#000'`.
  inferAppVisual: () => ({
    iconKey: 'Sparkle',
    colorKey: 'violet',
    color: '#7C5BD9',
    name: 'x',
  }),
}));
vi.mock(import('../../../../cron.js'), () => ({ describeCron: () => '' }));

import { builderPickerForConversation, useBuilder } from './useBuilder.js';

describe('useBuilder module', () => {
  it('is a React hook (throws when called without shell context)', () => {
    expect(useBuilder.name).toBe('useBuilder');
    // Without AppContext / React dispatcher the hook fails closed — not a
    // typeof-only smoke. React has no dispatcher outside a render, so the very
    // first hook call (`useState`) dereferences null. Matched loosely because
    // the exact wording is a React/engine detail, but the *shape* — a null
    // dispatcher hit on a hook, not some unrelated crash — is the assertion.
    expect(() =>
      useBuilder({
        appKind: 'app',
        showToast: () => undefined,
      }),
    ).toThrow(/Cannot read properties of null \(reading 'useState'\)/u);
  });

  it('restores a persisted conversation runner ahead of the builder default', () => {
    const picker = builderPickerForConversation(
      {
        selectedKind: 'codex',
        anyLoading: false,
        savedModelByKind: {},
        subsystemModelByKind: {},
        defaultConfigPinsByKind: {},
        subsystemConfigPinsByKind: {},
        diagnosticsJson: '{}',
        subsystemRunnerByKey: { builder: 'codex' },
        subsystemRunnerLadders: {},
        cards: [
          {
            kind: 'codex',
            title: 'Codex',
            accent: '#10b981',
            subtitle: 'ready',
            connected: true,
            sessionReady: true,
            modelsLoading: false,
            models: [],
          },
          {
            kind: 'copilot',
            title: 'Copilot',
            accent: '#111827',
            subtitle: 'ready',
            connected: true,
            sessionReady: true,
            modelsLoading: false,
            models: [],
          },
        ],
      },
      'copilot',
      'codex',
    );
    expect(picker.selectedRunnerKind).toBe('copilot');
  });
});
