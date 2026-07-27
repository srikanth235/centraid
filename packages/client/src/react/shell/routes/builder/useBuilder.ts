// governance: allow-repo-hygiene file-size-limit (#363) single state/reducer hook for the whole builder surface; the actions and the state they mutate need to stay next to each other to review safely
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createApp,
  createConversation,
  listAutomations,
  listConversations,
  listVersions,
  loadConversation,
  publish,
  setAutomationEnabled,
  streamTurn,
  updateAppMeta,
  uploadConversationAttachment,
  type ConversationAttachmentRef,
  type TurnStreamEvent,
} from '../../../../gateway-client.js';
import { generateAppId, shortVersionTitle } from '../../../../format.js';
import { inferAppVisual } from '../../../../app-format.js';
import { describeCron } from '../../../../cron.js';
import type {
  AgentsStatusDTO,
  AsstModelPickerDTO,
  BuilderChatSnapshot,
} from '../../../screen-contracts.js';
import { loadProviders, resolveReportedRunnerKind } from '../settingsProvidersData.js';
import { openConfirm } from '../../confirm.js';
import { providerConsentWire, withProviderConsent } from '../../../providerConsent.js';
import {
  BUILDER_SUGGESTIONS,
  type ChatView,
  type ConversationMsg,
  type DeviceKey,
  FILE_WRITING_TOOLS,
  parseVersionTime,
  relTime,
  summarizeToolArgs,
  type Tab,
  type ToolCall,
  toBuilderMsg,
  turnProgress,
} from './builderModel.js';

export interface UseBuilderInput {
  initialAppId?: string;
  appKind: 'app' | 'automation';
  appContext?: AppMetaResolvedType;
  initialPrompt?: string;
  onAddToHome?: (input: {
    prompt?: string;
    appId: string;
    name?: string;
    versionId?: string;
  }) => void;
  onMetaChange?: (input: { appId: string; name?: string; description?: string }) => void;
  showToast: (message: string) => void;
  /** The space a NEW app is created in (issue #599, Decision 14). Named by the
   *  route's target picker rather than inherited from an ambient pointer;
   *  omitted falls back to the shell's internal default scope. */
  targetScopeId?: string;
}

type SyncState = 'editing' | 'publishing' | 'idle-live' | 'idle-draft';

/** The mutable facts the status chip + primary button are derived from. */
interface StatusFacts {
  isAutomation: boolean;
  publishing: boolean;
  generating: boolean;
  automationBusy: boolean;
  automationEnabled: boolean;
  lastPublishedVersionId: string | undefined;
  appVersionCount: number;
  appLastEditedAt: number | undefined;
}

type StatusView = Pick<
  BuilderViewModel,
  'statusState' | 'statusText' | 'primaryLabel' | 'primaryKind' | 'primaryDisabled'
>;

/** Pure so the initial snapshot and every repaint share one definition. */
function deriveStatus(f: StatusFacts, now: number): StatusView {
  const statusState: SyncState = f.publishing
    ? 'publishing'
    : f.generating
      ? 'editing'
      : f.lastPublishedVersionId || (f.isAutomation && f.automationEnabled)
        ? 'idle-live'
        : 'idle-draft';

  let statusText: string;
  if (f.isAutomation) {
    statusText = f.generating
      ? 'Editing…'
      : f.automationBusy
        ? 'Working…'
        : f.automationEnabled
          ? 'Enabled'
          : 'Draft';
  } else if (f.publishing) {
    statusText = 'Publishing…';
  } else if (f.generating) {
    statusText = 'Editing…';
  } else if (f.lastPublishedVersionId) {
    const parts = ['Live'];
    if (f.appVersionCount > 0) parts.push(`v${f.appVersionCount}`);
    if (f.appLastEditedAt) parts.push(`edited ${relTime(f.appLastEditedAt, now)}`);
    statusText = parts.join(' · ');
  } else {
    statusText = 'Draft';
  }

  return {
    statusState,
    statusText,
    primaryLabel: f.isAutomation ? (f.automationEnabled ? 'Disable' : 'Enable') : 'Publish',
    primaryKind: f.isAutomation ? (f.automationEnabled ? 'disable' : 'enable') : 'publish',
    primaryDisabled: f.publishing || f.automationBusy,
  };
}

