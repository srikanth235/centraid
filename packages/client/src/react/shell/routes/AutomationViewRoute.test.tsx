// governance: allow-repo-hygiene file-size-limit (#567) one Automation Q&A route suite shares the mocked bridge and persistence fixture across runner, model, effort, provider-consent, and reload cases
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationThreadScreenProps } from '../../screens/AutomationThreadScreen.js';

const captured = vi.hoisted(() => ({
  props: null as AutomationThreadScreenProps | null,
}));
const actions = vi.hoisted(() => ({
  confirm: vi.fn(),
  navigate: vi.fn(),
  showToast: vi.fn(),
}));
const api = vi.hoisted(() => ({
  auth: vi.fn(),
  compileAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  listAutomationTurns: vi.fn(),
  readAutomationTurnExpanded: vi.fn(),
  readGatewayCapabilities: vi.fn(),
  rotateAutomationWebhookSecret: vi.fn(),
  runAutomationNow: vi.fn(),
  setAutomationEnabled: vi.fn(),
  streamAutomationConversationTurn: vi.fn(),
  streamAutomationTurn: vi.fn(),
}));
const helpers = vi.hoisted(() => ({
  automationLiveMessages: vi.fn(),
  automationTurnMessages: vi.fn(),
  createLiveTrace: vi.fn(),
  createLiveTraceFromItems: vi.fn(),
  decideConsent: vi.fn(),
  deriveHero: vi.fn(),
  finishLiveItem: vi.fn(),
  finishLiveTrace: vi.fn(),
  loadThread: vi.fn(),
  loadProviders: vi.fn(),
  openWebhookReveal: vi.fn(),
  reduceItem: vi.fn(),
  reduceTurn: vi.fn(),
  startLiveItem: vi.fn(),
}));

vi.mock('../../../gateway-client.js', () => api);
vi.mock('../actions.js', () => ({ useShellActions: () => actions }));
vi.mock('../PageScroll.js', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../screens/AutomationThreadScreen.js', () => ({
  default: (props: AutomationThreadScreenProps) => {
    captured.props = props;
    return null;
  },
}));
vi.mock('./automationThreadData.js', () => ({
  decideConsentItem: helpers.decideConsent,
  loadAutomationThreadData: helpers.loadThread,
}));
vi.mock('./automationsData.js', () => ({ deriveAutomationHero: helpers.deriveHero }));
// Partial: only the projection is stubbed. `automationTurnInboundText` is the
// shared cold/live agreement on a compile turn's inbound bubble (#541) — the
// route must exercise the real one.
vi.mock('./automationTurnMessages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automationTurnMessages.js')>()),
  automationTurnMessages: helpers.automationTurnMessages,
}));
vi.mock('./automationLiveMessages.js', () => ({
  automationLiveMessages: helpers.automationLiveMessages,
  createAutomationLiveTrace: helpers.createLiveTrace,
  createAutomationLiveTraceFromItems: helpers.createLiveTraceFromItems,
  finishAutomationLiveItem: helpers.finishLiveItem,
  finishAutomationLiveTrace: helpers.finishLiveTrace,
  reduceAutomationItemEvent: helpers.reduceItem,
  reduceAutomationTurnEvent: helpers.reduceTurn,
  startAutomationLiveItem: helpers.startLiveItem,
}));
vi.mock('../webhookReveal.js', () => ({ openWebhookReveal: helpers.openWebhookReveal }));
vi.mock('./settingsProvidersData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settingsProvidersData.js')>()),
  loadProviders: helpers.loadProviders,
}));

const {
  automationPicker,
  latestAdapterKind,
  default: AutomationViewRoute,
} = await import('./AutomationViewRoute.js');

