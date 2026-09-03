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
