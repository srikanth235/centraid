import { describe, expect, it, vi } from 'vitest';
import { knobsManifestFrom, manifestVaultBlock, pushKnobToAppFrame } from './appSettingsData.js';

// `vi.mock` is hoisted above the import by vitest, so gateway-client-core's
// load-time side-effect never runs.
vi.mock('../../../gateway-client.js', () => ({}));

describe('manifestVaultBlock', () => {
  it('parses a sound vault block', () => {
    const block = manifestVaultBlock({
      vault: { purpose: 'Read tasks', why: 'to summarise', scopes: [{ table: 'tasks' }] },
    });
    expect(block).toEqual({
      purpose: 'Read tasks',
      why: 'to summarise',
      scopes: [{ table: 'tasks' }],
    });
  });

  it('defaults why to empty string', () => {
    const block = manifestVaultBlock({ vault: { purpose: 'x', scopes: [] } });
    expect(block?.why).toBe('');
  });

  it('returns null when absent or malformed', () => {
    expect(manifestVaultBlock(null)).toBeNull();
    expect(manifestVaultBlock({})).toBeNull();
    expect(manifestVaultBlock({ vault: { purpose: 'x' } })).toBeNull(); // no scopes
    expect(manifestVaultBlock({ vault: { scopes: [] } })).toBeNull(); // no purpose
  });
});

describe('knobsManifestFrom', () => {
  it('reads the knobs array + manifest version', () => {
    const m = knobsManifestFrom({ manifestVersion: 3, knobs: [{ key: 'appFont' }] });
    expect(m).toEqual({ version: 3, knobs: [{ key: 'appFont' }] });
  });

  it('defaults version to 1 and returns null without a knobs array', () => {
    expect(knobsManifestFrom({ knobs: [] })).toEqual({ version: 1, knobs: [] });
    expect(knobsManifestFrom({})).toBeNull();
    expect(knobsManifestFrom(null)).toBeNull();
  });
});

describe('pushKnobToAppFrame', () => {
  it('routes Color/Accent keys to CSS vars and the rest to data attributes', () => {
    const frame = document.createElement('iframe');
    frame.dataset.centraidApp = '1';
    document.body.append(frame);
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: post }, writable: true });

    pushKnobToAppFrame('appAccent', '#f00');
    pushKnobToAppFrame('appDensity', 'compact');

    expect(post).toHaveBeenNthCalledWith(
      1,
      { type: 'centraid:settings', dataAttrs: {}, cssVars: { 'app-accent': '#f00' } },
      '*',
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      { type: 'centraid:settings', dataAttrs: { 'app-density': 'compact' }, cssVars: {} },
      '*',
    );
    frame.remove();
  });
});
