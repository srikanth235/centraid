import { type JSX, useRef } from 'react';
import {
  auth,
  deleteAutomation,
  fetchAssistantAttachmentUrl,
  listAutomationTurns,
  MAX_ATTACHMENT_BYTES,
  readGatewayCapabilities,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
  streamAutomationConversationTurn,
  uploadConversationAttachment,
} from '../../../gateway-client.js';
import AutomationThreadScreen, {
  type AutomationThreadDataEx,
} from '../../screens/AutomationThreadScreen.js';
import type {
  AgentsStatusDTO,
  AsstModelPickerDTO,
  AsstMsgDTO,
  BuilderAttachmentRef,
} from '../../screen-contracts.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { openWebhookReveal } from '../webhookReveal.js';
import { deriveAutomationHero } from './automationsData.js';
import { decideConsentItem, loadAutomationThreadData } from './automationThreadData.js';
import { loadTurnTrace, watchTurnMessages } from './automationTurnWatch.js';
import {
  automationLiveMessages,
  createAutomationLiveTrace,
  reduceAutomationTurnEvent,
} from './automationLiveMessages.js';
import { loadProviders, resolveReportedRunnerKind } from './settingsProvidersData.js';

export function automationPicker(
  status: AgentsStatusDTO,
  requestedRunner?: string,
  manifestPins?: { runner?: string; model?: string; thoughtLevel?: string },
): AsstModelPickerDTO {
  const runnerKind = resolveReportedRunnerKind(status, requestedRunner, 'automations');
  const manifestRunnerKind = resolveReportedRunnerKind(status, manifestPins?.runner, 'automations');
  const applyManifestPins = runnerKind === manifestRunnerKind;
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
    workspaceKinds: [],
    connected: card?.connected ?? false,
    models: models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.default ? { default: true } : {}),
    })),
    defaultModelName: defaultModel?.name ?? defaultModel?.id ?? 'gateway default',
    selectedModelId:
      (applyManifestPins ? manifestPins?.model : undefined) ??
      status.subsystemModelByKind[runnerKind]?.automations ??
      '',
    ...(applyManifestPins && manifestPins?.model ? { modelLocked: true } : {}),
    efforts: effortOption?.values ?? [],
    defaultEffortName:
      effortOption?.values.find((value) => value.value === defaultEffort)?.name ?? defaultEffort,
    selectedEffortId:
      (applyManifestPins ? manifestPins?.thoughtLevel : undefined) ??
      status.subsystemConfigPinsByKind[runnerKind]?.automations?.thought_level ??
      '',
    ...(applyManifestPins && manifestPins?.thoughtLevel ? { effortLocked: true } : {}),
    supportsAttachments: card?.supportsAttachments === true,
    supportsContext: card?.supportsContext === true,
  };
}

async function askAutomationWithConsent(input: {
  automationRef: string;
  text: string;
  onMessages: (messages: AsstMsgDTO[]) => void;
  signal: AbortSignal;
  turn: {
    attachments?: BuilderAttachmentRef[];
    runnerKind?: string;
    model?: string;
    thinking?: string;
    onContext?: (context: { used: number; size: number }) => void;
  };
  confirm: (input: { confirmLabel: string; message: string; title: string }) => Promise<boolean>;
}): Promise<string | null> {
  let live = createAutomationLiveTrace(input.text);
  input.onMessages(automationLiveMessages(live));
  let providerConsent: string | undefined;
  for (;;) {
    let requiredProvider: string | undefined;
    const result = await streamAutomationConversationTurn(
      input.automationRef,
      input.text,
      (event) => {
        if (event.type === 'consent.required') requiredProvider = event.provider;
        else {
          if (event.type === 'context' && event.used !== undefined && event.size !== undefined) {
            input.turn.onContext?.({ used: event.used, size: event.size });
          }
          live = reduceAutomationTurnEvent(live, event);
          input.onMessages(automationLiveMessages(live));
        }
      },
      input.signal,
      providerConsent,
      {
        ...(input.turn.attachments?.length ? { attachments: input.turn.attachments } : {}),
        ...(input.turn.runnerKind ? { runnerKind: input.turn.runnerKind } : {}),
        ...(input.turn.model ? { model: input.turn.model } : {}),
        ...(input.turn.thinking ? { thinking: input.turn.thinking } : {}),
      },
    );
    if (!requiredProvider) {
      if (result.turnId && !input.signal.aborted) {
        input.onMessages(await loadTurnTrace(result.turnId));
      }
      return result.turnId ?? null;
    }
    const approved = await input.confirm({
      confirmLabel: 'Allow provider',
      message:
        `Allow this automation conversation to be sent to ${requiredProvider}? ` +
        'This can include the question, standing instructions, recent run context, and scoped tool results.',
      title: `Send to ${requiredProvider}?`,
    });
    if (!approved) return null;
    providerConsent = requiredProvider;
  }
}

