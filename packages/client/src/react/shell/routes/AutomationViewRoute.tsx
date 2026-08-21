import { useRef } from "react";
import type { JSX } from "react";

import {
  auth,
  deleteAutomation,
  fetchAssistantAttachmentUrl,
  invokeAutomationAndAwait,
  listAutomationTurns,
  MAX_ATTACHMENT_BYTES,
  readGatewayCapabilities,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
  streamAutomationConversationTurn,
  updateAutomation,
  uploadConversationAttachment,
} from "../../../gateway-client.js";
import {
  providerConsentWire,
  withProviderConsent,
} from "../../providerConsent.js";
import type {
  HarnessesStatusDTO,
  AsstModelPickerDTO,
  AsstMsgDTO,
  BuilderAttachmentRef,
} from "../../screen-contracts.js";
import AutomationThreadScreen from "../../screens/AutomationThreadScreen.js";
import type { AutomationThreadDataEx } from "../../screens/AutomationThreadScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { openWebhookReveal } from "../webhookReveal.js";
import { createKeyedMessageProjection } from "./assistantProjection.js";
import {
  automationLiveMessages,
  createAutomationLiveTrace,
  reduceAutomationTurnEvent,
} from "./automationLiveMessages.js";
import { deriveAutomationHero } from "./automationsData.js";
import {
  decideConsentItem,
  loadAutomationThreadData,
} from "./automationThreadData.js";
import { loadTurnTrace, watchTurnMessages } from "./automationTurnWatch.js";
import {
  loadHarnesses,
  resolveReportedHarnessKind,
} from "./settingsHarnessesData.js";

export function automationPicker(
  status: HarnessesStatusDTO,
  requestedHarness?: string,
  manifestPins?: { harness?: string; model?: string; thoughtLevel?: string }
): AsstModelPickerDTO {
  const harnessKind = resolveReportedHarnessKind(
    status,
    requestedHarness,
    "automations"
  );
  const manifestHarnessKind = resolveReportedHarnessKind(
    status,
    manifestPins?.harness,
    "automations"
  );
  const applyManifestPins = harnessKind === manifestHarnessKind;
  const card = status.cards.find((entry) => entry.kind === harnessKind);
  const models = card?.modelConfigurable ? card.models : [];
  const defaultId = status.savedModelByKind[harnessKind] ?? "";
  const defaultModel =
    models.find((model) => model.id === defaultId) ??
    models.find((model) => model.default) ??
    models[0];
  const effortOption = card?.configOptions?.find(
    (option) => option.category === "thought_level"
  );
  const defaultEffort =
    status.defaultConfigPinsByKind[harnessKind]?.thought_level ??
    effortOption?.currentValue ??
    "";
  return {
    harnesses: status.cards.map((harness) => ({
      kind: harness.kind,
      title: harness.title,
      connected: harness.connected,
      sessionReady: harness.sessionReady,
      hint: [
        harness.subtitle,
        ...(harness.breakerStates ?? []).map(
          (state) => `${state.failureClass} ${state.state}`
        ),
      ].join(" · "),
    })),
    selectedHarnessKind: harnessKind,
    workspaceKinds: [],
    connected: card?.connected ?? false,
    models: models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.default ? { default: true } : {}),
    })),
    defaultModelName:
      defaultModel?.name ?? defaultModel?.id ?? "gateway default",
    selectedModelId:
      (applyManifestPins ? manifestPins?.model : undefined) ??
      status.subsystemModelByKind[harnessKind]?.automations ??
      "",
    ...(applyManifestPins && manifestPins?.model ? { modelLocked: true } : {}),
    efforts: effortOption?.values ?? [],
    defaultEffortName:
      effortOption?.values.find((value) => value.value === defaultEffort)
        ?.name ?? defaultEffort,
    selectedEffortId:
      (applyManifestPins ? manifestPins?.thoughtLevel : undefined) ??
      status.subsystemConfigPinsByKind[harnessKind]?.automations
        ?.thought_level ??
      "",
    ...(applyManifestPins && manifestPins?.thoughtLevel
      ? { effortLocked: true }
      : {}),
    supportsAttachments: card?.supportsAttachments === true,
    supportsContext: card?.supportsContext === true,
  };
}

/**
 * The harness the automation's MOST RECENT run actually used. `listAutomationTurns`
 * documents newest-first, but "first entry that happens to carry a harnessKind"
 * silently inherits that ordering — so pick the latest run explicitly (#567).
 */
export function latestHarnessKind(
  runs: readonly CentraidAutomationTurnRecord[]
): string | undefined {
  let latest: CentraidAutomationTurnRecord | undefined;
  for (const run of runs) {
    if (!run.harnessKind) continue;
    if (
      !latest ||
      run.startedAt > latest.startedAt ||
      (run.startedAt === latest.startedAt && run.seq > latest.seq)
    ) {
      latest = run;
    }
  }
  return latest?.harnessKind;
}

