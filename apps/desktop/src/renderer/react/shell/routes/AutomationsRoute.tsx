import type { JSX } from 'react';
import { createAutomation, listAutomations } from '../../../gateway-client.js';
import AutomationsOverviewScreen from '../../screens/AutomationsOverviewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { buildOverviewData, collectAutomationRuns } from './automationsData.js';

// React-owned Automations overview — replaces the vanilla renderAutomations
// (app-automations.ts). The screen owns loading/error/data + the "View all"
// toggle; loadData fetches the rows + run feed and derives the DTO. Navigation
// goes through the ShellActions surface.
export default function AutomationsRoute(): JSX.Element {
  const { navigate } = useShellActions();

  const onNewAutomation = async (): Promise<void> => {
    // Scaffold a fresh disabled draft, then open the builder on it
    // (vanilla createAndOpenAutomationBuilder). A plain slug id — the
    // app.json#kind, not the id, is the automation signal (#98).
    const id = `automation-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await createAutomation({ id, name: 'New automation', enabled: false });
    } catch (err) {
      console.error('[automations] could not scaffold draft', err);
      return;
    }
    navigate({ kind: 'automation-builder', automationId: id });
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