async function streamBuilderWithConsent(input: {
  appId: string;
  conversationId: string;
  text: string;
  idempotencyKey: string;
  attachments?: ConversationAttachmentRef[];
  signal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
  onDeclined: (provider: string) => void;
  workspaceKind: 'vault-data' | 'app' | 'draft';
  runnerKind?: string;
  model?: string;
  thinking?: string;
  /** Space the builder conversation is pinned to (#599) — explicit, never ambient. */
  scopeId?: string;
}): Promise<void> {
  // Every provider approved during THIS send — a consent-gated failover asks
  // twice, and resending only the newest approval loops forever (#567).
  let approvedProviders: string[] = [];
  for (;;) {
    let requiredProvider: string | undefined;
    const providerConsent = providerConsentWire(approvedProviders);
    await streamTurn(
      input.appId,
      {
        conversationId: input.conversationId,
        message: input.text,
        idempotencyKey: input.idempotencyKey,
        workspaceKind: input.workspaceKind,
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.runnerKind ? { runnerKind: input.runnerKind } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(providerConsent !== undefined ? { providerConsent } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
      (event) => {
        if (event.type === 'consent.required') requiredProvider = event.provider;
        else input.onEvent(event);
      },
      input.signal,
    );
    if (!requiredProvider) return;
    const approved = await openConfirm({
      confirmLabel: 'Allow provider',
      title: `Send to ${requiredProvider}?`,
      message: `Allow this builder conversation to be sent to ${requiredProvider}? This can include the prompt, attachments, handoff context, and vault tool results.`,
    });
    if (!approved) {
      input.onDeclined(requiredProvider);
      return;
    }
    approvedProviders = withProviderConsent(approvedProviders, requiredProvider);
  }
}

/** The part of the view model that mirrors the mutable model; refreshed by
 *  `bump()` because render may not read the refs that hold it. */
type BuilderSnapshot = StatusView &
  Pick<
    BuilderViewModel,
    | 'appId'
    | 'projName'
    | 'tab'
    | 'chatView'
    | 'previewDevice'
    | 'generating'
    | 'automationRow'
    | 'flashSections'
    | 'historyToggleActive'
    | 'chatSnapshot'
  >;

const NO_FLASH_SECTIONS: ReadonlySet<string> = new Set();

/** Per-section fingerprints of an automation manifest — a diff against the
 *  previous fetch is what flashes the changed config cards. */
const configSectionSignatures = (
  m: CentraidAutomationManifest,
): Record<'what' | 'when' | 'behavior' | 'apps', string> => ({
  what: m.prompt ?? '',
  when: JSON.stringify(m.triggers ?? []),
  behavior: JSON.stringify({
    model: m.requires.model ?? null,
    keep: m.history.keep,
    onFailure: m.onFailure ?? null,
  }),
  apps: JSON.stringify(m.apps ?? []),
});

function builderModelPicker(status: AgentsStatusDTO, requestedRunner?: string): AsstModelPickerDTO {
  const runnerKind = resolveReportedRunnerKind(status, requestedRunner, 'builder');
  const card = status.cards.find((entry) => entry.kind === runnerKind);
  const models = card?.modelConfigurable ? card.models : [];
  const defaultId = status.savedModelByKind[runnerKind] ?? '';
  const defaultModel =
    models.find((model) => model.id === defaultId) ??
    models.find((model) => model.default) ??
    models[0];
  const effortOption = card?.configOptions?.find((option) => option.category === 'thought_level');
  const defaultEffort =
    status.defaultConfigPinsByKind[runnerKind]?.thought_level ?? effortOption?.currentValue ?? '';
  return {
    runners: status.cards.map((runner) => ({
      kind: runner.kind,
      title: runner.title,
      connected: runner.connected,
      sessionReady: runner.sessionReady,
      hint: [
        runner.subtitle,
        ...(runner.breakerStates ?? []).map((state) => `${state.failureClass} ${state.state}`),
      ].join(' · '),
    })),
    selectedRunnerKind: runnerKind,
    workspaceKinds: ['draft', 'app', 'vault-data'],
    connected: card?.connected ?? false,
    models: models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.default ? { default: true } : {}),
    })),
    defaultModelName: defaultModel?.name ?? defaultModel?.id ?? 'gateway default',
    selectedModelId: status.subsystemModelByKind[runnerKind]?.builder ?? '',
    efforts: effortOption?.values ?? [],
    defaultEffortName:
      effortOption?.values.find((value) => value.value === defaultEffort)?.name ?? defaultEffort,
    selectedEffortId: status.subsystemConfigPinsByKind[runnerKind]?.builder?.thought_level ?? '',
    supportsAdditionalDirectories: card?.additionalDirectories === true,
    supportsAttachments: card?.supportsAttachments === true,
    supportsContext: card?.supportsContext === true,
  };
}

/**
 * Restore an existing conversation's durable runner binding ahead of the
 * subsystem default/current in-memory picker. A reload must never silently
 * send the next turn back through a different provider.
 */
export function builderPickerForConversation(
  status: AgentsStatusDTO,
  conversationAdapterKind?: string,
  selectedRunnerKind?: string,
): AsstModelPickerDTO {
  return builderModelPicker(status, conversationAdapterKind ?? selectedRunnerKind);
}

