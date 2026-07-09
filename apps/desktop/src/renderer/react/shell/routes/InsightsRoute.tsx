import type { JSX } from 'react';
import { getInsightsSummary } from '../../../gateway-client.js';
import InsightsScreen from '../../screens/InsightsScreen.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';

// React-owned Insights route — the App root renders this for `{ kind: 'insights' }`,
// replacing the vanilla `renderInsights` (app-insights.ts). Gateway I/O moves
// into the effect; the InsightsScreen owns the dashboard exactly as before.
// Insights paints its own header, so PageScroll carries no title.
export default function InsightsRoute(): JSX.Element {
  const state = useAsyncData(() => getInsightsSummary());
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