async function askAutomationWithConsent(input: {
  automationRef: string;
  text: string;
  onMessages: (messages: AsstMsgDTO[]) => void;
  signal: AbortSignal;
  turn: {
    attachments?: BuilderAttachmentRef[];
    harnessKind?: string;
    model?: string;
    thinking?: string;
    onContext?: (context: { used: number; size: number }) => void;
  };
  confirm: (input: {
    confirmLabel: string;
    message: string;
    title: string;
  }) => Promise<boolean>;
}): Promise<string | null> {
  let live = createAutomationLiveTrace(input.text);
  // Reference-stable rows for the memoized transcript (issue #659): a streamed
  // event rebuilds the whole projection, but only the rows that actually moved
  // should reach React.
  const projectLive = createKeyedMessageProjection();
  input.onMessages(projectLive(automationLiveMessages(live)));
  // Approvals accumulate across this ask: consent for provider A then a
  // failover to B must resend BOTH, or the server re-asks for A forever (#567).
  let approvedProviders: string[] = [];
  // A consent request changes the credentials for the next transport attempt,
  // so this is a serial retry state machine rather than parallel asks.
  const requestTurn = async (): Promise<string | null> => {
    let requiredProvider: string | undefined;
    const result = await streamAutomationConversationTurn(
      input.automationRef,
      input.text,
      (event) => {
        if (event.type === "consent.required")
          requiredProvider = event.provider;
        else {
          if (
            event.type === "context" &&
            event.used !== undefined &&
            event.size !== undefined
          ) {
            input.turn.onContext?.({ used: event.used, size: event.size });
          }
          live = reduceAutomationTurnEvent(live, event);
          input.onMessages(projectLive(automationLiveMessages(live)));
        }
      },
      input.signal,
      providerConsentWire(approvedProviders),
      {
        ...(input.turn.attachments?.length
          ? { attachments: input.turn.attachments }
          : {}),
        ...(input.turn.harnessKind
          ? { harnessKind: input.turn.harnessKind }
          : {}),
        ...(input.turn.model ? { model: input.turn.model } : {}),
        ...(input.turn.thinking ? { thinking: input.turn.thinking } : {}),
      }
    );
    if (!requiredProvider) {
      if (result.turnId && !input.signal.aborted) {
        input.onMessages(await loadTurnTrace(result.turnId));
      }
      return result.turnId ?? null;
    }
    const approved = await input.confirm({
      confirmLabel: "Allow provider",
      message:
        `Allow this automation conversation to be sent to ${requiredProvider}? ` +
        "This can include the question, standing instructions, recent run context, and scoped tool results.",
      title: `Send to ${requiredProvider}?`,
    });
    if (!approved) return null;
    approvedProviders = withProviderConsent(
      approvedProviders,
      requiredProvider
    );
    return requestTurn();
  };
  return requestTurn();
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
  const harnessRef = useRef<string | undefined>(undefined);

  return (
    <PageScroll>
      <AutomationThreadScreen
        loadData={async (): Promise<AutomationThreadDataEx | null> => {
          const { baseUrl } = await auth();
          const [result, runs, capabilities, harnesses] = await Promise.all([
            loadAutomationThreadData({ automationId, gatewayOrigin: baseUrl }),
            listAutomationTurns({ automationId, limit: 100 }),
            readGatewayCapabilities().catch(() => undefined),
            loadHarnesses().catch(() => undefined),
          ]);
          if (!result) {
            rowRef.current = null;
            return null;
          }
          rowRef.current = result.row;
          harnessRef.current ??= latestHarnessKind(runs);
          const hero = deriveAutomationHero(result.row, baseUrl);
          const runTokens: Record<string, number> = {};
          for (const r of runs) {
            const tokens =
              (r.totalInputTokens ?? 0) + (r.totalOutputTokens ?? 0);
            if (tokens > 0) runTokens[r.turnId] = tokens;
          }
          return {
            ...result.data,
            automationTurns: capabilities?.automationTurns === true,
            runTokens,
            ...(harnesses
              ? {
                  harnessConfig: automationPicker(
                    harnesses,
                    harnessRef.current ?? result.row.manifest.requires?.harness,
                    result.row.manifest.requires
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
        onBack={() => navigate({ kind: "automations" })}
        onOpenCompiler={() => {
          const row = rowRef.current;
          if (row)
            navigate({ kind: "automation-editor", automationId: row.ref });
        }}
        onOpenRun={(runId) => {
          const row = rowRef.current;
          if (row) navigate({ automationId: row.ref, kind: "run-view", runId });
        }}
        loadTurnTrace={loadTurnTrace}
        watchTurn={async (turnId, onMessages, signal) =>
          (await watchTurnMessages(turnId, onMessages, signal)).settled
        }
        onCopyWebhook={(url) =>
          void navigator.clipboard
            .writeText(url)
            .then(() => showToast("Webhook URL copied"))
            .catch(() => showToast("Could not copy to clipboard"))
        }
        onDelete={async () => {
          const row = rowRef.current;
          if (!row) return false;
          const ok = await confirm({
            confirmLabel: "Delete",
            danger: true,
            message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
            title: "Delete automation?",
          });
          if (!ok) return false;
          try {
            await deleteAutomation({ automationId: row.ref });
            showToast(`Deleted "${row.name}"`);
            navigate({ kind: "automations" });
            return true;
          } catch (error) {
            showToast(
              `Could not delete ${row.name}: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onRunNow={async () => {
          const row = rowRef.current;
          if (!row) return null;
          try {
            const { turnId } = row.manifest.enrich?.delegateStep
              ? await invokeAutomationAndAwait({
                  automationId: row.ref,
                })
              : await runAutomationNow({ automationId: row.ref });
            showToast(
              row.manifest.enrich?.delegateStep
                ? "Recognition completed"
                : "Run started"
            );
            return turnId;
          } catch (error) {
            showToast(
              `Run failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
          }
        }}
        onSetRecognitionStep={async (variant) => {
          const row = rowRef.current;
          if (!row) return false;
          try {
            const updated = await updateAutomation({
              automationId: row.ref,
              recognitionStep: variant,
            });
            if (updated.row) rowRef.current = updated.row;
            showToast(
              variant === "delegate"
                ? "Delegate recognition selected; future runs may incur provider cost"
                : "Deterministic recognition selected"
            );
            return true;
          } catch (error) {
            showToast(
              `Could not change recognition method: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onToggleEnabled={async (next) => {
          const row = rowRef.current;
          if (!row) return false;
          try {
            await setAutomationEnabled({
              automationId: row.ref,
              enabled: next,
            });
            return true;
          } catch (error) {
            showToast(
              `Could not ${next ? "enable" : "disable"} ${row.name}: ${error instanceof Error ? error.message : String(error)}`
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
              ...(alwaysAllow === undefined ? {} : { alwaysAllow }),
            });
          } catch (error) {
            showToast(
              `Could not update: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onUploadAttachment={async (file) => {
          const row = rowRef.current;
          if (!row) throw new Error("Automation is no longer available.");
          if (file.size > MAX_ATTACHMENT_BYTES) {
            throw new Error("Attachments must be 25 MB or smaller.");
          }
          const ref = await uploadConversationAttachment(
            row.ownerApp,
            new Uint8Array(await file.arrayBuffer()),
            file.type || "application/octet-stream",
            file.name
          );
          return ref;
        }}
        loadAttachmentImage={(hash, mime) => {
          const row = rowRef.current;
          if (!row)
            return Promise.reject(
              new Error("Automation is no longer available.")
            );
          return fetchAssistantAttachmentUrl(row.ownerApp, hash, mime);
        }}
        onSetHarness={async (harnessKind) => {
          const previous = harnessRef.current;
          const status = await loadHarnesses({ refresh: true });
          const target = status.cards.find((card) => card.kind === harnessKind);
          if (!target?.sessionReady) {
            showToast(
              [
                target?.subtitle ??
                  `${harnessKind} did not complete its session preflight.`,
                ...(target?.breakerStates ?? []).map(
                  (state) => `${state.failureClass} ${state.state}`
                ),
              ].join(" · ")
            );
            return automationPicker(
              status,
              previous,
              rowRef.current?.manifest.requires
            );
          }
          harnessRef.current = harnessKind;
          return automationPicker(
            status,
            harnessKind,
            rowRef.current?.manifest.requires
          );
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
          } catch (error) {
            if (!signal.aborted) {
              const message =
                error instanceof Error ? error.message : String(error);
              onMessages([
                { kind: "user", text },
                {
                  kind: "ai",
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
            confirmLabel: "Regenerate",
            danger: true,
            message:
              "This invalidates the current secret — any caller using it starts failing until updated. The webhook URL stays the same.",
            title: "Regenerate webhook secret?",
          });
          if (!ok) return false;
          try {
            const { webhook } = await rotateAutomationWebhookSecret({
              automationId: row.ref,
            });
            await openWebhookReveal(webhook, {
              note: "Shown once — update your caller now.",
              title: "New webhook secret",
            });
            showToast("Webhook secret regenerated");
            return true;
          } catch (error) {
            showToast(
              `Could not regenerate secret: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
      />
    </PageScroll>
  );
}
