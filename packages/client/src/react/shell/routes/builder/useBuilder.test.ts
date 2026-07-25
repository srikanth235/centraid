/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Names useBuilder.ts (issue #545 B8). The builder surface is ref-driven (no
 * pure reducer export); pure turn/chat helpers live in builderModel (already
 * tested). This file pins the module export shape for cold-import reachability.
 */

import { describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted so gateway-client-core never touches window.CentraidApi.
vi.mock('../../../../gateway-client.js', () => ({}));
vi.mock('../../../../format.js', () => ({
  generateAppId: () => 'app',
  shortVersionTitle: (s: string) => s,
}));
vi.mock('../../../../app-format.js', () => ({
  inferAppVisual: () => ({ iconKey: 'Sparkle', colorKey: 'violet', color: '#000', name: 'x' }),
}));
vi.mock('../../../../cron.js', () => ({ describeCron: () => '' }));

import { useBuilder } from './useBuilder.js';

describe('useBuilder module', () => {
  it('is a React hook (throws when called without shell context)', () => {
    expect(useBuilder.name).toBe('useBuilder');
    // Without AppContext / React dispatcher the hook fails closed — not a
    // typeof-only smoke. Message varies by React version and input shape.
    expect(() =>
      useBuilder({
        appKind: 'app',
        showToast: () => undefined,
      }),
    ).toThrow();
  });
});
