import { useCallback, useEffect, useMemo } from "react";
import type { JSX } from "react";

import SettingsConnectionsScreen from "../../screens/SettingsConnectionsScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../routeVitals.js";
import type {
  RouteHealth,
  RouteVerbs,
  RouteVitalsInput,
} from "../routeVitals.js";
import {
  beginConnectionAuthorize,
  completeAssistReturnLink,
  installSyncForConnection,
  loadAttachedSyncsData,
  loadConnectionProvidersData,
  loadConnectionsData,
  loadLinkedSyncsForConnection,
  loadOAuthCallbackUri,
  makeDetachConnection,
  submitConnectionForm,
  updateConnectionStatus,
} from "./settingsConnectionsData.js";

// First-class Connectors surface — vault data-source OAuth / API connections
// (Gmail, Calendar, GitHub, …). Promoted from Settings → Account → Connections
// so the catalog sits next to Automations in the sidebar. Gateway I/O stays in
// settingsConnectionsData.ts; this route owns action wiring and the frame's two
// channels (#765): the app bar's count line + state, and the status line's one
// health sentence.
//
// The screen reads its own data (the OAuth ceremony it drives is a sequence of
// writes and re-reads, not one query), so it REPORTS what it just read and this
// route publishes it. Publishing stays here because the frame renders above the
// outlet: what reaches the bar is the route's business, and a screen that wrote
// to the bar directly would be a second place to look when the bar is wrong.

export default function ConnectorsRoute(): JSX.Element {
  const { showToast, confirm } = useShellActions();
  const detachConnection = useMemo(
    () => makeDetachConnection(confirm),
    [confirm]
  );

  const onSignals = useCallback(
    (input: RouteVitalsInput & { health?: RouteHealth }): void => {
      publishRouteSignals("connectors", { ...input, tone: "net" });
    },
    []
  );
  const onVerbs = useCallback((verbs: RouteVerbs): void => {
    publishRouteVerbs("connectors", verbs);
  }, []);
  // Both channels drop together on the way out — a status line still naming a
  // lapsed Gmail on the page after it is the frame lying about where you are.
  useEffect(() => () => clearRouteSignals("connectors"), []);

  return (
    <PageScroll>
      <SettingsConnectionsScreen
        loadConnections={loadConnectionsData}
        loadProviders={loadConnectionProvidersData}
        configureConnection={submitConnectionForm}
        setConnectionStatus={updateConnectionStatus}
        detachConnection={detachConnection}
        beginAuthorize={beginConnectionAuthorize}
        completeAssistReturnLink={completeAssistReturnLink}
        showToast={showToast}
        loadLinkedSyncs={loadLinkedSyncsForConnection}
        loadAttachedSyncs={loadAttachedSyncsData}
        installSync={installSyncForConnection}
        loadOAuthCallbackUri={loadOAuthCallbackUri}
        onSignals={onSignals}
        onVerbs={onVerbs}
      />
    </PageScroll>
  );
}
