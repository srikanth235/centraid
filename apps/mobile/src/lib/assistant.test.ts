import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));

vi.mock('./gateway', () => ({
  apiHeaders: () => ({}),
  fetchJson: gateway.fetchJson,
  requireGatewayBase: () => Promise.resolve('https://gateway.test'),
}));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));

const { loadAssistantConfig } = await import('./assistant');

beforeEach(() => {
  gateway.fetchJson.mockReset().mockImplementation((url: string) => {
    if (url.endsWith('/_centraid-user/prefs')) {
      return Promise.resolve({
        prefs: {
          'agent.runner.kind': 'codex',
          'model.codex.default': 'gpt-5',
          'config.codex.default.thought_level': 'high',
        },
      });
    }
    return Promise.resolve({
      agents: [
        {
          kind: 'codex',
          label: 'Codex',
          available: true,
          models: [{ id: 'gpt-5', name: 'GPT-5' }],
          capabilities: {
            reachable: true,
            authRequired: false,
            modelConfigurable: true,
            usageUpdateObserved: true,
            promptImage: true,
            configOptions: [
              {
                category: 'thought_level',
                currentValue: 'medium',
                values: [{ value: 'high', name: 'High' }],
              },
            ],
          },
        },
        {
          kind: 'claude-code',
          label: 'Claude Code',
          available: true,
          models: [{ id: 'opus', name: 'Opus' }],
          capabilities: {
            reachable: true,
            authRequired: true,
            modelConfigurable: true,
            usageUpdateObserved: false,
            promptImage: false,
          },
        },
        {
          kind: 'legacy',
          label: 'Legacy ACP',
          available: true,
          models: [{ id: 'hidden', name: 'Must stay hidden' }],
          capabilities: {
            reachable: true,
            authRequired: false,
            modelConfigurable: false,
            usageUpdateObserved: false,
            promptImage: false,
          },
        },
      ],
    });
  });
});

describe('loadAssistantConfig', () => {
  it('gates mobile controls and session readiness from live ACP capabilities', async () => {
    const config = await loadAssistantConfig();
    expect(config).toMatchObject({
      runnerKind: 'codex',
      selectedModel: 'gpt-5',
      selectedEffort: 'high',
      supportsAttachments: true,
      supportsContext: true,
    });
    expect(config.runners.find((runner) => runner.kind === 'codex')).toMatchObject({
      sessionReady: true,
      supportsAttachments: true,
      supportsContext: true,
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
    });
    expect(config.runners.find((runner) => runner.kind === 'claude-code')).toMatchObject({
      sessionReady: false,
      supportsAttachments: false,
      supportsContext: false,
      hint: expect.stringContaining('requires setup or sign-in'),
    });
    expect(config.runners.find((runner) => runner.kind === 'legacy')).toMatchObject({
      sessionReady: true,
      models: [],
      efforts: [],
      supportsAttachments: false,
      supportsContext: false,
    });
  });

  it('requests a fresh session probe before a runner switch', async () => {
    await loadAssistantConfig({ refresh: true });
    expect(gateway.fetchJson).toHaveBeenCalledWith(
      'https://gateway.test/centraid/_agents/status?refresh=1',
      expect.any(Object),
    );
  });

  it('falls a stale runner preference back to a runner reported by the gateway', async () => {
    gateway.fetchJson.mockImplementation((url: string) => {
      if (url.endsWith('/_centraid-user/prefs')) {
        return Promise.resolve({ prefs: { 'agent.runner.kind': 'removed-runner' } });
      }
      return Promise.resolve({
        agents: [
          {
            kind: 'codex',
            label: 'Codex',
            available: true,
            capabilities: {
              reachable: true,
              authRequired: false,
              modelConfigurable: false,
              usageUpdateObserved: false,
              promptImage: false,
            },
          },
        ],
      });
    });
    await expect(loadAssistantConfig()).resolves.toMatchObject({ runnerKind: 'codex' });
  });
});