export interface BuilderViewModel {
  appId: string | undefined;
  projName: string;
  projColor: string;
  projIcon: IconNameType;
  isAutomation: boolean;
  isUpdateMode: boolean;
  tab: Tab;
  chatView: ChatView;
  previewDevice: DeviceKey;
  generating: boolean;
  automationRow: CentraidAutomationRow | undefined;
  flashSections: ReadonlySet<string>;
  statusText: string;
  statusState: SyncState;
  primaryLabel: string;
  primaryKind: 'publish' | 'enable' | 'disable';
  primaryDisabled: boolean;
  historyToggleActive: boolean;
  reloadNonce: number;
  // chat pane wiring (onMountHistory is supplied by the shell)
  chatSnapshot: BuilderChatSnapshot;
  registerChatUpdater: (u: (s: BuilderChatSnapshot) => void) => void;
  // actions
  sendUserPrompt: (text: string, attachments?: ConversationAttachmentRef[]) => void;
  /** Upload one file to the app's blob CAS ahead of a turn (issue #420). */
  uploadChatAttachment: (file: File) => Promise<ConversationAttachmentRef>;
  cancelTurn: () => void;
  toggleGroup: (id: string) => void;
  setChatView: (v: ChatView) => void;
  setChatWorkspaceKind: (kind: 'vault-data' | 'app' | 'draft') => void;
  setChatRunner: (runnerKind: string) => Promise<AsstModelPickerDTO>;
  setChatModel: (modelId: string) => void;
  setChatEffort: (effort: string) => void;
  setTab: (t: Tab) => void;
  setPreviewDevice: (d: DeviceKey) => void;
  commitRename: (next: string) => void;
  handlePrimary: () => void;
  onRestored: (versionId: string) => void;
}

/**
 * The React builder engine — a faithful port of the vanilla `openBuilder`
 * closure (builder.ts) minus the DOM building. It owns the SSE turn stream, the
 * conversation model, and every piece of turn/publish/automation state; the
 * shell (BuilderShell) reads this view model and renders the chrome + panes.
 *
 * State the SSE reducer mutates synchronously across events lives in refs (so a
 * burst of deltas reads/writes without React batching hazards); `bump()` forces
 * a shell repaint and `pushChat()` pushes a derived snapshot into the React chat
 * pane — together they replace the vanilla `renderChat()` funnel.
 */
