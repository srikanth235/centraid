// Pure-function coverage for session capability / mode / model helpers.
// These decide resume/load/close ads, permission modes, and model pins.

import { describe, expect, test } from 'vitest';

import {
  hasSessionCapability,
  modeAvailable,
  pinModel,
  pinThoughtLevel,
  readConfigOptionUpdate,
  readConfigOptions,
  readCurrentConfigValue,
  readOfferedModels,
  SET_CONFIG_OPTION,
} from './session-config.ts';

describe('session-config suite', () => {
  test('hasSessionCapability is false when caps missing or value is null/false', () => {
    expect(hasSessionCapability(undefined, 'resume')).toBe(false);
    expect(hasSessionCapability({}, 'resume')).toBe(false);
    expect(hasSessionCapability({ resume: null }, 'resume')).toBe(false);
    expect(hasSessionCapability({ resume: false }, 'resume')).toBe(false);
  });

  test('hasSessionCapability is true for {} or any non-null truthy advertisement', () => {
    expect(hasSessionCapability({ resume: {} }, 'resume')).toBe(true);
    expect(hasSessionCapability({ close: true }, 'close')).toBe(true);
    expect(
      hasSessionCapability({ additionalDirectories: { max: 3 } }, 'additionalDirectories'),
    ).toBe(true);
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
    expect(readConfigOptions(undefined)).toStrictEqual([]);
    expect(readConfigOptions({})).toStrictEqual([]);
    expect(readConfigOptions({ configOptions: null })).toStrictEqual([]);
    expect(
      readConfigOptions({
        configOptions: [null, 'x', 1, { id: 'model' }, { category: 'mode' }],
      }),
    ).toStrictEqual([{ id: 'model' }, { category: 'mode' }]);
  });

  test('readConfigOptionUpdate reads the schema’s full-set notification', () => {
    expect(readConfigOptionUpdate(null)).toBeUndefined();
    expect(readConfigOptionUpdate({ update: null })).toBeUndefined();
    expect(readConfigOptionUpdate({ update: { sessionUpdate: 'other' } })).toBeUndefined();
    expect(
      readConfigOptionUpdate({
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [null, 'skip', { id: 'model' }],
        },
      }),
    ).toStrictEqual([{ id: 'model' }]);
    // The ACP schema's ConfigOptionUpdate has exactly one field, `configOptions`
    // ("the full set"). A notification carrying only a singular option is not a
    // shape the wire defines — reading it as an update is what made the caller
    // MERGE, and merging keeps withdrawn options alive as stale pin targets.
    expect(
      readConfigOptionUpdate({
        update: {
          sessionUpdate: 'config_option_update',
          configOption: { category: 'thought_level' },
        },
      }),
    ).toBeUndefined();
    expect(
      readConfigOptionUpdate({
        update: { sessionUpdate: 'config_option_update' },
      }),
    ).toBeUndefined();
    // An empty full set is a real update: the agent withdrew every option.
    expect(
      readConfigOptionUpdate({
        update: { sessionUpdate: 'config_option_update', configOptions: [] },
      }),
    ).toStrictEqual([]);
  });

  test('readCurrentConfigValue reads only string currentValues, by category', () => {
    const options = [
      { id: 'model', category: 'model', currentValue: 'm-1' },
      { id: 'effort', category: 'thought_level', currentValue: 3 },
    ];
    expect(readCurrentConfigValue(options, 'model')).toBe('m-1');
    expect(readCurrentConfigValue(options, 'thought_level')).toBeUndefined();
    expect(readCurrentConfigValue([], 'model')).toBeUndefined();
  });

  test('readOfferedModels flattens groups and reports currentValue', () => {
    expect(readOfferedModels([])).toStrictEqual({ models: [] });
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
    ).toStrictEqual({
      models: [{ value: 'm1', name: 'One' }, { value: 'm2' }],
      currentValue: 'm1',
    });
    // category: "model" also identifies the selector
    expect(
      readOfferedModels([{ category: 'model', options: [{ value: 'x' }] }]).models,
    ).toStrictEqual([{ value: 'x' }]);
  });

  const noopRequest = async <T = unknown>(): Promise<T> => undefined as T;

  test('pinModel returns current when no model requested', async () => {
    const events: unknown[] = [];
    const out = await pinModel({
      request: noopRequest,
      emit: (e) => events.push(e),
      sessionId: 's1',
      configOptions: [
        {
          id: 'model',
          currentValue: 'default-m',
          options: [{ value: 'default-m' }],
        },
      ],
    });
    expect(out).toBe('default-m');
    expect(events).toStrictEqual([]);
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
        expect(params).toStrictEqual({
          sessionId: 's1',
          configId: 'model',
          value: 'claude-sonnet-4',
        });
        return {
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'claude-sonnet-4',
              options: opts[0]!.options,
            },
          ],
        } as T;
      },
      emit: (e) => events.push(e),
      sessionId: 's1',
      configOptions: opts,
      requested: 'sonnet',
      resolveModel: (m) => m,
    });
    expect(switched).toBe('claude-sonnet-4');
    expect(calls).toBe(1);
    expect(events).toStrictEqual([]);
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

  // D4: "confirmed" means the agent echoed the value OR resolved the pin RPC.
  // The set_config_option RESULT's config echo is optional in the schema, so a
  // resolved request is itself the confirmation — only a CONTRADICTING echo
  // leaves the active value unknown.
  const effortOptions = [
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      currentValue: 'medium',
      options: [{ value: 'medium' }, { value: 'high' }],
    },
  ];

  test('pinThoughtLevel records an echo-confirmed value', async () => {
    const notices: Array<{ code?: string }> = [];
    const confirmed = await pinThoughtLevel({
      request: async <T = unknown>(): Promise<T> =>
        ({
          configOptions: [{ ...effortOptions[0], currentValue: 'high' }],
        }) as T,
      emit: (event) => notices.push(event as { code?: string }),
      sessionId: 's1',
      configOptions: effortOptions,
      requested: 'high',
    });
    expect(confirmed).toBe('high');
    expect(notices).toStrictEqual([]);
  });

  test('pinThoughtLevel records a successful pin that echoes nothing', async () => {
    const notices: Array<{ code?: string }> = [];
    const confirmed = await pinThoughtLevel({
      request: async <T = unknown>(): Promise<T> => ({}) as T,
      emit: (event) => notices.push(event as { code?: string }),
      sessionId: 's1',
      configOptions: effortOptions,
      requested: 'high',
    });
    expect(confirmed).toBe('high');
    expect(notices).toStrictEqual([]);
  });

  test('pinThoughtLevel treats a contradicting echo as unconfirmed', async () => {
    const notices: Array<{ code?: string; level?: string }> = [];
    const unconfirmed = await pinThoughtLevel({
      request: async <T = unknown>(): Promise<T> =>
        ({
          configOptions: [{ ...effortOptions[0], currentValue: 'medium' }],
        }) as T,
      emit: (event) => notices.push(event as { code?: string; level?: string }),
      sessionId: 's1',
      configOptions: effortOptions,
      requested: 'high',
    });
    expect(unconfirmed).toBeUndefined();
    expect(notices.at(-1)).toMatchObject({
      code: 'thought_level_unconfirmed',
      level: 'warn',
    });
  });

  test('pinModel records a successful pin that echoes nothing, and warns on a contradicting echo', async () => {
    const modelOptions = [
      {
        id: 'model',
        category: 'model',
        currentValue: 'm-default',
        options: [{ value: 'm-default' }, { value: 'm-other' }],
      },
    ];
    const quiet: Array<{ code?: string }> = [];
    await expect(
      pinModel({
        request: async <T = unknown>(): Promise<T> => ({}) as T,
        emit: (event) => quiet.push(event as { code?: string }),
        sessionId: 's1',
        configOptions: modelOptions,
        requested: 'm-other',
      }),
    ).resolves.toBe('m-other');
    expect(quiet).toStrictEqual([]);

    const notices: Array<{ code?: string; level?: string }> = [];
    await expect(
      pinModel({
        request: async <T = unknown>(): Promise<T> =>
          ({
            configOptions: [{ ...modelOptions[0], currentValue: 'm-default' }],
          }) as T,
        emit: (event) => notices.push(event as { code?: string; level?: string }),
        sessionId: 's1',
        configOptions: modelOptions,
        requested: 'm-other',
      }),
    ).resolves.toBeUndefined();
    expect(notices.at(-1)).toMatchObject({
      code: 'model_unconfirmed',
      level: 'warn',
    });
  });

  test('pinThoughtLevel surfaces unsupported, unavailable, and rejected effort pins', async () => {
    const notices: Array<{ code?: string }> = [];
    const emit = (event: unknown) => notices.push(event as { code?: string });

    await expect(
      pinThoughtLevel({
        request: noopRequest,
        emit,
        sessionId: 's1',
        configOptions: [],
        requested: 'high',
      }),
    ).resolves.toBeUndefined();
    expect(notices.at(-1)?.code).toBe('thought_level_unsupported');

    const options = [
      {
        id: 'effort',
        category: 'thought_level',
        currentValue: 'medium',
        options: [{ value: 'medium' }, { value: 'high', name: 'High' }],
      },
    ];
    await expect(
      pinThoughtLevel({
        request: noopRequest,
        emit,
        sessionId: 's1',
        configOptions: options,
        requested: 'missing',
      }),
    ).resolves.toBe('medium');
    expect(notices.at(-1)?.code).toBe('thought_level_not_offered');

    await expect(
      pinThoughtLevel({
        request: async () => {
          throw new Error('stale effort option');
        },
        emit,
        sessionId: 's1',
        configOptions: options,
        requested: 'High',
      }),
    ).resolves.toBe('medium');
    expect(notices.at(-1)?.code).toBe('thought_level_not_offered');
  });
});