function automationRow(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest['triggers'] = [{ kind: 'cron', expr: '0 9 * * *' }];
  return {
    id: 'daily',
    dir: '/apps/daily',
    name: 'Daily',
    triggers,
    enabled: false,
    ownerApp: 'daily',
    ref: 'daily/daily',
    manifest: {
      name: 'Daily',
      version: '0.1.0',
      enabled: false,
      prompt: 'Run daily.',
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: 'agent', at: '2026-07-25T00:00:00.000Z' },
    },
  };
}

const turn = {
  turnId: 'turn-1',
  conversationId: 'conversation-1',
  automationId: 'daily/daily',
  triggerKind: 'manual',
  seq: 1,
  startedAt: 100,
  endedAt: 120,
  ok: true,
  pinned: false,
} satisfies CentraidAutomationTurnRecord;

const item = {
  itemId: 'item-1',
  turnId: 'turn-1',
  ordinal: 0,
  kind: 'message_in',
  text: 'Run now',
  ok: true,
  startedAt: 100,
  endedAt: 101,
  durationMs: 1,
} satisfies CentraidAutomationItem;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<AutomationThreadScreenProps> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationViewRoute automationId="daily/daily" />);
  });
  if (!captured.props) throw new Error('thread bridge was not captured');
  return captured.props;
}

