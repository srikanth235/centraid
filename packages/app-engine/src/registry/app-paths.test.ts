import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAppId } from './app-paths.js';

describe('isValidAppId', () => {
  it('accepts plain-slug app folder ids', () => {
    assert.equal(isValidAppId('crm'), true);
    assert.equal(isValidAppId('standup-bot'), true);
    assert.equal(isValidAppId('My_App-2'), true);
  });

  it('rejects dotted / path-unsafe / plugin-internal ids', () => {
    assert.equal(isValidAppId(''), false);
    assert.equal(isValidAppId('_internal'), false);
    assert.equal(isValidAppId('a/b'), false);
    assert.equal(isValidAppId('up..dir'), false);
    // Dots are no longer part of the grammar — the legacy `auto.` prefix
    // is gone; automation apps are marked by the manifest `kind` field.
    assert.equal(isValidAppId('auto.standup-bot'), false);
  });
});
