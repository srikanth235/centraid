// Insights route — usage analytics dashboard bound to the unified run ledger
// via the `getInsightsSummary` IPC (issue #90). Token consumption, spend, and
// per-source / per-model breakdowns over a trailing 30-day window.
//
// Extracted from app.ts. Self-contained: it reaches the shell only through the
// render primitives on ShellContext (el, clear, pageScroll, mountShellPage,
// recordRoute, registerCleanup, renderSimpleEmpty). Gateway I/O stays vanilla;
// the React InsightsScreen owns the whole dashboard.
import { getInsightsSummary } from './gateway-client.js';
import { requireReactBridge } from './react/bridge.js';
import type { ShellContext } from './app-shell-context.js';

export interface InsightsModule {
  renderInsights(): void;
}

export function createInsightsModule(ctx: ShellContext): InsightsModule {
  const { el, clear, pageScroll, mountShellPage, recordRoute, registerCleanup, renderSimpleEmpty } =
    ctx;

  function renderInsights(): void {
    void renderInsightsAsync();
  }

  async function renderInsightsAsync(): Promise<void> {
    recordRoute({ kind: 'insights' });
    clear();
    const { main, scroll } = pageScroll('', '');
    // pageScroll seeds an empty cd-page-head; the Insights page owns its
    // own header treatment, so drop it.
    scroll.replaceChildren();

    // Fetch the summary here (gateway I/O stays vanilla) and render the whole
    // dashboard via the React InsightsScreen.
    const host = el('div');
    scroll.append(host);
    host.append(el('div', { class: 'cd-au-loading' }, 'Loading insights…'));
    mountShellPage('insights', main);

    let summary: CentraidInsightsSummary;
    try {
      summary = await getInsightsSummary();
    } catch (err) {
      if (!document.contains(host)) return;
      host.replaceChildren(
        renderSimpleEmpty(
          `Couldn’t load insights: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    // The user may have navigated away while the IPC was in flight.
    if (!document.contains(host)) return;
    host.replaceChildren();
    registerCleanup(requireReactBridge().mountInsights(host, { summary }));
  }

  return { renderInsights };
}
