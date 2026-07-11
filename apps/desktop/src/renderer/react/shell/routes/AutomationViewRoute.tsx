import { type JSX, useRef } from 'react';
import {
  auth,
  deleteAutomation,
  listAutomationRuns,
  readAutomation,
  runAutomationNow,
  setAutomationEnabled,
} from '../../../gateway-client.js';
import { triggersSummary } from '../../../app-format.js';
import AutomationViewScreen from '../../screens/AutomationViewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { buildAutomationViewData } from './automationsData.js';

// React-owned automation single-view — replaces the vanilla renderAutomationView
// (app-automations.ts). loadData fetches the row + runs and derives the DTO; the
// current row is held in a ref so the run/toggle/delete actions can read its
// ref/name. Navigation, toast, and the confirm dialog come from ShellActions.
export default function AutomationViewRoute({
  automationId,
}: {
  automationId: string;
}): JSX.Element {
  const { navigate, showToast, confirm } = useShellActions();
  const rowRef = useRef<CentraidAutomationRow | null>(null);

  return (
    <PageScroll>
      <AutomationViewScreen
        loadData={async () => {
          const [row, runs, { baseUrl }] = await Promise.all([
            readAutomation({ automationId }),
            listAutomationRuns({ automationId, limit: 40 }),
            auth(),
          ]);
          rowRef.current = row;
          return row ? buildAutomationViewData(row, runs, baseUrl) : null;
        }}
        onBack={() => navigate({ kind: 'automations' })}
        onEdit={() => {
          const row = rowRef.current;
          if (row) navigate({ kind: 'automation-builder', automationId: row.id });
        }}
        onOpenRun={(autoId, runId) => navigate({ kind: 'run-view', automationId: autoId, runId })}
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
            showToast(`Could not delete ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onRun={async () => {
          const row = rowRef.current;
          if (!row) return false;
          try {
            const { runId } = await runAutomationNow({ automationId: row.ref });
            navigate({ kind: 'run-view', automationId: row.ref, runId });
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
            showToast(
              next ? `Enabled · ${triggersSummary(row.triggers)}` : 'Disabled — schedule stopped',
            );
            return true;
          } catch (err) {
            showToast(
              `Could not ${next ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        }}
      />
    </PageScroll>
  );
}