export function useBuilder(input: UseBuilderInput): BuilderViewModel {
  const { appContext, initialPrompt, onAddToHome, onMetaChange, showToast } = input;
  const isUpdateMode = !!input.initialAppId;
  const isNewBuild = !isUpdateMode && !!initialPrompt;
  const isAutomation = input.appKind === 'automation';

  const projColor = appContext?.color || (window.ICON_PALETTE?.rose ?? '#5847e0');
  const projIcon: IconNameType = appContext?.iconKey || 'Sparkle';

  const initialProjName = appContext?.name || (isNewBuild ? 'New app' : 'Untitled');
  const initialTab: Tab = isAutomation ? 'config' : 'preview';

  // ── Repaint plumbing ──────────────────────────────────────────────────────
  // `view` is the published snapshot of the ref-held model below (render may
  // not read refs); `bump()` republishes it and is the repaint funnel.
  const [view, setView] = useState<BuilderSnapshot>(() => ({
    appId: input.initialAppId,
    projName: initialProjName,
    tab: initialTab,
    chatView: 'chat',
    previewDevice: 'mobile',
    generating: false,
    automationRow: undefined,
    flashSections: NO_FLASH_SECTIONS,
    historyToggleActive: false,
    chatSnapshot: {
      view: 'chat',
      messages: [],
      generating: false,
      progress: null,
      suggestions: BUILDER_SUGGESTIONS,
      composerDisabled: !input.initialAppId,
      historyNonce: 0,
      workspaceKind: 'draft',
      workspaceKinds: ['draft', 'app', 'vault-data'],
    },
    ...deriveStatus(
      {
        isAutomation,
        publishing: false,
        generating: false,
        automationBusy: false,
        automationEnabled: false,
        lastPublishedVersionId: undefined,
        appVersionCount: 0,
        appLastEditedAt: undefined,
      },
      0,
    ),
  }));
  const [reloadNonce, setReloadNonce] = useState(0);
  const chatUpdater = useRef<((s: BuilderChatSnapshot) => void) | null>(null);

  // ── State (refs = SSE-synchronous source of truth) ────────────────────────
  const appId = useRef<string | undefined>(input.initialAppId);
  const chat = useRef<ConversationMsg[]>([]);
  const projName = useRef(initialProjName);
  const tab = useRef<Tab>(initialTab);
  const chatView = useRef<ChatView>('chat');
  const previewDevice = useRef<DeviceKey>('mobile');
  const generating = useRef(false);
  const publishing = useRef(false);
  const lastPublishedVersionId = useRef<string | undefined>(undefined);
  const conversationId = useRef<string | null>(null);
  // The space this app was created into (issue #599). Every later request in
  // the builder — turns, attachment uploads — must replay it explicitly, or a
  // non-default-space app would stage blobs and run turns in the ambient space.
  const targetScope = useRef<string | undefined>(input.targetScopeId);
  const agentAbort = useRef<AbortController | null>(null);
  const currentAiMsgIndex = useRef(-1);
  const currentThinkingMsgIndex = useRef(-1);
  const pendingToolStarts = useRef(new Map<string, number>());
  const previewReloadPending = useRef(false);
  const appVersionCount = useRef(0);
  const appLastEditedAt = useRef<number | undefined>(undefined);
  const automationRow = useRef<CentraidAutomationRow | undefined>(undefined);
  const flashSections = useRef<Set<string>>(new Set());
  const automationBusy = useRef(false);
  const historyNonce = useRef(0);
  const sessionContext = useRef<{ used: number; size: number } | undefined>(undefined);
  const sessionConfig = useRef<{ model?: string; effort?: string }>({});
  const runnerConfig = useRef<AsstModelPickerDTO | undefined>(undefined);
  const providersStatus = useRef<AgentsStatusDTO | undefined>(undefined);
  const conversationRunnerKind = useRef<string | undefined>(undefined);
  const workspaceKind = useRef<'vault-data' | 'app' | 'draft'>('draft');

  // ── Snapshot funnel ───────────────────────────────────────────────────────
  const buildChatSnapshot = useCallback((): BuilderChatSnapshot => {
    return {
      view: chatView.current,
      messages: chat.current.map((m) => toBuilderMsg(m, appVersionCount.current)),
      generating: generating.current,
      progress: generating.current ? turnProgress(chat.current, currentAiMsgIndex.current) : null,
      suggestions: BUILDER_SUGGESTIONS,
      composerDisabled: generating.current || !appId.current,
      historyNonce: historyNonce.current,
      ...(sessionContext.current ? { context: sessionContext.current } : {}),
      ...sessionConfig.current,
      ...(runnerConfig.current ? { runnerConfig: runnerConfig.current } : {}),
      workspaceKind: workspaceKind.current,
      workspaceKinds: ['draft', 'app', 'vault-data'],
    };
  }, []);

  const snapshotView = useCallback(
    (): BuilderSnapshot => ({
      appId: appId.current,
      projName: projName.current,
      tab: tab.current,
      chatView: chatView.current,
      previewDevice: previewDevice.current,
      generating: generating.current,
      automationRow: automationRow.current,
      flashSections: flashSections.current,
      historyToggleActive: chatView.current === 'history',
      chatSnapshot: buildChatSnapshot(),
      ...deriveStatus(
        {
          isAutomation,
          publishing: publishing.current,
          generating: generating.current,
          automationBusy: automationBusy.current,
          automationEnabled: automationRow.current?.enabled === true,
          lastPublishedVersionId: lastPublishedVersionId.current,
          appVersionCount: appVersionCount.current,
          appLastEditedAt: appLastEditedAt.current,
        },
        Date.now(),
      ),
    }),
    [buildChatSnapshot, isAutomation],
  );
  // Held in a ref so `bump` keeps an empty dependency list — every action
  // below closes over it exactly as it did over the old reducer dispatch.
  const snapshotViewRef = useRef(snapshotView);
  useEffect(() => {
    snapshotViewRef.current = snapshotView;
  }, [snapshotView]);
  const bump = useCallback((): void => setView(snapshotViewRef.current()), []);

  const renderChat = useCallback((): void => {
    chatUpdater.current?.(buildChatSnapshot());
    bump();
  }, [buildChatSnapshot, bump]);

  useEffect(() => {
    let cancelled = false;
    void loadProviders().then((status) => {
      if (cancelled) return;
      providersStatus.current = status;
      runnerConfig.current = builderPickerForConversation(
        status,
        conversationRunnerKind.current,
        runnerConfig.current?.selectedRunnerKind,
      );
      renderChat();
    });
    return () => {
      cancelled = true;
    };
  }, [renderChat]);

  const pushMessage = useCallback(
    (m: ConversationMsg): number => {
      chat.current = chat.current.concat([m]);
      renderChat();
      return chat.current.length - 1;
    },
    [renderChat],
  );

  const updateMessage = useCallback(
    (idx: number, patch: Partial<ConversationMsg>): void => {
      const at = chat.current[idx];
      if (!at) return;
      chat.current = chat.current.map((m, i) =>
        i === idx ? ({ ...m, ...patch } as ConversationMsg) : m,
      );
      renderChat();
    },
    [renderChat],
  );

  const bumpPreview = useCallback((): void => setReloadNonce((n) => n + 1), []);

  // ── Turn engine ───────────────────────────────────────────────────────────
  const closeThinking = useCallback((): void => {
    if (currentThinkingMsgIndex.current < 0) return;
    const cur = chat.current[currentThinkingMsgIndex.current];
    if (cur && cur.kind === 'thinking')
      updateMessage(currentThinkingMsgIndex.current, { streaming: false });
    currentThinkingMsgIndex.current = -1;
  }, [updateMessage]);

  const closeAi = useCallback((): void => {
    if (currentAiMsgIndex.current < 0) return;
    const cur = chat.current[currentAiMsgIndex.current];
    if (cur && cur.kind === 'ai') updateMessage(currentAiMsgIndex.current, { streaming: false });
    currentAiMsgIndex.current = -1;
  }, [updateMessage]);

  // ── Automation ────────────────────────────────────────────────────────────
  const refreshAutomationRow = useCallback(async (): Promise<void> => {
    if (!appId.current) return;
    const before = automationRow.current
      ? configSectionSignatures(automationRow.current.manifest)
      : undefined;
    try {
      const all = await listAutomations();
      const row = all.find((r) => r.ownerApp === appId.current);
      if (row) automationRow.current = row;
    } catch {
      /* keep last good */
    }
    if (automationRow.current) {
      projName.current = automationRow.current.manifest.name || automationRow.current.id;
      if (before) {
        const after = configSectionSignatures(automationRow.current.manifest);
        flashSections.current = new Set();
        for (const k of ['what', 'when', 'behavior', 'apps'] as const) {
          if (before[k] !== after[k]) flashSections.current.add(k);
        }
      }
    }
    bump();
  }, [bump]);

  const finishAgentTurn = useCallback((): void => {
    generating.current = false;
    closeAi();
    closeThinking();
    renderChat();
    if (isAutomation) {
      if (previewReloadPending.current) void refreshAutomationRow();
    } else if (previewReloadPending.current && tab.current === 'preview') {
      bumpPreview();
    }
    previewReloadPending.current = false;
  }, [closeAi, closeThinking, renderChat, isAutomation, bumpPreview, refreshAutomationRow]);

  const announceMintedWebhooks = useCallback(
    (minted: CentraidMintedWebhook[]): void => {
      for (const w of minted) {
        pushMessage({
          kind: 'ai',
          text:
            `Webhook provisioned for “${w.automationId}”.\n\n` +
            `Endpoint (POST): ${w.url}\n` +
            `Secret (shown once — save it now): ${w.secret}\n\n` +
            'Authenticate each request with the header ' +
            '`Authorization: Bearer <secret>`. The secret is not stored — ' +
            'only a hash is kept in automation.json.',
        });
      }
    },
    [pushMessage],
  );

  const handleStreamEvent = useCallback(
    (event: TurnStreamEvent): void => {
      switch (event.type) {
        case 'assistant.start':
          generating.current = true;
          renderChat();
          return;
        case 'assistant.delta':
          closeThinking();
          if (currentAiMsgIndex.current < 0) {
            currentAiMsgIndex.current = pushMessage({
              kind: 'ai',
              text: event.delta,
              streaming: true,
            });
          } else {
            const cur = chat.current[currentAiMsgIndex.current];
            if (cur && cur.kind === 'ai') {
              updateMessage(currentAiMsgIndex.current, {
                text: cur.text + event.delta,
                streaming: true,
              });
            }
          }
          return;
        case 'reasoning.delta':
          if (currentThinkingMsgIndex.current < 0) {
            currentThinkingMsgIndex.current = pushMessage({
              kind: 'thinking',
              text: event.delta,
              streaming: true,
            });
          } else {
            const cur = chat.current[currentThinkingMsgIndex.current];
            if (cur && cur.kind === 'thinking') {
              updateMessage(currentThinkingMsgIndex.current, {
                text: cur.text + event.delta,
                streaming: true,
              });
            }
          }
          return;
        case 'tool.start': {
          closeThinking();
          closeAi();
          const newCall: ToolCall = {
            id: event.toolCallId,
            tool: event.toolName,
            summary: summarizeToolArgs(event.toolName, event.args),
            state: 'running',
          };
          const lastIdx = chat.current.length - 1;
          const last = chat.current[lastIdx];
          if (last && last.kind === 'toolGroup') {
            const updated: ConversationMsg = { ...last, calls: [...last.calls, newCall] };
            chat.current = chat.current.map((m, i) => (i === lastIdx ? updated : m));
            renderChat();
            pendingToolStarts.current.set(event.toolCallId, lastIdx);
          } else {
            const idx = pushMessage({
              kind: 'toolGroup',
              id: event.toolCallId,
              calls: [newCall],
              open: true,
            });
            pendingToolStarts.current.set(event.toolCallId, idx);
          }
          return;
        }
        case 'tool.result': {
          const groupIdx = pendingToolStarts.current.get(event.toolCallId);
          pendingToolStarts.current.delete(event.toolCallId);
          if (groupIdx !== undefined) {
            const grp = chat.current[groupIdx];
            if (grp && grp.kind === 'toolGroup') {
              const calls = grp.calls.map((c) =>
                c.id === event.toolCallId
                  ? { ...c, state: event.ok ? ('ok' as const) : ('error' as const) }
                  : c,
              );
              chat.current = chat.current.map((m, i) => (i === groupIdx ? { ...grp, calls } : m));
              renderChat();
            }
          }
          if (event.ok && FILE_WRITING_TOOLS.has(event.toolName)) {
            previewReloadPending.current = true;
            appLastEditedAt.current = Date.now();
          }
          return;
        }
        case 'webhooks':
          announceMintedWebhooks(event.minted);
          return;
        case 'context':
          if (event.used !== undefined && event.size !== undefined) {
            sessionContext.current = { used: event.used, size: event.size };
            renderChat();
          }
          return;
        case 'usage':
          sessionConfig.current = {
            ...(event.model ? { model: event.model } : {}),
            ...(event.effort ? { effort: event.effort } : {}),
          };
          renderChat();
          return;
        case 'final':
        case 'aborted':
          finishAgentTurn();
          return;
        case 'error':
          generating.current = false;
          closeAi();
          closeThinking();
          pushMessage({ kind: 'status', text: `Agent error: ${event.message}` });
          return;
        case 'phase':
        case 'consent.required':
        case 'notice':
          break;
      }
    },
    [
      announceMintedWebhooks,
      closeAi,
      closeThinking,
      finishAgentTurn,
      pushMessage,
      renderChat,
      updateMessage,
    ],
  );

  const ensureConversation = useCallback(
    async (id: string, sessionMode: 'fresh' | 'continue'): Promise<string> => {
      if (conversationId.current) return conversationId.current;
      if (sessionMode === 'continue') {
        const sessions = await listConversations(id).catch(() => []);
        if (sessions[0]) {
          conversationId.current = sessions[0].id;
          const transcript = await loadConversation(id, sessions[0].id).catch(() => undefined);
          if (transcript?.adapterKind) {
            conversationRunnerKind.current = transcript.adapterKind;
            if (providersStatus.current) {
              runnerConfig.current = builderPickerForConversation(
                providersStatus.current,
                transcript.adapterKind,
              );
              renderChat();
            }
          }
          if (transcript?.workspace?.primaryKind) {
            workspaceKind.current = transcript.workspace.primaryKind;
          }
          return conversationId.current;
        }
      }
      conversationId.current = (
        await createConversation(id, projName.current, targetScope.current)
      ).id;
      return conversationId.current;
    },
    [renderChat],
  );

  // Upload one file to the builder app's blob CAS ahead of a turn — the same
  // path the assistant composer uses (issue #420, wiring the builder's attach
  // button). Requires the app to exist (its CAS is per-app).
  const uploadChatAttachment = useCallback(
    async (file: File): Promise<ConversationAttachmentRef> => {
      if (!appId.current) throw new Error('Save the app before attaching files.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      return uploadConversationAttachment(
        appId.current,
        bytes,
        file.type || 'application/octet-stream',
        file.name,
        targetScope.current,
      );
    },
    [],
  );

  const sendUserPrompt = useCallback(
    (text: string, attachments?: ConversationAttachmentRef[]): void => {
      void (async () => {
        if (!appId.current) return;
        pushMessage({ kind: 'user', text });
        generating.current = true;
        currentAiMsgIndex.current = -1;
        currentThinkingMsgIndex.current = -1;
        renderChat();
        try {
          const sessionId = await ensureConversation(appId.current, 'continue');
          agentAbort.current = new AbortController();
          await streamBuilderWithConsent({
            appId: appId.current,
            conversationId: sessionId,
            text,
            // Reuse across consent-gated retries: the first request is not
            // recorded, while a transport retry still replays exactly once.
            idempotencyKey: crypto.randomUUID(),
            workspaceKind: workspaceKind.current,
            // Explicit, never ambient: the turn lands in the space the
            // conversation was created in (issue #599).
            ...(targetScope.current ? { scopeId: targetScope.current } : {}),
            ...(runnerConfig.current?.selectedRunnerKind
              ? { runnerKind: runnerConfig.current.selectedRunnerKind }
              : {}),
            ...(runnerConfig.current?.selectedModelId
              ? { model: runnerConfig.current.selectedModelId }
              : {}),
            ...(runnerConfig.current?.selectedEffortId
              ? { thinking: runnerConfig.current.selectedEffortId }
              : {}),
            ...(attachments?.length ? { attachments } : {}),
            signal: agentAbort.current.signal,
            onEvent: handleStreamEvent,
            onDeclined: (provider) =>
              pushMessage({
                kind: 'status',
                text: `Nothing was sent to ${provider}.`,
              }),
          });
          if (generating.current) finishAgentTurn();
        } catch (err) {
          if (agentAbort.current?.signal.aborted) {
            finishAgentTurn();
            return;
          }
          generating.current = false;
          pushMessage({ kind: 'status', text: `Agent error: ${String(err)}` });
        }
      })();
    },
    [ensureConversation, finishAgentTurn, handleStreamEvent, pushMessage, renderChat],
  );

  const handleToggleEnabled = useCallback(async (): Promise<void> => {
    const row = automationRow.current;
    if (!appId.current || automationBusy.current || !row) return;
    const next = !(row.enabled === true);
    automationBusy.current = true;
    bump();
    try {
      await setAutomationEnabled({ automationId: row.ref, enabled: next });
      const t0 = row.manifest.triggers[0];
      const sched = t0 ? (t0.kind === 'cron' ? describeCron(t0.expr) : 'Webhook') : 'manual';
      showToast(next ? `Enabled · ${sched}` : 'Disabled — schedule stopped');
      await refreshAutomationRow();
    } catch (err) {
      showToast(`Could not ${next ? 'enable' : 'disable'}: ${String(err)}`);
    } finally {
      automationBusy.current = false;
      bump();
    }
  }, [bump, refreshAutomationRow, showToast]);

  // ── Publish ───────────────────────────────────────────────────────────────
  const handlePublish = useCallback(async (): Promise<void> => {
    if (!appId.current) {
      showToast('No app to publish');
      return;
    }
    if (publishing.current) return;
    publishing.current = true;
    bump();
    const statusIdx = pushMessage({
      kind: 'status',
      text: 'Building & publishing…',
      spinning: true,
    });
    try {
      const result = await publish({ id: appId.current });
      lastPublishedVersionId.current = result.versionId;
      appVersionCount.current += 1;
      appLastEditedAt.current = Date.now();
      const migCount = result.migrationsApplied?.length ?? 0;
      const migText =
        migCount > 0 ? ` · ${migCount} migration${migCount === 1 ? '' : 's'} applied` : '';
      updateMessage(statusIdx, {
        kind: 'status',
        text: `Published ${shortVersionTitle(result)} (${result.files} files, ${(result.bytes / 1024).toFixed(1)} KB)${migText}`,
      });
      showToast(`Published ${shortVersionTitle(result)}${migText}`);
      if (tab.current === 'preview') bumpPreview();
      if (chatView.current === 'history') historyNonce.current += 1;
      renderChat();
      onAddToHome?.({
        prompt: initialPrompt,
        appId: appId.current,
        name: projName.current,
        versionId: result.versionId,
      });
    } catch (err) {
      const msg = String(err);
      if (/no_changes|no staged changes/iu.test(msg)) {
        updateMessage(statusIdx, { kind: 'status', text: 'Already up to date — added to Home.' });
        showToast('Already published — added to Home.');
        onAddToHome?.({ prompt: initialPrompt, appId: appId.current, name: projName.current });
      } else if (/HTTP 401|HTTP 403|gateway rejected|auth_required/iu.test(msg)) {
        updateMessage(statusIdx, {
          kind: 'status',
          text: 'Gateway needs a token to accept uploads.',
        });
        showToast('Gateway requires a token. Configure it in Settings.');
      } else if (
        /gateway_unreachable|Could not reach gateway|fetch failed|ECONNREFUSED/iu.test(msg)
      ) {
        updateMessage(statusIdx, { kind: 'status', text: 'Gateway not reachable. Is it running?' });
        showToast('Gateway not reachable. Check the URL in Settings.');
      } else if (/HTTP 422/iu.test(msg)) {
        const file = msg.match(/"file"\s*:\s*"(?<file>[^"]+)"/u)?.groups?.file;
        const sqlError = msg.match(/"sqlError"\s*:\s*"(?<sqlError>[^"]+)"/u)?.groups?.sqlError;
        const detail = file
          ? sqlError
            ? `Migration ${file} failed: ${sqlError}`
            : `Migration ${file} failed`
          : `Migration failed: ${msg}`;
        updateMessage(statusIdx, { kind: 'status', text: detail });
        showToast(file ? `Migration ${file} failed` : 'Migration failed');
      } else {
        updateMessage(statusIdx, { kind: 'status', text: `Publish failed: ${msg}` });
      }
    } finally {
      publishing.current = false;
      bump();
    }
  }, [
    bump,
    bumpPreview,
    initialPrompt,
    onAddToHome,
    pushMessage,
    renderChat,
    showToast,
    updateMessage,
  ]);

  // ── Bootstrap (once) ──────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      if (isAutomation && appId.current) {
        chat.current = [];
        renderChat();
        await refreshAutomationRow();
        chat.current = chat.current.concat([
          {
            kind: 'ai',
            text:
              'Let’s build your automation. Describe what it should do and when it should run — for ' +
              'example, “every weekday morning, summarize yesterday’s new GitHub issues.”',
          },
        ]);
        renderChat();
        if (initialPrompt) sendUserPrompt(initialPrompt);
        return;
      }
      if (isUpdateMode && appId.current) {
        chat.current = [];
        renderChat();
        try {
          const versions = await listVersions({ id: appId.current });
          if (versions.activeVersion) {
            lastPublishedVersionId.current = versions.activeVersion;
            appVersionCount.current = versions.versions.length;
            appLastEditedAt.current = parseVersionTime(versions.activeVersion);
            bump();
          }
        } catch {
          /* never published — local preview takes over */
        }
        chat.current = chat.current.concat([
          {
            kind: 'ai',
            text: `Loaded "${projName.current}". Pick a direction below or describe the next change.`,
          },
        ]);
        renderChat();
        return;
      }
      if (!isNewBuild || !initialPrompt) {
        chat.current = [
          { kind: 'status', text: 'No prompt provided. Open the builder from "New app" on home.' },
        ];
        renderChat();
        return;
      }
      // Fresh build.
      const id = generateAppId(initialPrompt);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      pushMessage({ kind: 'divider', text: `Today · ${hhmm}` });
      pushMessage({ kind: 'status', text: 'Setting up app…', spinning: true });
      try {
        const visual = inferAppVisual(initialPrompt);
        await createApp({
          id,
          name: projName.current,
          version: '0.1.0',
          iconKey: visual.iconKey,
          colorKey: visual.colorKey,
          ...(input.targetScopeId ? { scopeId: input.targetScopeId } : {}),
        });
        appId.current = id;
        bump();
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not create app: ${String(err)}` });
        return;
      }
      try {
        conversationId.current = (
          await createConversation(id, projName.current, input.targetScopeId)
        ).id;
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not start chat: ${String(err)}` });
        return;
      }
      sendUserPrompt(initialPrompt);
    })();
    return () => {
      agentAbort.current?.abort();
    };
  }, []);

  // ── View actions ──────────────────────────────────────────────────────────
  const toggleGroup = useCallback(
    (id: string): void => {
      chat.current = chat.current.map((x) =>
        x.kind === 'toolGroup' && x.id === id ? { ...x, open: !x.open } : x,
      );
      renderChat();
    },
    [renderChat],
  );

  const setChatViewCb = useCallback(
    (v: ChatView): void => {
      if (v === 'history' && chatView.current === 'history') historyNonce.current += 1;
      chatView.current = v;
      renderChat();
    },
    [renderChat],
  );

  const setTabCb = useCallback(
    (t: Tab): void => {
      tab.current = t;
      bump();
    },
    [bump],
  );

  const setPreviewDeviceCb = useCallback(
    (d: DeviceKey): void => {
      if (previewDevice.current === d) return;
      previewDevice.current = d;
      bump();
    },
    [bump],
  );

  const setChatWorkspaceKind = useCallback(
    (kind: 'vault-data' | 'app' | 'draft'): void => {
      workspaceKind.current = kind;
      renderChat();
    },
    [renderChat],
  );

  const setChatRunner = useCallback(
    async (runnerKind: string): Promise<AsstModelPickerDTO> => {
      const previous = runnerConfig.current?.selectedRunnerKind;
      const status = await loadProviders({ refresh: true });
      const target = status.cards.find((card) => card.kind === runnerKind);
      if (!target?.sessionReady) {
        showToast(target?.subtitle ?? `${runnerKind} did not complete its session preflight.`);
        const unchanged = builderModelPicker(status, previous);
        runnerConfig.current = unchanged;
        renderChat();
        return unchanged;
      }
      const next = builderModelPicker(status, runnerKind);
      providersStatus.current = status;
      conversationRunnerKind.current = runnerKind;
      runnerConfig.current = next;
      sessionContext.current = undefined;
      sessionConfig.current = {};
      renderChat();
      return next;
    },
    [renderChat, showToast],
  );

  const setChatModel = useCallback(
    (modelId: string): void => {
      if (!runnerConfig.current) return;
      runnerConfig.current = { ...runnerConfig.current, selectedModelId: modelId };
      renderChat();
    },
    [renderChat],
  );

  const setChatEffort = useCallback(
    (effort: string): void => {
      if (!runnerConfig.current) return;
      runnerConfig.current = { ...runnerConfig.current, selectedEffortId: effort };
      renderChat();
    },
    [renderChat],
  );

  const commitRename = useCallback(
    (raw: string): void => {
      const next = raw.trim();
      if (!next || next === projName.current || isAutomation) return;
      const previous = projName.current;
      projName.current = next;
      bump();
      if (appId.current) {
        void updateAppMeta({ id: appId.current, name: next }).catch((err: unknown) => {
          projName.current = previous;
          bump();
          showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        onMetaChange?.({ appId: appId.current, name: next });
      }
    },
    [bump, isAutomation, onMetaChange, showToast],
  );

  const onRestored = useCallback(
    (versionId: string): void => {
      lastPublishedVersionId.current = versionId;
      if (tab.current === 'preview') bumpPreview();
      bump();
    },
    [bump, bumpPreview],
  );

  const registerChatUpdater = useCallback(
    (u: (s: BuilderChatSnapshot) => void): void => {
      chatUpdater.current = u;
      u(buildChatSnapshot());
    },
    [buildChatSnapshot],
  );

  return {
    ...view,
    projColor: projColor as string,
    projIcon,
    isAutomation,
    isUpdateMode,
    reloadNonce,
    registerChatUpdater,
    sendUserPrompt,
    uploadChatAttachment,
    cancelTurn: () => agentAbort.current?.abort(),
    toggleGroup,
    setChatView: setChatViewCb,
    setChatWorkspaceKind,
    setChatRunner,
    setChatModel,
    setChatEffort,
    setTab: setTabCb,
    setPreviewDevice: setPreviewDeviceCb,
    commitRename,
    handlePrimary: () => void (isAutomation ? handleToggleEnabled() : handlePublish()),
    onRestored,
  };
}
