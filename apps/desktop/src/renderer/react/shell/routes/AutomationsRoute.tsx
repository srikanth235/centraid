import type { JSX } from 'react';
import { listAutomations } from '../../../gateway-client.js';
import AutomationsOverviewScreen from '../../screens/AutomationsOverviewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { buildOverviewData, collectAutomationRuns, scaffoldAutomationDraft } from './automationsData.js';

// React-owned Automations overview — replaces the vanilla renderAutomations
// (app-automations.ts). The screen owns loading/error/data + the "View all"
// toggle; loadData fetches the rows + run feed and derives the DTO. Navigation
// goes through the ShellActions surface.
export default function AutomationsRoute(): JSX.Element {
  const { navigate } = useShellActions();

  const onNewAutomation = async (): Promise<void> => {
    try {
      const id = await scaffoldAutomationDraft();
      navigate({ kind: 'automation-builder', automationId: id });
    } catch (err) {
      console.error('[automations] could not scaffold draft', err);
    }
  };

  return (
    <PageScroll>
      <AutomationsOverviewScreen
        loadData={async () => {
          const [rows, entries] = await Promise.all([listAutomations(), collectAutomationRuns()]);
          return buildOverviewData(rows, entries);
        }}
        onBrowseTemplates={() => navigate({ kind: 'templates' })}
        onNewAutomation={() => void onNewAutomation()}
        onOpenAutomation={(ref) => navigate({ kind: 'automation-view', automationId: ref })}
        onOpenRun={(automationId, runId) => navigate({ kind: 'run-view', automationId, runId })}
      />
    </PageScroll>
  );
}
