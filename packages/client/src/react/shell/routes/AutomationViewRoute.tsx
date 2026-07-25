import { type JSX, useRef } from 'react';
import type { TurnStreamEvent } from '@centraid/blueprints/kit/turn-stream.js';
import {
  auth,
  compileAutomation,
  deleteAutomation,
  listAutomationTurns,
  readAutomationTurnExpanded,
  readGatewayCapabilities,
  reviseAutomation,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
  streamAutomationConversationTurn,
  streamAutomationTurn,
  type AutomationTurnStreamEvent,
} from '../../../gateway-client.js';
import type { AsstMsgDTO } from '../../screen-contracts.js';
import AutomationThreadScreen, {
  type AutomationThreadDataEx,
} from '../../screens/AutomationThreadScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { openWebhookReveal } from '../webhookReveal.js';
import { deriveAutomationHero } from './automationsData.js';
import { decideConsentItem, loadAutomationThreadData } from './automationThreadData.js';
import {
  automationLiveMessages,
  automationTurnMessages,
  createAutomationLiveTrace,
  reduceAutomationTurnEvent,
} from './automationTurnMessages.js';

async function loadTrace(turnId: string): Promise<AsstMsgDTO[]> {
  const expanded = await readAutomationTurnExpanded({ turnId });
  return expanded.turn ? automationTurnMessages(expanded.turn, expanded.items) : [];
}

async function watchNativeTrace(
  turnId: string,
  onMessages: (messages: AsstMsgDTO[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const initial = await readAutomationTurnExpanded({ turnId }).catch(() => ({
    turn: null,
    items: [] as CentraidAutomationItem[],
  }));
  if (initial.turn) onMessages(automationTurnMessages(initial.turn, initial.items));
  const inbound =
    initial.items.find((item) => item.kind === 'message_in')?.text ??
    (initial.turn?.triggerKind === 'compile' ? 'Apply the revised standing instructions.' : '');
  let live = createAutomationLiveTrace(inbound);
  let ended = false;
  const apply = (event: AutomationTurnStreamEvent): void => {
    if (event.type === 'item.delta') {
      live = reduceAutomationTurnEvent(live, event.event as TurnStreamEvent);
      onMessages(automationLiveMessages(live));
    } else if (event.type === 'turn.end') {
      ended = true;
    }
  };
  await streamAutomationTurn(turnId, apply, signal);
  if (signal.aborted) return;
  // The ledger is authoritative for completion, usage, errors, and cold/live
  // parity. Re-read once after turn.end (or an unexpectedly closed stream).
  const final = await readAutomationTurnExpanded({ turnId });
  if (final.turn) onMessages(automationTurnMessages(final.turn, final.items));
  else if (ended) onMessages(automationLiveMessages({ ...live, done: true }));
}

// React-owned automation thread — replaces the old single-view
// (AutomationViewScreen, now deleted) at the `automation-view` route
// (Automations UI revamp, see receipts/issue-387-automations-ui-revamp.md). `loadData` composes
// `loadAutomationThreadData` (row + runs + consent, pre-filtered to this
// automation's actor) with two small additive fetches that plug documented
// gaps in `AutomationThreadData` — see `AutomationThreadDataEx`'s doc
// comment in the screen file: a `triggerDetail` block (raw cron expr /
// data-condition entity+cadence, derived via the already-exported
// `deriveAutomationHero` — no new endpoint) and a `runTokens` map (per-run
// token counts, from a `listAutomationTurns` call the data layer already
// makes internally). The row is held in a ref, same shape as the old
// wrapper, so delete/run/toggle/rotate/edit/send actions can read its
// ref/name without re-fetching.
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
        onEdit={() => {
          const row = rowRef.current;
          if (row) navigate({ kind: 'automation-editor', automationId: row.ref });
        }}
        onRetryCompile={async () => {
          const row = rowRef.current;
          if (!row) return false;
          try {
            await compileAutomation({ automationId: row.ref, enableOnSuccess: !row.enabled });
            showToast('Compiling plan…');
            return true;
          } catch (err) {
            showToast(`Could not compile: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onOpenRun={(runId) => {
          const row = rowRef.current;
          if (row) navigate({ automationId: row.ref, kind: 'run-view', runId });
        }}
        loadTurnTrace={loadTrace}
        watchTurn={watchNativeTrace}
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
        onSendMessage={async (text, applyFuture, onMessages, signal) => {
          const row = rowRef.current;
          if (!row) return null;
          try {
            if (applyFuture) {
              onMessages([
                { kind: 'user', text },
                { kind: 'ai', streaming: true, text: 'Revising standing instructions…' },
              ]);
              const { compileTurnId } = await reviseAutomation({
                automationId: row.ref,
                message: text,
              });
              await watchNativeTrace(compileTurnId, onMessages, signal);
              showToast('Standing instructions updated');
              return compileTurnId;
            }
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
              onMessages(await loadTrace(result.turnId));
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
              showToast(`Could not update: ${message}`);
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
