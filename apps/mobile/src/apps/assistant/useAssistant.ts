import { useCallback, useEffect, useRef, useState } from 'react';

import {
  loadAssistantConfig,
  openAssistantConversation,
  pickAndUploadAssistantAttachment,
  saveAssistantSelection,
  streamAssistantTurn,
  type AssistantAttachment,
  type AssistantConfig,
} from '../../lib/assistant';

export interface Bubble {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  error?: boolean;
}

export type AssistantPhase = 'connecting' | 'offline' | 'ready';

export interface PendingProviderConsent {
  provider: string;
  message: string;
}

export interface AssistantController {
  phase: AssistantPhase;
  bubbles: Bubble[];
  sending: boolean;
  loadError: string | undefined;
  selectionError: string | undefined;
  config: AssistantConfig | undefined;
  context: { used?: number; size?: number };
  pendingConsent: PendingProviderConsent | undefined;
  attachments: AssistantAttachment[];
  attaching: boolean;
  send: (text: string) => void;
  stop: () => void;
  approveConsent: () => void;
  declineConsent: () => void;
  attach: () => void;
  removeAttachment: (hash: string) => void;
  selectRunner: (runnerKind: string) => void;
  selectModel: (model: string) => void;
  selectEffort: (effort: string) => void;
}

interface PendingTurn {
  text: string;
  assistantKey: string;
  idempotencyKey: string;
  providerConsent?: string;
  attachments: AssistantAttachment[];
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `b${counter}`;
}

function withRunner(config: AssistantConfig, runnerKind: string): AssistantConfig {
  const runner = config.runners.find((entry) => entry.kind === runnerKind);
  if (!runner) return config;
  return {
    ...config,
    runnerKind,
    models: runner.models,
    selectedModel: runner.selectedModel,
    efforts: runner.efforts,
    selectedEffort: runner.selectedEffort,
    supportsAttachments: runner.supportsAttachments,
    supportsContext: runner.supportsContext,
  };
}

/** Apply a freshly probed runner choice without mutating the prior selection on failure. */
export function preflightedRunnerSelection(
  current: AssistantConfig,
  fresh: AssistantConfig,
  runnerKind: string,
): { config: AssistantConfig; error?: string } {
  const target = fresh.runners.find((runner) => runner.kind === runnerKind);
  if (!target?.sessionReady) {
    return {
      config: current,
      error: target?.hint ?? `${runnerKind} did not complete its session preflight.`,
    };
  }
  return { config: withRunner(fresh, runnerKind) };
}

