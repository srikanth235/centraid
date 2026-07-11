import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  createApp,
  createConversation,
  listAutomations,
  listConversations,
  listVersions,
  publish,
  setAutomationEnabled,
  streamTurn,
  updateAppMeta,
  type TurnStreamEvent,
} from '../../../../gateway-client.js';
import { generateAppId, shortVersionTitle } from '../../../../format.js';
import { inferAppVisual } from '../../../../app-format.js';
import { describeCron } from '../../../../cron.js';
import type { BuilderChatSnapshot } from '../../../screen-contracts.js';
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
  onAddToHome?: (input: { prompt?: string; appId: string; name?: string; versionId?: string }) => void;
  onMetaChange?: (input: { appId: string; name?: string; description?: string }) => void;
  showToast: (message: string) => void;
}

type SyncState = 'editing' | 'publishing' | 'idle-live' | 'idle-draft';

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
  sendUserPrompt: (text: string) => void;
  cancelTurn: () => void;
  toggleGroup: (id: string) => void;
  setChatView: (v: ChatView) => void;
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

  // ── Repaint plumbing ──────────────────────────────────────────────────────
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const chatUpdater = useRef<((s: BuilderChatSnapshot) => void) | null>(null);

  // ── State (refs = SSE-synchronous source of truth) ────────────────────────
  const appId = useRef<string | undefined>(input.initialAppId);
  const chat = useRef<ConversationMsg[]>([]);
  const projName = useRef(appContext?.name || (isNewBuild ? 'New app' : 'Untitled'));
  const tab = useRef<Tab>(isAutomation ? 'config' : 'preview');
  const chatView = useRef<ChatView>('chat');
  const previewDevice = useRef<DeviceKey>('mobile');
  const generating = useRef(false);
  const publishing = useRef(false);
  const lastPublishedVersionId = useRef<string | undefined>(undefined);
  const conversationId = useRef<string | null>(null);
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
    };
  }, []);

  const renderChat = useCallback((): void => {
    chatUpdater.current?.(buildChatSnapshot());
    bump();
  }, [buildChatSnapshot]);

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
      chat.current = chat.current.map((m, i) => (i === idx ? ({ ...m, ...patch } as ConversationMsg) : m));
      renderChat();
    },
    [renderChat],
  );

  const bumpPreview = useCallback((): void => setReloadNonce((n) => n + 1), []);

  // ── Turn engine ───────────────────────────────────────────────────────────
  const closeThinking = useCallback((): void => {
    if (currentThinkingMsgIndex.current < 0) return;
    const cur = chat.current[currentThinkingMsgIndex.current];
    if (cur && cur.kind === 'thinking') updateMessage(currentThinkingMsgIndex.current, { streaming: false });
    currentThinkingMsgIndex.current = -1;
  }, [updateMessage]);

  const closeAi = useCallback((): void => {
    if (currentAiMsgIndex.current < 0) return;
    const cur = chat.current[currentAiMsgIndex.current];
    if (cur && cur.kind === 'ai') updateMessage(currentAiMsgIndex.current, { streaming: false });
    currentAiMsgIndex.current = -1;
  }, [updateMessage]);

  const refreshAutomationRow = useRef<() => Promise<void>>(async () => {});

  const finishAgentTurn = useCallback((): void => {
    generating.current = false;
    closeAi();
    closeThinking();
    renderChat();
    if (isAutomation) {
      if (previewReloadPending.current) void refreshAutomationRow.current();
    } else if (previewReloadPending.current && tab.current === 'preview') {
      bumpPreview();
    }
    previewReloadPending.current = false;
  }, [closeAi, closeThinking, renderChat, isAutomation, bumpPreview]);

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
            currentAiMsgIndex.current = pushMessage({ kind: 'ai', text: event.delta, streaming: true });
          } else {
            const cur = chat.current[currentAiMsgIndex.current];
            if (cur && cur.kind === 'ai') {
              updateMessage(currentAiMsgIndex.current, { text: cur.text + event.delta, streaming: true });
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
            const idx = pushMessage({ kind: 'toolGroup', id: event.toolCallId, calls: [newCall], open: true });
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
        case 'usage':
          break;
      }
    },
    [announceMintedWebhooks, closeAi, closeThinking, finishAgentTurn, pushMessage, renderChat, updateMessage],
  );

  const ensureConversation = useCallback(
    async (id: string, sessionMode: 'fresh' | 'continue'): Promise<string> => {
      if (conversationId.current) return conversationId.current;
      if (sessionMode === 'continue') {
        const sessions = await listConversations(id).catch(() => []);
        if (sessions[0]) {
          conversationId.current = sessions[0].id;
          return conversationId.current;
        }
      }
      conversationId.current = (await createConversation(id, projName.current)).id;
      return conversationId.current;
    },
    [],
  );

  const sendUserPrompt = useCallback(
    (text: string): void => {
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
          await streamTurn(
            appId.current,
            { conversationId: sessionId, message: text },
            handleStreamEvent,
            agentAbort.current.signal,
          );
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

  // ── Automation ────────────────────────────────────────────────────────────
  const configSectionSignatures = (
    m: CentraidAutomationManifest,
  ): Record<'what' | 'when' | 'behavior' | 'apps', string> => ({
    what: m.prompt ?? '',
    when: JSON.stringify(m.triggers ?? []),
    behavior: JSON.stringify({
      model: m.requires.model ?? null,
      keep: m.history.keep,
      onFailure: m.onFailure ?? null,
      tools: m.requires.tools ?? [],
    }),
    apps: JSON.stringify(m.apps ?? []),
  });

  refreshAutomationRow.current = useCallback(async (): Promise<void> => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleEnabled = useCallback(async (): Promise<void> => {
    const row = automationRow.current;
    if (!appId.current || automationBusy.current || !row) return;
    const next = !(row.enabled === true);
    automationBusy.current = true;
    bump();
    try {
      await setAutomationEnabled({ automationId: row.ref, enabled: next });
      const t0 = row.manifest.triggers[0];
      const sched = !t0 ? 'manual' : t0.kind === 'cron' ? describeCron(t0.expr) : 'Webhook';
      showToast(next ? `Enabled · ${sched}` : 'Disabled — schedule stopped');
      await refreshAutomationRow.current();
    } catch (err) {
      showToast(`Could not ${next ? 'enable' : 'disable'}: ${String(err)}`);
    } finally {
      automationBusy.current = false;
      bump();
    }
  }, [showToast]);

  // ── Publish ───────────────────────────────────────────────────────────────
  const handlePublish = useCallback(async (): Promise<void> => {
    if (!appId.current) {
      showToast('No app to publish');
      return;
    }
    if (publishing.current) return;
    publishing.current = true;
    bump();
    const statusIdx = pushMessage({ kind: 'status', text: 'Building & publishing…', spinning: true });
    try {
      const result = await publish({ id: appId.current });
      lastPublishedVersionId.current = result.versionId;
      appVersionCount.current += 1;
      appLastEditedAt.current = Date.now();
      const migCount = result.migrationsApplied?.length ?? 0;
      const migText = migCount > 0 ? ` · ${migCount} migration${migCount === 1 ? '' : 's'} applied` : '';
      updateMessage(statusIdx, {
        kind: 'status',
        text: `Published ${shortVersionTitle(result)} (${result.files} files, ${(result.bytes / 1024).toFixed(1)} KB)${migText}`,
      });
      showToast(`Published ${shortVersionTitle(result)}${migText}`);
      if (tab.current === 'preview') bumpPreview();
      if (chatView.current === 'history') historyNonce.current += 1;
      renderChat();
      onAddToHome?.({ prompt: initialPrompt, appId: appId.current, name: projName.current, versionId: result.versionId });
    } catch (err) {
      const msg = String(err);
      if (/no_changes|no staged changes/i.test(msg)) {
        updateMessage(statusIdx, { kind: 'status', text: 'Already up to date — added to Home.' });
        showToast('Already published — added to Home.');
        onAddToHome?.({ prompt: initialPrompt, appId: appId.current, name: projName.current });
      } else if (/HTTP 401|HTTP 403|gateway rejected|auth_required/i.test(msg)) {
        updateMessage(statusIdx, { kind: 'status', text: 'Gateway needs a token to accept uploads.' });
        showToast('Gateway requires a token. Configure it in Settings.');
      } else if (/gateway_unreachable|Could not reach gateway|fetch failed|ECONNREFUSED/i.test(msg)) {
        updateMessage(statusIdx, { kind: 'status', text: 'Gateway not reachable. Is it running?' });
        showToast('Gateway not reachable. Check the URL in Settings.');
      } else if (/HTTP 422/i.test(msg)) {
        const file = msg.match(/"file"\s*:\s*"([^"]+)"/)?.[1];
        const sqlError = msg.match(/"sqlError"\s*:\s*"([^"]+)"/)?.[1];
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
  }, [bumpPreview, initialPrompt, onAddToHome, pushMessage, renderChat, showToast, updateMessage]);

  // ── Bootstrap (once) ──────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      if (isAutomation && appId.current) {
        chat.current = [];
        renderChat();
        await refreshAutomationRow.current();
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
          { kind: 'ai', text: `Loaded "${projName.current}". Pick a direction below or describe the next change.` },
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
        await createApp({ id, name: projName.current, version: '0.1.0', iconKey: visual.iconKey, colorKey: visual.colorKey });
        appId.current = id;
        bump();
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not create app: ${String(err)}` });
        return;
      }
      try {
        conversationId.current = (await createConversation(id, projName.current)).id;
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not start chat: ${String(err)}` });
        return;
      }
      sendUserPrompt(initialPrompt);
    })();
    return () => {
      agentAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const setTabCb = useCallback((t: Tab): void => {
    tab.current = t;
    bump();
  }, []);

  const setPreviewDeviceCb = useCallback((d: DeviceKey): void => {
    if (previewDevice.current === d) return;
    previewDevice.current = d;
    bump();
  }, []);

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
    [isAutomation, onMetaChange, showToast],
  );

  const onRestored = useCallback(
    (versionId: string): void => {
      lastPublishedVersionId.current = versionId;
      if (tab.current === 'preview') bumpPreview();
      bump();
    },
    [bumpPreview],
  );

  const registerChatUpdater = useCallback(
    (u: (s: BuilderChatSnapshot) => void): void => {
      chatUpdater.current = u;
      u(buildChatSnapshot());
    },
    [buildChatSnapshot],
  );

  // ── Derived status ────────────────────────────────────────────────────────
  const statusState: SyncState = publishing.current
    ? 'publishing'
    : generating.current
      ? 'editing'
      : lastPublishedVersionId.current || (isAutomation && automationRow.current?.enabled)
        ? 'idle-live'
        : 'idle-draft';

  let statusText: string;
  if (isAutomation) {
    statusText = generating.current
      ? 'Editing…'
      : automationBusy.current
        ? 'Working…'
        : automationRow.current?.enabled
          ? 'Enabled'
          : 'Draft';
  } else if (publishing.current) {
    statusText = 'Publishing…';
  } else if (generating.current) {
    statusText = 'Editing…';
  } else if (lastPublishedVersionId.current) {
    const parts = ['Live'];
    if (appVersionCount.current > 0) parts.push(`v${appVersionCount.current}`);
    if (appLastEditedAt.current) parts.push(`edited ${relTime(appLastEditedAt.current, Date.now())}`);
    statusText = parts.join(' · ');
  } else {
    statusText = 'Draft';
  }

  const enabled = automationRow.current?.enabled === true;
  const primaryLabel = isAutomation ? (enabled ? 'Disable' : 'Enable') : 'Publish';
  const primaryKind: 'publish' | 'enable' | 'disable' = isAutomation
    ? enabled
      ? 'disable'
      : 'enable'
    : 'publish';

  return {
    appId: appId.current,
    projName: projName.current,
    projColor: projColor as string,
    projIcon,
    isAutomation,
    isUpdateMode,
    tab: tab.current,
    chatView: chatView.current,
    previewDevice: previewDevice.current,
    generating: generating.current,
    automationRow: automationRow.current,
    flashSections: flashSections.current,
    statusText,
    statusState,
    primaryLabel,
    primaryKind,
    primaryDisabled: publishing.current || automationBusy.current,
    historyToggleActive: chatView.current === 'history',
    reloadNonce,
    chatSnapshot: buildChatSnapshot(),
    registerChatUpdater,
    sendUserPrompt,
    cancelTurn: () => agentAbort.current?.abort(),
    toggleGroup,
    setChatView: setChatViewCb,
    setTab: setTabCb,
    setPreviewDevice: setPreviewDeviceCb,
    commitRename,
    handlePrimary: () => void (isAutomation ? handleToggleEnabled() : handlePublish()),
    onRestored,
  };
}
