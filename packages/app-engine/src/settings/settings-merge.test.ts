import { describe, expect, it } from 'vitest';
import { buildSettingsInject } from './settings-merge.js';

describe('buildSettingsInject', () => {
  it('routes known keys to the right bucket', () => {
    const out = buildSettingsInject([{ theme: 'dark', bgL: 5, density: 'comfy' }]);
    expect(out.dataAttrs).toEqual({ theme: 'dark', density: 'comfy' });
    expect(out.cssVars).toEqual({ 'bg-l': '5%' });
  });

  it('drops unknown keys silently', () => {
    const out = buildSettingsInject([{ theme: 'dark', somethingElse: 'value' }]);
    expect(out.dataAttrs).toEqual({ theme: 'dark' });
    expect(out.cssVars).toEqual({});
  });

  it('coerces booleans for coolCast', () => {
    expect(buildSettingsInject([{ coolCast: true }]).dataAttrs).toEqual({ 'cool-cast': 'on' });
    expect(buildSettingsInject([{ coolCast: false }]).dataAttrs).toEqual({ 'cool-cast': 'off' });
  });

  it('coerces numeric bgL into a percentage string', () => {
    expect(buildSettingsInject([{ bgL: 12 }]).cssVars).toEqual({ 'bg-l': '12%' });
    expect(buildSettingsInject([{ bgL: '7' }]).cssVars).toEqual({ 'bg-l': '7%' });
  });

  it('drops invalid bgL values', () => {
    expect(buildSettingsInject([{ bgL: 'abc' }]).cssVars).toEqual({});
    expect(buildSettingsInject([{ bgL: NaN }]).cssVars).toEqual({});
  });

  it('layers later wins, undefined/null falls through', () => {
    const out = buildSettingsInject([
      { theme: 'dark', density: 'compact' },
      { theme: 'light' },
      { density: undefined },
    ]);
    expect(out.dataAttrs.theme).toBe('light');
    expect(out.dataAttrs.density).toBe('compact');
  });

  it('null in a later layer also falls through', () => {
    const out = buildSettingsInject([{ theme: 'dark' }, { theme: null }]);
    // null is intentionally treated as "no value" so the previous layer wins.
    // (Removal at the source is the UserStore's setPrefs({k: null}) deletion,
    //  not a layer-merge concern.)
    expect(out.dataAttrs.theme).toBe('dark');
  });

  it('empty layers produce empty result', () => {
    const out = buildSettingsInject([]);
    expect(out.dataAttrs).toEqual({});
    expect(out.cssVars).toEqual({});
  });

  it('skips undefined layer entries', () => {
    const out = buildSettingsInject([undefined, { theme: 'dark' }, undefined]);
    expect(out.dataAttrs.theme).toBe('dark');
  });

  it('routes dynamic app-namespace keys to data attrs by default', () => {
    const out = buildSettingsInject([
      { appFont: 'serif', appWidth: 'wide', appCornerRadius: 'pill' },
    ]);
    expect(out.dataAttrs).toEqual({
      'app-font': 'serif',
      'app-width': 'wide',
      'app-corner-radius': 'pill',
    });
    expect(out.cssVars).toEqual({});
  });

  it('routes Color/Accent-suffixed app keys to CSS vars', () => {
    const out = buildSettingsInject([{ appColor: '#5847e0', appAccent: '#2EA098' }]);
    expect(out.cssVars).toEqual({ 'app-color': '#5847e0', 'app-accent': '#2EA098' });
    expect(out.dataAttrs).toEqual({});
  });

  it('ignores bare `app` and `apps` (not the namespace prefix)', () => {
    const out = buildSettingsInject([{ app: 'x', apps: 'y', appFoo: 'z' }]);
    expect(out.dataAttrs).toEqual({ 'app-foo': 'z' });
  });
});
