import { type JSX, useMemo } from 'react';
import SettingsConnectionsScreen from '../../screens/SettingsConnectionsScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import {
  beginConnectionAuthorize,
  completeAssistReturnLink,
  installSyncForConnection,
  loadConnectionProvidersData,
  loadConnectionsData,
  loadLinkedSyncsForConnection,
  loadOAuthCallbackUri,
  makeDetachConnection,
  submitConnectionForm,
  updateConnectionStatus,
} from './settingsConnectionsData.js';

// First-class Connectors surface — vault data-source OAuth / API connections
// (Gmail, Calendar, GitHub, …). Promoted from Settings → Account → Connections
// so the catalog sits next to Automations in the sidebar. Gateway I/O stays in
// settingsConnectionsData.ts; this route only owns chrome + action wiring.

export default function ConnectorsRoute(): JSX.Element {
  const { showToast, confirm } = useShellActions();
  const detachConnection = useMemo(() => makeDetachConnection(confirm), [confirm]);

  // Title / New Connector / search live on the screen (gallery chrome).
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
        installSync={installSyncForConnection}
        loadOAuthCallbackUri={loadOAuthCallbackUri}
      />
    </PageScroll>
  );
}