/** Convert a fallible prefs write into an explicit UI result. */
export async function persistAssistantSelection(
  runnerKind: string,
  kind: 'model' | 'effort',
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await saveAssistantSelection(runnerKind, kind, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function useAssistant(): AssistantController {
  const [phase, setPhase] = useState<AssistantPhase>('connecting');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  const [config, setConfig] = useState<AssistantConfig>();
  const [context, setContext] = useState<{ used?: number; size?: number }>({});
  const [pendingConsent, setPendingConsent] = useState<PendingProviderConsent>();
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const mounted = useRef(true);
  const conversationId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const pendingTurn = useRef<PendingTurn | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    void Promise.all([openAssistantConversation(), loadAssistantConfig()])
      .then(([conversation, loadedConfig]) => {
        if (!mounted.current) return;
        conversationId.current = conversation.conversationId;
        setBubbles(conversation.bubbles);
        setConfig(
          conversation.runnerKind
            ? withRunner(loadedConfig, conversation.runnerKind)
            : loadedConfig,
        );
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setPhase('offline');
      });
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  const run = useCallback(
    async (turn: PendingTurn): Promise<void> => {
      const id = conversationId.current;
      if (!id) return;
      pendingTurn.current = turn;
      setSending(true);
      setPendingConsent(undefined);
      const controller = new AbortController();
      abort.current = controller;
      let finalText = '';
      try {
        const outcome = await streamAssistantTurn(
          {
            conversationId: id,
            message: turn.text,
            idempotencyKey: turn.idempotencyKey,
            ...(config?.selectedModel ? { model: config.selectedModel } : {}),
            ...(config?.selectedEffort ? { effort: config.selectedEffort } : {}),
            ...(config?.runnerKind ? { runnerKind: config.runnerKind } : {}),
            ...(turn.attachments.length ? { attachments: turn.attachments } : {}),
            ...(turn.providerConsent ? { providerConsent: turn.providerConsent } : {}),
          },
          (event) => {
            if (event.type === 'assistant.delta') {
              finalText += event.delta;
              setBubbles((current) =>
                current.map((bubble) =>
                  bubble.key === turn.assistantKey
                    ? { ...bubble, pending: false, text: finalText }
                    : bubble,
                ),
              );
            } else if (event.type === 'final') {
              finalText ||= event.text;
            } else if (event.type === 'context') {
              setContext({ used: event.used, size: event.size });
            } else if (event.type === 'usage') {
              setConfig((current) =>
                current
                  ? {
                      ...current,
                      selectedModel: event.model ?? current.selectedModel,
                      selectedEffort: event.effort ?? current.selectedEffort,
                    }
                  : current,
              );
            }
          },
          controller.signal,
        );
        if (outcome.error) throw new Error(outcome.error);
        if (outcome.consent) {
          setPendingConsent(outcome.consent);
          return;
        }
        setBubbles((current) =>
          current.map((bubble) =>
            bubble.key === turn.assistantKey
              ? {
                  ...bubble,
                  pending: false,
                  text: finalText || 'The agent completed without a text response.',
                }
              : bubble,
          ),
        );
        pendingTurn.current = undefined;
      } catch (error) {
        if (controller.signal.aborted) return;
        setBubbles((current) =>
          current.map((bubble) =>
            bubble.key === turn.assistantKey
              ? {
                  ...bubble,
                  pending: false,
                  error: true,
                  text: error instanceof Error ? error.message : String(error),
                }
              : bubble,
          ),
        );
        pendingTurn.current = undefined;
      } finally {
        if (mounted.current) setSending(false);
        if (abort.current === controller) abort.current = undefined;
      }
    },
    [config],
  );

  const send = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed || sending || !conversationId.current) return;
      const assistantKey = nextKey();
      const turn: PendingTurn = {
        text: trimmed,
        assistantKey,
        idempotencyKey: `mobile-${Date.now()}-${nextKey()}`,
        attachments,
      };
      setBubbles((current) => [
        ...current,
        { key: nextKey(), role: 'user', text: trimmed },
        { key: assistantKey, role: 'assistant', text: '', pending: true },
      ]);
      void run(turn);
      setAttachments([]);
    },
    [attachments, run, sending],
  );

  const stop = useCallback((): void => {
    abort.current?.abort();
    setSending(false);
    setBubbles((current) =>
      current.map((bubble) =>
        bubble.key === pendingTurn.current?.assistantKey && bubble.pending
          ? { ...bubble, pending: false, error: true, text: 'Stopped.' }
          : bubble,
      ),
    );
    pendingTurn.current = undefined;
  }, []);

  const approveConsent = useCallback((): void => {
    const turn = pendingTurn.current;
    const requested = pendingConsent;
    if (!turn || !requested) return;
    void run({ ...turn, providerConsent: requested.provider });
  }, [pendingConsent, run]);

  const declineConsent = useCallback((): void => {
    const key = pendingTurn.current?.assistantKey;
    setPendingConsent(undefined);
    setBubbles((current) =>
      current.map((bubble) =>
        bubble.key === key
          ? { ...bubble, pending: false, error: true, text: 'Not sent to the provider.' }
          : bubble,
      ),
    );
    pendingTurn.current = undefined;
  }, []);

  const selectModel = useCallback(
    (model: string): void => {
      if (!config) return;
      const runnerKind = config.runnerKind;
      setSelectionError(undefined);
      void persistAssistantSelection(runnerKind, 'model', model).then((result) => {
        if (!result.ok) {
          setSelectionError(result.error);
          return;
        }
        setConfig((current) =>
          current?.runnerKind === runnerKind
            ? {
                ...current,
                selectedModel: model,
                runners: current.runners.map((runner) =>
                  runner.kind === runnerKind ? { ...runner, selectedModel: model } : runner,
                ),
              }
            : current,
        );
      });
    },
    [config],
  );

  const selectEffort = useCallback(
    (effort: string): void => {
      if (!config) return;
      const runnerKind = config.runnerKind;
      setSelectionError(undefined);
      void persistAssistantSelection(runnerKind, 'effort', effort).then((result) => {
        if (!result.ok) {
          setSelectionError(result.error);
          return;
        }
        setConfig((current) =>
          current?.runnerKind === runnerKind
            ? {
                ...current,
                selectedEffort: effort,
                runners: current.runners.map((runner) =>
                  runner.kind === runnerKind ? { ...runner, selectedEffort: effort } : runner,
                ),
              }
            : current,
        );
      });
    },
    [config],
  );

  const selectRunner = useCallback(
    (runnerKind: string): void => {
      if (!config) return;
      setSelectionError(undefined);
      void loadAssistantConfig({ refresh: true })
        .then((fresh) => {
          if (!mounted.current) return;
          const selection = preflightedRunnerSelection(config, fresh, runnerKind);
          if (selection.error) {
            setSelectionError(selection.error);
            return;
          }
          setConfig(selection.config);
          setContext({});
          if (!selection.config.supportsAttachments) setAttachments([]);
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          setSelectionError(error instanceof Error ? error.message : String(error));
        });
    },
    [config],
  );

  const attach = useCallback((): void => {
    if (!config?.supportsAttachments || attaching) return;
    setAttaching(true);
    void pickAndUploadAssistantAttachment()
      .then((attachment) => {
        if (attachment) {
          setAttachments((current) =>
            current.some((item) => item.hash === attachment.hash)
              ? current
              : [...current, attachment],
          );
        }
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setAttaching(false));
  }, [attaching, config?.supportsAttachments]);

  const removeAttachment = useCallback((hash: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.hash !== hash));
  }, []);

  return {
    phase,
    bubbles,
    sending,
    loadError,
    selectionError,
    config,
    context,
    pendingConsent,
    attachments,
    attaching,
    send,
    stop,
    approveConsent,
    declineConsent,
    attach,
    removeAttachment,
    selectRunner,
    selectModel,
    selectEffort,
  };
}