// The RUN SCREEN's route wrapper. It wires exactly the reading surface:
// history, consent decisions, run-now, pause, delete, and a read-only ask.
// Notably ABSENT is compile — `compileAutomation` is imported only by the
// editor route now, which is the mechanical half of the "compiling is the
// compiler's job" split. `loadData`
// composes `loadAutomationThreadData` (row + executions + plan status +
// consent, with compile turns already filtered out) with two small additive
// fetches that plug documented DTO gaps — see `AutomationThreadDataEx`.
export default function AutomationViewRoute({
  automationId,
}: {
  automationId: string;
}): JSX.Element {
  const { navigate, showToast, confirm } = useShellActions();
  const rowRef = useRef<CentraidAutomationRow | null>(null);
  const runnerRef = useRef<string | undefined>(undefined);

  return (
    <PageScroll>
      <AutomationThreadScreen
        loadData={async (): Promise<AutomationThreadDataEx | null> => {
          const { baseUrl } = await auth();
          const [result, runs, capabilities, providers] = await Promise.all([
            loadAutomationThreadData({ automationId, gatewayOrigin: baseUrl }),
            listAutomationTurns({ automationId, limit: 100 }),
            readGatewayCapabilities().catch(() => undefined),
            loadProviders().catch(() => undefined),
          ]);
          if (!result) {
            rowRef.current = null;
            return null;
          }
          rowRef.current = result.row;
          runnerRef.current ??= runs.find((run) => run.adapterKind)?.adapterKind;
          const hero = deriveAutomationHero(result.row, baseUrl);
          const runTokens: Record<string, number> = {};
          for (const r of runs) {
            const tokens = (r.totalInputTokens ?? 0) + (r.totalOutputTokens ?? 0);
            if (tokens > 0) runTokens[r.turnId] = tokens;
          }
          return {
            ...result.data,
            automationTurns: capabilities?.automationTurns === true,
            runTokens,
            ...(providers
              ? {
                  runnerConfig: automationPicker(
                    providers,
                    runnerRef.current ?? result.row.manifest.requires?.runner,
                    result.row.manifest.requires,
                  ),
                }
              : {}),
            triggerDetail: {
              conditionDetail: hero.conditionDetail,
              cronExprs: hero.cronExprs,
              dataDetail: hero.dataDetail,
            },
          };
        }}
        onBack={() => navigate({ kind: 'automations' })}
        onOpenCompiler={() => {
          const row = rowRef.current;
          if (row) navigate({ kind: 'automation-editor', automationId: row.ref });
        }}
        onOpenRun={(runId) => {
          const row = rowRef.current;
          if (row) navigate({ automationId: row.ref, kind: 'run-view', runId });
        }}
        loadTurnTrace={loadTurnTrace}
        watchTurn={async (turnId, onMessages, signal) =>
          (await watchTurnMessages(turnId, onMessages, signal)).settled
        }
        onCopyWebhook={(url) =>
          void navigator.clipboard
            .writeText(url)
            .then(() => showToast('Webhook URL copied'))
            .catch(() => showToast('Could not copy to clipboard'))
        }
        onDelete={async () => {
          const row = rowRef.current;
          if (!row) return false;
          const ok = await confirm({
            confirmLabel: 'Delete',
            danger: true,
            message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
            title: 'Delete automation?',
          });
          if (!ok) return false;
          try {
            await deleteAutomation({ automationId: row.ref });
            showToast(`Deleted "${row.name}"`);
            navigate({ kind: 'automations' });
            return true;
          } catch (err) {
            showToast(
              `Could not delete ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        }}
        onRunNow={async () => {
          const row = rowRef.current;
          if (!row) return null;
          try {
            const { turnId } = await runAutomationNow({ automationId: row.ref });
            showToast('Run started');
            return turnId;
          } catch (err) {
            showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }}
        onToggleEnabled={async (next) => {
          const row = rowRef.current;
          if (!row) return false;
          try {
            await setAutomationEnabled({ automationId: row.ref, enabled: next });
            return true;
          } catch (err) {
            showToast(
              `Could not ${next ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        }}
        onDecideConsent={async (kind, id, decision, alwaysAllow) => {
          try {
            return await decideConsentItem({
              decision,
              id,
              kind,
              ...(alwaysAllow !== undefined ? { alwaysAllow } : {}),
            });
          } catch (err) {
            showToast(`Could not update: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onUploadAttachment={async (file) => {
          const row = rowRef.current;
          if (!row) throw new Error('Automation is no longer available.');
          if (file.size > MAX_ATTACHMENT_BYTES) {
            throw new Error('Attachments must be 25 MB or smaller.');
          }
          const ref = await uploadConversationAttachment(
            row.ownerApp,
            new Uint8Array(await file.arrayBuffer()),
            file.type || 'application/octet-stream',
            file.name,
          );
          return ref;
        }}
        loadAttachmentImage={(hash, mime) => {
          const row = rowRef.current;
          if (!row) return Promise.reject(new Error('Automation is no longer available.'));
          return fetchAssistantAttachmentUrl(row.ownerApp, hash, mime);
        }}
        onSetRunner={async (runnerKind) => {
          const previous = runnerRef.current;
          const status = await loadProviders({ refresh: true });
          const target = status.cards.find((card) => card.kind === runnerKind);
          if (!target?.sessionReady) {
            showToast(
              [
                target?.subtitle ?? `${runnerKind} did not complete its session preflight.`,
                ...(target?.breakerStates ?? []).map(
                  (state) => `${state.failureClass} ${state.state}`,
                ),
              ].join(' · '),
            );
            return automationPicker(status, previous, rowRef.current?.manifest.requires);
          }
          runnerRef.current = runnerKind;
          return automationPicker(status, runnerKind, rowRef.current?.manifest.requires);
        }}
        onAskAboutRuns={async (text, turn, onMessages, signal) => {
          const row = rowRef.current;
          if (!row) return null;
          try {
            // One conversational turn against the automation's own thread, and
            // nothing else. The `applyFuture` branch that used to live here
            // rewrote the standing instructions and kicked a compile from the
            // run screen. Changing what an automation does happens in exactly
            // one place now: the instructions field on the compile screen.
            return await askAutomationWithConsent({
              automationRef: row.ref,
              text,
              turn,
              onMessages,
              signal,
              confirm,
            });
          } catch (err) {
            if (!signal.aborted) {
              const message = err instanceof Error ? err.message : String(err);
              onMessages([
                { kind: 'user', text },
                {
                  kind: 'ai',
                  streaming: false,
                  html: message,
                  error: true,
                  copyText: message,
                  feedback: null,
                },
              ]);
              showToast(`Could not answer: ${message}`);
            }
            return null;
          }
        }}
        onRotateWebhook={async () => {
          const row = rowRef.current;
          if (!row) return false;
          const ok = await confirm({
            confirmLabel: 'Regenerate',
            danger: true,
            message:
              'This invalidates the current secret — any caller using it starts failing until updated. The webhook URL stays the same.',
            title: 'Regenerate webhook secret?',
          });
          if (!ok) return false;
          try {
            const { webhook } = await rotateAutomationWebhookSecret({ automationId: row.ref });
            await openWebhookReveal(webhook, {
              note: "This secret is shown once. Update your caller now — you won't see it again.",
              title: 'New webhook secret',
            });
            showToast('Webhook secret regenerated');
            return true;
          } catch (err) {
            showToast(
              `Could not regenerate secret: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        }}
      />
    </PageScroll>
  );
}
