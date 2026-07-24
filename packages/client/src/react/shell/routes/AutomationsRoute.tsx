import { useCallback, type JSX } from 'react';
import AutomationsOverviewScreen from '../../screens/AutomationsOverviewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { adoptOverviewSuggestion, loadAutomationsOverviewData } from './automationsOverviewLoad.js';
import { loadOverviewSuggestions } from './templatesData.js';

// React-owned Automations overview — the fleet (Automations UI revamp, see
// receipts/issue-387-automations-ui-revamp.md). loadData fetches the rows, the run feed, and the
// global consent lists (parked + outbox), soft-matches the latter down to
// each automation's actor via `filterConsentForAutomation` (the same rule
// the thread view uses), and hands `buildOverviewData` a ref → pending-count
// map for the fleet row's attention badge. Navigation goes through the
// ShellActions surface. "New automation" opens the instructions-first editor
// in create mode — no more scaffold-then-builder dance. Empty-state suggestions
// adopt via the same clone path as Templates.
export default function AutomationsRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();

  // Stable identity: AutomationsOverviewScreen mounts a load effect from
  // loadData; an inline async would re-fire on every shell re-render and thrash
  // the error/Retry UI (desktop e2e 8.2). Body lives in automationsOverviewLoad.
  const loadData = useCallback(() => loadAutomationsOverviewData(), []);

  const useSuggestion = useCallback(
    (templateId: string): void => {
      void adoptOverviewSuggestion(templateId, { navigate, showToast });
    },
    [navigate, showToast],
  );

  return (
    <PageScroll>
      <AutomationsOverviewScreen
        loadData={loadData}
        loadSuggestions={loadOverviewSuggestions}
        onBrowseTemplates={() => navigate({ kind: 'templates' })}
        onNewAutomation={() => navigate({ kind: 'automation-editor' })}
        onOpenAutomation={(ref) => navigate({ kind: 'automation-view', automationId: ref })}
        onOpenRun={(automationId, runId) => navigate({ kind: 'run-view', automationId, runId })}
        onUseSuggestion={useSuggestion}
      />
    </PageScroll>
  );
}
