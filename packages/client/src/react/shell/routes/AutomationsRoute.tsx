import { useCallback, useEffect } from "react";
import type { JSX } from "react";

import AutomationsOverviewScreen from "../../screens/AutomationsOverviewScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { clearRouteSignals, publishRouteVerbs } from "../routeVitals.js";
import {
  adoptOverviewSuggestion,
  loadAutomationsOverviewData,
} from "./automationsOverviewLoad.js";
import { loadOverviewSuggestions } from "./templatesData.js";

// The Automations overview — the fleet (#387). loadData fetches the rows, the
// run feed, and the global consent lists (parked + outbox), soft-matches the
// latter down to each automation's actor via `filterConsentForAutomation` (the
// same rule the thread view uses), and hands `buildOverviewData` a ref →
// pending-count map for the row's attention clause. Navigation goes through the
// ShellActions surface. Empty-state suggestions adopt via the same clone path
// as Templates.
//
// The page's two verbs live in the app bar (#765): the filled commit
// "New automation" opens the instructions-first editor in create mode, and the
// quiet "Templates" opens the catalogue. `App.tsx` carries the same two
// navigations as its shell-level fallback, but the route publishes its own so
// the handlers are resolved where the route's nav surface actually is — and so
// a future verb that needs state only this route owns has somewhere to go.
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
    [navigate, showToast]
  );

  const browseTemplates = useCallback(
    () => navigate({ kind: "templates" }),
    [navigate]
  );
  const openAutomation = useCallback(
    (ref: string) => navigate({ automationId: ref, kind: "automation-view" }),
    [navigate]
  );
  const openRun = useCallback(
    (automationId: string, runId: string) =>
      navigate({ automationId, kind: "run-view", runId }),
    [navigate]
  );
  const newAutomation = useCallback(
    () => navigate({ kind: "automation-editor" }),
    [navigate]
  );

  // Handlers only — the verbs' LABELS are static (`opsBar.ts`), so the bar
  // never waits on this to know what it says. Deps are stable callbacks: a
  // fresh object per render would wake the bar's store on every render, and the
  // bar renders above this route.
  useEffect(() => {
    publishRouteVerbs("automations", {
      onCommit: newAutomation,
      onSecondary: browseTemplates,
    });
    return () => clearRouteSignals("automations");
  }, [newAutomation, browseTemplates]);

  return (
    <PageScroll>
      <AutomationsOverviewScreen
        loadData={loadData}
        loadSuggestions={loadOverviewSuggestions}
        onBrowseTemplates={browseTemplates}
        onOpenAutomation={openAutomation}
        onOpenRun={openRun}
        onUseSuggestion={useSuggestion}
      />
    </PageScroll>
  );
}