beforeEach(() => {
  captured.props = null;
  actions.confirm.mockReset().mockResolvedValue(true);
  actions.navigate.mockReset();
  actions.showToast.mockReset();

  api.auth.mockReset().mockResolvedValue({ baseUrl: 'https://gateway.test' });
  api.compileAutomation.mockReset().mockResolvedValue({ compileTurnId: 'compile-1' });
  api.deleteAutomation.mockReset().mockResolvedValue({ ok: true });
  api.listAutomationTurns.mockReset().mockResolvedValue([
    { ...turn, totalInputTokens: 12, totalOutputTokens: 8 },
    { ...turn, turnId: 'turn-zero', totalInputTokens: 0, totalOutputTokens: 0 },
  ]);
  api.readAutomationTurnExpanded.mockReset().mockResolvedValue({
    turn,
    items: [item],
  });
  api.readGatewayCapabilities.mockReset().mockResolvedValue({ automationTurns: true });
  api.rotateAutomationWebhookSecret.mockReset().mockResolvedValue({
    webhook: { id: 'hook-1', secret: 'secret-2', url: 'https://gateway.test/hook-1' },
  });
  api.runAutomationNow.mockReset().mockResolvedValue({ turnId: 'turn-2' });
  api.setAutomationEnabled.mockReset().mockResolvedValue({ ok: true });
  api.streamAutomationConversationTurn
    .mockReset()
    .mockImplementation(
      async (
        _automationId: string,
        _text: string,
        onEvent: (event: { type: string; text?: string }) => void,
      ) => {
        onEvent({ type: 'assistant.delta', text: 'Done' });
        return { turnId: 'turn-3', ended: true };
      },
    );
  api.streamAutomationTurn
    .mockReset()
    .mockImplementation(
      async (_turnId: string, onEvent: (event: Record<string, unknown>) => void): Promise<void> => {
        onEvent({
          type: 'item.start',
          itemId: 'tool-1',
          ordinal: 1,
          kind: 'tool',
          name: 'vault.query',
          callId: 'call-1',
        });
        onEvent({
          type: 'item.delta',
          itemId: 'tool-1',
          ordinal: 1,
          event: { type: 'tool.delta', delta: 'working' },
        });
        onEvent({
          type: 'item.end',
          itemId: 'tool-1',
          ordinal: 1,
          callId: 'call-1',
          ok: true,
          durationMs: 5,
        });
        onEvent({ type: 'turn.end', turnId: 'turn-1', ok: true });
      },
    );

  helpers.automationLiveMessages.mockReset().mockReturnValue([{ kind: 'ai', text: 'live' }]);
  helpers.automationTurnMessages.mockReset().mockReturnValue([{ kind: 'ai', text: 'cold' }]);
  helpers.createLiveTrace.mockReset().mockReturnValue({ trace: 'new' });
  helpers.createLiveTraceFromItems.mockReset().mockReturnValue({ trace: 'items' });
  helpers.decideConsent.mockReset().mockResolvedValue(true);
  helpers.deriveHero.mockReset().mockReturnValue({
    conditionDetail: null,
    cronExprs: ['0 9 * * *'],
    dataDetail: null,
  });
  helpers.finishLiveItem.mockReset().mockReturnValue({ trace: 'finished-item' });
  helpers.finishLiveTrace.mockReset().mockReturnValue({ trace: 'finished' });
  helpers.loadThread.mockReset().mockResolvedValue({
    row: automationRow(),
    data: {
      consent: { grants: [], outbox: [], parked: [] },
      header: {
        enabled: false,
        name: 'Daily',
        nextRuns: [],
        status: { kind: 'paused', label: 'Paused' },
        triggerSummary: 'Every day',
        webhook: null,
      },
      runs: [],
    },
  });
  helpers.loadProviders.mockReset().mockResolvedValue({
    selectedKind: 'codex',
    anyLoading: false,
    savedModelByKind: {},
    subsystemModelByKind: {},
    defaultConfigPinsByKind: {},
    subsystemConfigPinsByKind: {},
    diagnosticsJson: '{}',
    subsystemRunnerByKey: { automations: 'codex' },
    subsystemRunnerLadders: {},
    cards: [
      {
        kind: 'codex',
        title: 'Codex',
        accent: '#10b981',
        subtitle: 'ready',
        connected: true,
        sessionReady: true,
        modelsLoading: false,
        models: [],
      },
      {
        kind: 'copilot',
        title: 'Copilot',
        accent: '#111827',
        subtitle: 'ready',
        connected: true,
        sessionReady: true,
        modelsLoading: false,
        models: [],
      },
    ],
  });
  helpers.openWebhookReveal.mockReset().mockResolvedValue(undefined);
  helpers.reduceItem.mockReset().mockReturnValue({ trace: 'delta' });
  helpers.reduceTurn.mockReset().mockReturnValue({ trace: 'conversation' });
  helpers.startLiveItem.mockReset().mockReturnValue({ trace: 'started' });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('AutomationViewRoute', () => {
  it('drops provider-specific manifest pins after an attended cross-provider switch', () => {
    const status = {
      selectedKind: 'codex',
      anyLoading: false,
      savedModelByKind: {},
      subsystemModelByKind: { copilot: { automations: 'copilot-default' } },
      defaultConfigPinsByKind: {},
      subsystemConfigPinsByKind: {
        copilot: { automations: { thought_level: 'medium' } },
      },
      diagnosticsJson: '{}',
      subsystemRunnerByKey: { automations: 'codex' },
      subsystemRunnerLadders: {},
      cards: [
        {
          kind: 'codex',
          title: 'Codex',
          accent: '#10b981',
          subtitle: 'ready',
          connected: true,
          sessionReady: true,
          modelConfigurable: true,
          modelsLoading: false,
          models: [{ id: 'gpt-a' }],
          configOptions: [
            {
              id: 'thought',
              category: 'thought_level',
              type: 'select',
              values: [{ value: 'high' }],
            },
          ],
        },
        {
          kind: 'copilot',
          title: 'Copilot',
          accent: '#111827',
          subtitle: 'ready',
          connected: true,
          sessionReady: true,
          modelConfigurable: true,
          modelsLoading: false,
          models: [{ id: 'copilot-default' }],
          configOptions: [
            {
              id: 'thought',
              category: 'thought_level',
              type: 'select',
              values: [{ value: 'medium' }],
            },
          ],
        },
      ],
    } satisfies import('../../screen-contracts.js').AgentsStatusDTO;
    expect(
      automationPicker(status, 'codex', {
        runner: 'codex',
        model: 'gpt-a',
        thoughtLevel: 'high',
      }),
    ).toMatchObject({
      selectedModelId: 'gpt-a',
      selectedEffortId: 'high',
      modelLocked: true,
      effortLocked: true,
    });
    expect(
      automationPicker(status, 'copilot', {
        runner: 'codex',
        model: 'gpt-a',
        thoughtLevel: 'high',
      }),
    ).toMatchObject({
      selectedRunnerKind: 'copilot',
      selectedModelId: 'copilot-default',
      selectedEffortId: 'medium',
    });
    expect(
      automationPicker(status, 'copilot', {
        runner: 'codex',
        model: 'gpt-a',
        thoughtLevel: 'high',
      }),
    ).not.toMatchObject({ modelLocked: true, effortLocked: true });
  });

  it('resolves an unregistered manifest runner to a reported fallback and keeps its pins', () => {
    const status = {
      selectedKind: 'codex',
      anyLoading: false,
      savedModelByKind: {},
      subsystemModelByKind: {},
      defaultConfigPinsByKind: {},
      subsystemConfigPinsByKind: {},
      diagnosticsJson: '{}',
      subsystemRunnerByKey: { automations: 'codex' },
      subsystemRunnerLadders: {},
      cards: [
        {
          kind: 'codex',
          title: 'Codex',
          accent: '#10b981',
          subtitle: 'ready',
          connected: true,
          sessionReady: true,
          modelConfigurable: true,
          modelsLoading: false,
          models: [{ id: 'gpt-a' }],
          configOptions: [
            {
              id: 'thought',
              category: 'thought_level',
              type: 'select',
              values: [{ value: 'high' }],
            },
          ],
        },
      ],
    } satisfies import('../../screen-contracts.js').AgentsStatusDTO;
    expect(
      automationPicker(status, 'future-runner', {
        runner: 'future-runner',
        model: 'gpt-a',
        thoughtLevel: 'high',
      }),
    ).toMatchObject({
      selectedRunnerKind: 'codex',
      selectedModelId: 'gpt-a',
      selectedEffortId: 'high',
      modelLocked: true,
      effortLocked: true,
    });
  });

  it('loads the thread and drives lifecycle, cold/live trace, and steering actions', async () => {
    const bridge = await mount();
    await expect(bridge.loadData()).resolves.toMatchObject({
      automationTurns: true,
      runTokens: { 'turn-1': 20 },
      triggerDetail: { cronExprs: ['0 9 * * *'] },
    });

    bridge.onBack();
    bridge.onOpenCompiler();
    bridge.onOpenRun('turn-1');
    await expect(bridge.loadTurnTrace('turn-1')).resolves.toEqual([{ kind: 'ai', text: 'cold' }]);

    const watched: unknown[] = [];
    await bridge.watchTurn(
      'turn-1',
      (messages) => watched.push(messages),
      new AbortController().signal,
    );
    expect(api.streamAutomationTurn).toHaveBeenCalled();
    expect(helpers.startLiveItem).toHaveBeenCalled();
    expect(helpers.reduceItem).toHaveBeenCalled();
    expect(helpers.finishLiveItem).toHaveBeenCalled();
    expect(watched.length).toBeGreaterThan(0);

    bridge.onCopyWebhook('https://gateway.test/hook-1');
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    await expect(bridge.onRunNow()).resolves.toBe('turn-2');
    await expect(bridge.onToggleEnabled(true)).resolves.toBe(true);
    await expect(bridge.onDecideConsent('outbox', 'item-1', 'approve', true)).resolves.toBe(true);

    const conversationalMessages: unknown[] = [];
    await expect(
      bridge.onAskAboutRuns(
        'What happened?',
        {},
        (messages: unknown) => conversationalMessages.push(messages),
        new AbortController().signal,
      ),
    ).resolves.toBe('turn-3');
    expect(api.streamAutomationConversationTurn).toHaveBeenCalledWith(
      'daily/daily',
      'What happened?',
      expect.any(Function),
      expect.any(AbortSignal),
      undefined,
      {},
    );
    expect(conversationalMessages.length).toBeGreaterThan(1);

    // The run screen cannot revise or compile: those endpoints are not reachable
    // from this route at all any more (they live on the editor route).
    expect(api.compileAutomation).not.toHaveBeenCalled();

    await expect(bridge.onRotateWebhook()).resolves.toBe(true);
    await expect(bridge.onDelete()).resolves.toBe(true);
    expect(actions.navigate).toHaveBeenCalledWith({ kind: 'automations' });
  });

  it('restores the persisted conversation runner ahead of subsystem defaults', async () => {
    api.listAutomationTurns.mockResolvedValueOnce([{ ...turn, adapterKind: 'copilot' }]);
    const bridge = await mount();
    await expect(bridge.loadData()).resolves.toMatchObject({
      runnerConfig: { selectedRunnerKind: 'copilot' },
    });
  });

  it('binds the runner to the latest run that recorded an adapter, not list order', () => {
    const runs = [
      { ...turn, turnId: 'newest', seq: 3, startedAt: 300, adapterKind: 'copilot' },
      { ...turn, turnId: 'older', seq: 2, startedAt: 200, adapterKind: 'codex' },
      { ...turn, turnId: 'no-adapter', seq: 4, startedAt: 400 },
    ];
    expect(latestAdapterKind(runs)).toBe('copilot');
    // Same answer whichever order the feed arrives in.
    expect(latestAdapterKind(runs.toReversed())).toBe('copilot');
    expect(latestAdapterKind([{ ...turn }])).toBeUndefined();
  });

  it('resends an ask with every provider approved so far, and stops on a decline', async () => {
    const consentPerAttempt = ['claude-code', 'copilot', null];
    let attempt = 0;
    api.streamAutomationConversationTurn.mockImplementation(
      async (
        _automationId: string,
        _text: string,
        onEvent: (event: Record<string, unknown>) => void,
      ) => {
        const provider = consentPerAttempt[attempt++] ?? null;
        if (provider) {
          onEvent({
            type: 'consent.required',
            consentKind: 'provider-egress',
            provider,
            reason: 'ladder',
            message: `${provider} needs approval.`,
          });
          return { ended: true };
        }
        onEvent({ type: 'assistant.delta', delta: 'Done' });
        return { turnId: 'turn-3', ended: true };
      },
    );
    const bridge = await mount();
    await bridge.loadData();

    await expect(
      bridge.onAskAboutRuns('What happened?', {}, vi.fn(), new AbortController().signal),
    ).resolves.toBe('turn-3');
    expect(actions.confirm).toHaveBeenCalledTimes(2);
    expect(
      api.streamAutomationConversationTurn.mock.calls.map((call: unknown[]) => call[4]),
    ).toEqual([undefined, 'claude-code', ['claude-code', 'copilot']]);

    // A decline sends nothing further and yields no turn.
    api.streamAutomationConversationTurn.mockClear();
    attempt = 0;
    actions.confirm.mockResolvedValue(false);
    await expect(
      bridge.onAskAboutRuns('And then?', {}, vi.fn(), new AbortController().signal),
    ).resolves.toBeNull();
    expect(api.streamAutomationConversationTurn).toHaveBeenCalledTimes(1);
  });

  it('returns null when the automation disappears and guards actions before load', async () => {
    helpers.loadThread.mockResolvedValueOnce(null);
    const bridge = await mount();
    await expect(bridge.loadData()).resolves.toBeNull();
    await expect(bridge.onRunNow()).resolves.toBeNull();
    await expect(bridge.onToggleEnabled(true)).resolves.toBe(false);
    await expect(bridge.onDelete()).resolves.toBe(false);
    await expect(
      bridge.onAskAboutRuns('hello', {}, vi.fn(), new AbortController().signal),
    ).resolves.toBeNull();
  });
});
