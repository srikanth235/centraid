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

export default function AutomationsRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();

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
