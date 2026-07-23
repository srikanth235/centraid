import { useState, type JSX } from 'react';
import { getGatewayHealth, getInsightsSummary, listAutomations } from '../../../gateway-client.js';
import InsightsScreen from '../../screens/InsightsScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';

// Insights route (#514): fetches summary for a chosen window, resolves
// automation display names from the live list, deep-links automation runs.

export default function InsightsRoute(): JSX.Element {
  const { navigate } = useShellActions();
  const [windowDays, setWindowDays] = useState(30);

  const state = useAsyncData(async () => {
    // Health carries the optional resource receipt (#528 Phase C); its failure
    // must never break Insights, so it resolves to null on any error.
    const [summary, automations, health] = await Promise.all([
      getInsightsSummary({ windowDays }),
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
      getGatewayHealth().catch(() => null),
    ]);
    const nameByRef = new Map(automations.map((a) => [a.ref, a.name]));
    return {
      resourceUsage: health?.metrics?.resourceUsage,
      ...summary,
      bySource: summary.bySource.map((row) =>
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
  }, [windowDays]);

  return (
    <PageScroll>
      {state.status === 'loading' ? (
        <PageLoading label="Loading insights…" />
      ) : state.status === 'error' ? (
        <PageEmpty message={`Couldn’t load insights: ${state.error}`} />
      ) : (
        <InsightsScreen
          summary={state.data}
          resourceUsage={state.data.resourceUsage}
          windowDays={windowDays}
          onWindowDays={setWindowDays}
          onOpenRun={(automationId, runId) => navigate({ kind: 'run-view', automationId, runId })}
        />
      )}
    </PageScroll>
  );
}
