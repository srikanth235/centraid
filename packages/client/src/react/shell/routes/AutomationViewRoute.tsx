import { type JSX, useRef } from 'react';
import {
  auth,
  deleteAutomation,
  listAutomationTurns,
  readGatewayCapabilities,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
  streamAutomationConversationTurn,
} from '../../../gateway-client.js';
import AutomationThreadScreen, {
  type AutomationThreadDataEx,
} from '../../screens/AutomationThreadScreen.js';
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

  return (
    <PageScroll>
      <AutomationThreadScreen
        loadData={async (): Promise<AutomationThreadDataEx | null> => {
          const { baseUrl } = await auth();
          const [result, runs, capabilities] = await Promise.all([
            loadAutomationThreadData({ automationId, gatewayOrigin: baseUrl }),
            listAutomationTurns({ automationId, limit: 100 }),
            readGatewayCapabilities().catch(() => undefined),
          ]);
          if (!result) {
            rowRef.current = null;
            return null;
          }
          rowRef.current = result.row;
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
        onAskAboutRuns={async (text, onMessages, signal) => {
          const row = rowRef.current;
          if (!row) return null;
          try {
            // One conversational turn against the automation's own thread, and
            // nothing else. The `applyFuture` branch that used to live here
            // rewrote the standing instructions and kicked a compile from the
            // run screen. Changing what an automation does happens in exactly
            // one place now: the instructions field on the compile screen.
            let live = createAutomationLiveTrace(text);
            onMessages(automationLiveMessages(live));
            const result = await streamAutomationConversationTurn(
              row.ref,
              text,
              (event) => {
                live = reduceAutomationTurnEvent(live, event);
                onMessages(automationLiveMessages(live));
              },
              signal,
            );
            if (result.turnId && !signal.aborted) {
              onMessages(await loadTurnTrace(result.turnId));
            }
            return result.turnId ?? null;
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
