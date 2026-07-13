import type { JSX } from 'react';
import {
  getBlocking,
  listAgents,
  listAutomations,
  listOutboxGrants,
} from '../../../gateway-client.js';
import AutomationsOverviewScreen from '../../screens/AutomationsOverviewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { filterConsentForAutomation } from './automationThreadData.js';
import { buildOverviewData, collectAutomationRuns } from './automationsData.js';

// React-owned Automations overview — the fleet (Automations UI revamp, see
// receipts/issue-387-automations-ui-revamp.md). loadData fetches the rows, the run feed, and the
// global consent lists (parked + outbox), soft-matches the latter down to
// each automation's actor via `filterConsentForAutomation` (the same rule
// the thread view uses), and hands `buildOverviewData` a ref → pending-count
// map for the fleet row's attention badge. Navigation goes through the
// ShellActions surface. "New automation" opens the instructions-first editor
// in create mode — no more scaffold-then-builder dance.
export default function AutomationsRoute(): JSX.Element {
  const { navigate } = useShellActions();

  return (
    <PageScroll>
      <AutomationsOverviewScreen
        loadData={async () => {
          const [rows, entries, blocking, grants, agents] = await Promise.all([
            listAutomations(),
            collectAutomationRuns(),
            getBlocking(),
            listOutboxGrants(),
            listAgents(),
          ]);
          const attentionByRef = new Map<string, number>(
            rows.map((row) => {
              const consent = filterConsentForAutomation(
                agents.find((agent) => agent.hostKey === row.ownerApp)?.agentId,
                blocking,
                grants,
              );
              return [row.ref, consent.parked.length + consent.outbox.length];
            }),
          );
          return buildOverviewData(rows, entries, attentionByRef);
        }}
        onBrowseTemplates={() => navigate({ kind: 'templates' })}
        onNewAutomation={() => navigate({ kind: 'automation-editor' })}
        onOpenAutomation={(ref) => navigate({ kind: 'automation-view', automationId: ref })}
        onOpenRun={(automationId, runId) => navigate({ kind: 'run-view', automationId, runId })}
      />
    </PageScroll>
  );
}
