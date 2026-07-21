// Pure-function coverage for the permission auto-allow helpers: how the
// `session/request_permission` options are read off the wire and which one the
// headless policy picks.

import { expect, test } from 'vitest';
import { pickPermissionOption, readPermissionOptions } from './permissions.ts';

test('readPermissionOptions returns [] for non-array / missing options', () => {
  expect(readPermissionOptions(undefined)).toEqual([]);
  expect(readPermissionOptions({})).toEqual([]);
  expect(readPermissionOptions({ options: null })).toEqual([]);
  expect(readPermissionOptions({ options: 'nope' })).toEqual([]);
});

test('readPermissionOptions skips non-objects and entries without a string optionId', () => {
  const out = readPermissionOptions({
    options: [
      null,
      'string-entry',
      42,
      { name: 'no id here' },
      { optionId: 123 },
      { optionId: 'allow' },
    ],
  });
  expect(out).toEqual([{ optionId: 'allow' }]);
});

test('readPermissionOptions copies kind through only when it is a string', () => {
  const out = readPermissionOptions({
    options: [
      { optionId: 'a', kind: 'allow_once' },
      { optionId: 'b', kind: 99 },
      { optionId: 'c' },
    ],
  });
  expect(out).toEqual([
    { optionId: 'a', kind: 'allow_once' },
    { optionId: 'b' },
    { optionId: 'c' },
  ]);
});

test('pickPermissionOption returns undefined for an empty list', () => {
  expect(pickPermissionOption([])).toBeUndefined();
});

test('pickPermissionOption prefers allow_always over everything else', () => {
  const picked = pickPermissionOption([
    { optionId: 'once', kind: 'allow_once' },
    { optionId: 'reject', kind: 'reject_once' },
    { optionId: 'always', kind: 'allow_always' },
  ]);
  expect(picked).toBe('always');
});

test('pickPermissionOption falls back to allow_once when no allow_always', () => {
  const picked = pickPermissionOption([
    { optionId: 'reject', kind: 'reject_once' },
    { optionId: 'once', kind: 'allow_once' },
  ]);
  expect(picked).toBe('once');
});

test('pickPermissionOption falls back to any non-reject (incl. kind-less) option', () => {
  const picked = pickPermissionOption([
    { optionId: 'reject', kind: 'reject_always' },
    { optionId: 'plain' },
  ]);
  expect(picked).toBe('plain');
});

test('pickPermissionOption falls back to the first option when only rejects remain', () => {
  const picked = pickPermissionOption([
    { optionId: 'reject-a', kind: 'reject_once' },
    { optionId: 'reject-b', kind: 'reject_always' },
  ]);
  expect(picked).toBe('reject-a');
});
