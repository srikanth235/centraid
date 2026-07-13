import { type JSX, useRef } from 'react';
import {
  auth,
  deleteAutomation,
  listAutomationRuns,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
} from '../../../gateway-client.js';
import AutomationThreadScreen, {
  type AutomationThreadDataEx,
} from '../../screens/AutomationThreadScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { openWebhookReveal } from '../webhookReveal.js';
import { deriveAutomationHero } from './automationsData.js';
import { decideConsentItem, loadAutomationThreadData } from './automationThreadData.js';

// React-owned automation thread — replaces the old single-view
// (AutomationViewScreen, now deleted) at the `automation-view` route
// (Automations UI revamp, see receipts/issue-387-automations-ui-revamp.md). `loadData` composes
// `loadAutomationThreadData` (row + runs + consent, pre-filtered to this
// automation's actor) with two small additive fetches that plug documented
// gaps in `AutomationThreadData` — see `AutomationThreadDataEx`'s doc
// comment in the screen file: a `triggerDetail` block (raw cron expr /
// data-condition entity+cadence, derived via the already-exported
// `deriveAutomationHero` — no new endpoint) and a `runTokens` map (per-run
// token counts, from a `listAutomationRuns` call the data layer already
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
          const [result, runs] = await Promise.all([
            loadAutomationThreadData({ automationId, gatewayOrigin: baseUrl }),
            listAutomationRuns({ automationId, limit: 100 }),
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
            if (tokens > 0) runTokens[r.runId] = tokens;
          }
          return {
            ...result.data,
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
        onOpenRun={(runId) => {
          const row = rowRef.current;
          if (row) navigate({ automationId: row.ref, kind: 'run-view', runId });
        }}
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
          if (!row) return false;
          try {
            await runAutomationNow({ automationId: row.ref });
            showToast('Run started');
            return true;
          } catch (err) {
            showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
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
        onSendMessage={(text) => {
          const row = rowRef.current;
          if (!row) return;
          // Builder route keys on the BARE app id — a compound ref's `/`
          // breaks useBuilder's ownerApp match and 500s the session route.
          navigate({ automationId: row.id, kind: 'automation-builder', seedMessage: text });
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
