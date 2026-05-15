import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsInject } from './settings-merge.js';

describe('buildSettingsInject', () => {
  it('routes known keys to the right bucket', () => {
    const out = buildSettingsInject([{ theme: 'dark', bgL: 5, density: 'comfy' }]);
    assert.deepEqual(out.dataAttrs, { theme: 'dark', density: 'comfy' });
    assert.deepEqual(out.cssVars, { 'bg-l': '5%' });
  });

  it('drops unknown keys silently', () => {
    const out = buildSettingsInject([{ theme: 'dark', somethingElse: 'value' }]);
    assert.deepEqual(out.dataAttrs, { theme: 'dark' });
    assert.deepEqual(out.cssVars, {});
  });

  it('coerces booleans for coolCast', () => {
    assert.deepEqual(buildSettingsInject([{ coolCast: true }]).dataAttrs, { 'cool-cast': 'on' });
    assert.deepEqual(buildSettingsInject([{ coolCast: false }]).dataAttrs, { 'cool-cast': 'off' });
  });

  it('coerces numeric bgL into a percentage string', () => {
    assert.deepEqual(buildSettingsInject([{ bgL: 12 }]).cssVars, { 'bg-l': '12%' });
    assert.deepEqual(buildSettingsInject([{ bgL: '7' }]).cssVars, { 'bg-l': '7%' });
  });

  it('drops invalid bgL values', () => {
    assert.deepEqual(buildSettingsInject([{ bgL: 'abc' }]).cssVars, {});
    assert.deepEqual(buildSettingsInject([{ bgL: NaN }]).cssVars, {});
  });

  it('layers later wins, undefined/null falls through', () => {
    const out = buildSettingsInject([
      { theme: 'dark', density: 'compact' },
      { theme: 'light' },
      { density: undefined },
    ]);
    assert.equal(out.dataAttrs.theme, 'light');
    assert.equal(out.dataAttrs.density, 'compact');
  });

  it('null in a later layer also falls through', () => {
    const out = buildSettingsInject([{ theme: 'dark' }, { theme: null }]);
    // null is intentionally treated as "no value" so the previous layer wins.
    // (Removal at the source is the UserStore's setPrefs({k: null}) deletion,
    //  not a layer-merge concern.)
    assert.equal(out.dataAttrs.theme, 'dark');
  });

  it('empty layers produce empty result', () => {
    const out = buildSettingsInject([]);
    assert.deepEqual(out.dataAttrs, {});
    assert.deepEqual(out.cssVars, {});
  });

  it('skips undefined layer entries', () => {
    const out = buildSettingsInject([undefined, { theme: 'dark' }, undefined]);
    assert.equal(out.dataAttrs.theme, 'dark');
  });

  it('routes dynamic app-namespace keys to data attrs by default', () => {
    const out = buildSettingsInject([
      { appFont: 'serif', appWidth: 'wide', appCornerRadius: 'pill' },
    ]);
    assert.deepEqual(out.dataAttrs, {
      'app-font': 'serif',
      'app-width': 'wide',
      'app-corner-radius': 'pill',
    });
    assert.deepEqual(out.cssVars, {});
  });

  it('routes Color/Accent-suffixed app keys to CSS vars', () => {
    const out = buildSettingsInject([{ appColor: '#5847e0', appAccent: '#2EA098' }]);
    assert.deepEqual(out.cssVars, { 'app-color': '#5847e0', 'app-accent': '#2EA098' });
    assert.deepEqual(out.dataAttrs, {});
  });

  it('ignores bare `app` and `apps` (not the namespace prefix)', () => {
    const out = buildSettingsInject([{ app: 'x', apps: 'y', appFoo: 'z' }]);
    assert.deepEqual(out.dataAttrs, { 'app-foo': 'z' });
  });
});
