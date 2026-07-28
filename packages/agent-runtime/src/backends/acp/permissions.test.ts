// Pure-function coverage for the permission auto-allow helpers: how the
// `session/request_permission` options are read off the wire and which one the
// headless policy picks.

import { describe, expect, test } from 'vitest';

import {
  pickPermissionOption,
  pickRejectPermissionOption,
  readPermissionOptions,
} from './permissions.ts';

describe('permissions', () => {
  test('readPermissionOptions returns [] for non-array / missing options', () => {
    expect(readPermissionOptions(undefined)).toStrictEqual([]);
    expect(readPermissionOptions({})).toStrictEqual([]);
    expect(readPermissionOptions({ options: null })).toStrictEqual([]);
    expect(readPermissionOptions({ options: 'nope' })).toStrictEqual([]);
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
    expect(out).toStrictEqual([{ optionId: 'allow' }]);
  });

  test('readPermissionOptions copies kind through only when it is a string', () => {
    const out = readPermissionOptions({
      options: [
        { optionId: 'a', kind: 'allow_once' },
        { optionId: 'b', kind: 99 },
        { optionId: 'c' },
      ],
    });
    expect(out).toStrictEqual([
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

  test('pickRejectPermissionOption prefers reject_once over the sticky reject_always', () => {
    const picked = pickRejectPermissionOption([
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'no-forever', kind: 'reject_always' },
      { optionId: 'no-now', kind: 'reject_once' },
    ]);
    expect(picked).toBe('no-now');
  });

  test('pickRejectPermissionOption uses reject_always when that is the only refusal', () => {
    expect(
      pickRejectPermissionOption([
        { optionId: 'ok', kind: 'allow_once' },
        { optionId: 'no-forever', kind: 'reject_always' },
      ]),
    ).toBe('no-forever');
  });

  test('pickRejectPermissionOption never repurposes an allow (or kind-less) option as a refusal', () => {
    // No reject option means the caller has to answer `cancelled` — picking an
    // allow here would grant exactly what the policy denies.
    expect(pickRejectPermissionOption([])).toBeUndefined();
    expect(
      pickRejectPermissionOption([{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'plain' }]),
    ).toBeUndefined();
  });
});
