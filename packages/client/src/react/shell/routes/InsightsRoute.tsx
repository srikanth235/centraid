import type { JSX } from 'react';
import { getInsightsSummary, listAutomations } from '../../../gateway-client.js';
import InsightsScreen from '../../screens/InsightsScreen.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';

// React-owned Insights route — the App root renders this for `{ kind: 'insights' }`,
// replacing the vanilla `renderInsights` (app-insights.ts). Gateway I/O moves
// into the effect; the InsightsScreen owns the dashboard exactly as before.
// Insights paints its own header, so PageScroll carries no title.
//
// The store's summary carries automation REFS but no CURRENT display names
// (the manifests live on disk, not in journal.db — see InsightsStore) — this
// route resolves them from the automation list. A deleted automation falls
// back to its run's own last-known `automationName` (recorded on the run
// itself, so it survives the automation being deleted) and only then to the
// raw ref (matching the Automations overview's orphan-run labels).
export default function InsightsRoute(): JSX.Element {
  const state = useAsyncData(async () => {
    const [summary, automations] = await Promise.all([
      getInsightsSummary(),
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
    ]);
    const nameByRef = new Map(automations.map((a) => [a.ref, a.name]));
    return {
      ...summary,
      byAutomation: summary.byAutomation.map((row) =>
        row.kind === 'automation'
          ? { ...row, label: nameByRef.get(row.key) ?? row.automationName ?? row.key }
          : row,
      ),
      recent: summary.recent.map((row) =>
        row.automationRef
          ? {
              ...row,
              label: nameByRef.get(row.automationRef) ?? row.automationName ?? row.automationRef,
            }
          : row,
      ),
    };
  });
  return (
    <PageScroll>
      {state.status === 'loading' ? (
        <PageLoading label="Loading insights…" />
      ) : state.status === 'error' ? (
        <PageEmpty message={`Couldn’t load insights: ${state.error}`} />
      ) : (
        <InsightsScreen summary={state.data} />
      )}
    </PageScroll>
  );
}
