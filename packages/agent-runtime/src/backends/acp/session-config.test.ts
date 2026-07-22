// Pure-function coverage for session capability / mode / model helpers.
// These decide resume/load/close ads, permission modes, and model pins.

import { expect, test } from 'vitest';
import {
  hasSessionCapability,
  modeAvailable,
  pinModel,
  readConfigOptions,
  readOfferedModels,
  SET_CONFIG_OPTION,
} from './session-config.ts';

test('hasSessionCapability is false when caps missing or value is null/false', () => {
  expect(hasSessionCapability(undefined, 'resume')).toBe(false);
  expect(hasSessionCapability({}, 'resume')).toBe(false);
  expect(hasSessionCapability({ resume: null }, 'resume')).toBe(false);
  expect(hasSessionCapability({ resume: false }, 'resume')).toBe(false);
});

test('hasSessionCapability is true for {} or any non-null truthy advertisement', () => {
  expect(hasSessionCapability({ resume: {} }, 'resume')).toBe(true);
  expect(hasSessionCapability({ close: true }, 'close')).toBe(true);
  expect(hasSessionCapability({ additionalDirectories: { max: 3 } }, 'additionalDirectories')).toBe(
    true,
  );
});

test('modeAvailable matches currentModeId and availableModes entries', () => {
  expect(modeAvailable(undefined, 'bypassPermissions')).toBe(false);
  expect(modeAvailable({ currentModeId: 'bypassPermissions' }, 'bypassPermissions')).toBe(true);
  expect(
    modeAvailable(
      {
        availableModes: [{ id: 'default' }, { id: 'bypassPermissions' }, 'skip', null],
      },
      'bypassPermissions',
    ),
  ).toBe(true);
  expect(modeAvailable({ availableModes: 'not-array' as unknown as [] }, 'x')).toBe(false);
  expect(modeAvailable({ availableModes: [{ id: 'default' }] }, 'missing')).toBe(false);
});

test('readConfigOptions filters non-objects and empty lists', () => {
  expect(readConfigOptions(undefined)).toEqual([]);
  expect(readConfigOptions({})).toEqual([]);
  expect(readConfigOptions({ configOptions: null })).toEqual([]);
  expect(
    readConfigOptions({
      configOptions: [null, 'x', 1, { id: 'model' }, { category: 'mode' }],
    }),
  ).toEqual([{ id: 'model' }, { category: 'mode' }]);
});

test('readOfferedModels flattens groups and reports currentValue', () => {
  expect(readOfferedModels([])).toEqual({ models: [] });
  expect(
    readOfferedModels([
      {
        id: 'model',
        currentValue: 'm1',
        options: [
          { value: 'm1', name: 'One' },
          { options: [{ value: 'm2' }, { value: 99 }, null] },
          'skip',
        ],
      },
    ]),
  ).toEqual({
    models: [{ value: 'm1', name: 'One' }, { value: 'm2' }],
    currentValue: 'm1',
  });
  // category: "model" also identifies the selector
  expect(readOfferedModels([{ category: 'model', options: [{ value: 'x' }] }]).models).toEqual([
    { value: 'x' },
  ]);
});

const noopRequest = async <T = unknown>(): Promise<T> => undefined as T;

test('pinModel returns current when no model requested', async () => {
  const events: unknown[] = [];
  const out = await pinModel({
    request: noopRequest,
    emit: (e) => events.push(e),
    sessionId: 's1',
    configOptions: [{ id: 'model', currentValue: 'default-m', options: [{ value: 'default-m' }] }],
  });
  expect(out).toBe('default-m');
  expect(events).toEqual([]);
});

test('pinModel warns when agent has no model option', async () => {
  const events: Array<{ type: string; code?: string }> = [];
  const out = await pinModel({
    request: noopRequest,
    emit: (e) => events.push(e as { type: string; code?: string }),
    sessionId: 's1',
    configOptions: [],
    requested: 'opus',
  });
  expect(out).toBeUndefined();
  expect(events[0]?.code).toBe('model_unsupported');
});

test('pinModel warns when requested model is not offered', async () => {
  const events: Array<{ type: string; code?: string }> = [];
  const out = await pinModel({
    request: noopRequest,
    emit: (e) => events.push(e as { type: string; code?: string }),
    sessionId: 's1',
    configOptions: [
      {
        id: 'model',
        currentValue: 'm-default',
        options: [{ value: 'm-default', name: 'Default' }],
      },
    ],
    requested: 'totally-missing',
  });
  expect(out).toBe('m-default');
  expect(events[0]?.code).toBe('model_not_offered');
});

test('pinModel matches by name / substring and skips RPC when already current', async () => {
  let calls = 0;
  const events: unknown[] = [];
  const opts = [
    {
      id: 'model',
      currentValue: 'claude-opus-4-5',
      options: [
        { value: 'claude-opus-4-5', name: 'Opus' },
        { value: 'claude-sonnet-4', name: 'Sonnet' },
      ],
    },
  ];
  const same = await pinModel({
    request: async <T = unknown>(): Promise<T> => {
      calls += 1;
      return undefined as T;
    },
    emit: (e) => events.push(e),
    sessionId: 's1',
    configOptions: opts,
    requested: 'opus',
  });
  expect(same).toBe('claude-opus-4-5');
  expect(calls).toBe(0);

  const switched = await pinModel({
    request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
      calls += 1;
      expect(method).toBe(SET_CONFIG_OPTION);
      expect(params).toEqual({
        sessionId: 's1',
        configId: 'model',
        value: 'claude-sonnet-4',
      });
      return undefined as T;
    },
    emit: (e) => events.push(e),
    sessionId: 's1',
    configOptions: opts,
    requested: 'sonnet',
    resolveModel: (m) => m,
  });
  expect(switched).toBe('claude-sonnet-4');
  expect(calls).toBe(1);
  expect(events).toEqual([]);
});

test('pinModel falls back to current when set_config_option rejects', async () => {
  const events: Array<{ type: string; code?: string }> = [];
  const out = await pinModel({
    request: async <T = unknown>(): Promise<T> => {
      throw new Error('stale option');
    },
    emit: (e) => events.push(e as { type: string; code?: string }),
    sessionId: 's1',
    configOptions: [
      {
        id: 'model',
        currentValue: 'm-default',
        options: [{ value: 'm-other' }],
      },
    ],
    requested: 'm-other',
  });
  expect(out).toBe('m-default');
  expect(events[0]?.code).toBe('model_not_offered');
});

test('pinModel exact value match wins over name', async () => {
  let pinned: string | undefined;
  await pinModel({
    request: async <T = unknown>(_m: string, params: unknown): Promise<T> => {
      pinned = (params as { value: string }).value;
      return undefined as T;
    },
    emit: () => undefined,
    sessionId: 's1',
    configOptions: [
      {
        id: 'model',
        currentValue: 'a',
        options: [
          { value: 'exact-id', name: 'other' },
          { value: 'other-id', name: 'exact-id' },
        ],
      },
    ],
    requested: 'exact-id',
  });
  expect(pinned).toBe('exact-id');
});
