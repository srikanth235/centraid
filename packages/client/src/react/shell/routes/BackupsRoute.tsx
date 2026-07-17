import { type JSX, useCallback, useEffect, useState } from 'react';
import {
  confirmGatewayRecoveryKit,
  getGatewayBackupStatus,
  runGatewayBackupNow,
  updateGatewayBackupPolicy,
  verifyGatewayBackupBucket,
  verifyGatewayBackupsNow,
  streamStorageCustody,
} from '../../../gateway-client.js';
import BackupsScreen from '../../screens/BackupsScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { loadStorageUsageAggregate } from './gatewayStorageData.js';

// React-owned Backups route — snapshot custody and the remote bytes behind
// it, split out of the Gateway page (which stays the runtime instrument
// panel). Both cards fetch their own status over plain HTTP and render their
// own loading/error states, so unlike GatewayRoute there is NO snapshot gate
// here: Backups has nothing to do with the main-process heartbeat monitor, and
// blocking on `useGatewayRuntime()` would leave the page blank whenever the
// heartbeat is merely late — for a page whose whole job is reassurance about
// durability, "we can't even tell you" is the worst possible first paint. The
// only thing the route owns is the 1s ticker driving the cards' relative ages
// ("verified 4m ago"), same as GatewayRoute.
export default function BackupsRoute(): JSX.Element {
  const { navigate } = useShellActions();
  const [now, setNow] = useState(() => Date.now());
  const streamBackupCustody = useCallback(
    (onChange: () => void, signal: AbortSignal) => streamStorageCustody(onChange, signal),
    [],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <PageScroll
      title="Backups"
      subtitle="Offsite snapshots, retention, and where your bytes actually live."
    >
      <BackupsScreen
        now={now}
        loadBackupStatus={getGatewayBackupStatus}
        streamBackupCustody={streamBackupCustody}
        onRunBackupNow={runGatewayBackupNow}
        onVerifyBackupNow={verifyGatewayBackupsNow}
        onUpdateBackupPolicy={updateGatewayBackupPolicy}
        onVerifyBackupBucket={verifyGatewayBackupBucket}
        onExportRecoveryKit={() => window.CentraidApi.exportGatewayRecoveryKit()}
        onConfirmRecoveryKit={confirmGatewayRecoveryKit}
        loadStorageUsage={loadStorageUsageAggregate}
        onOpenStorageSettings={() => navigate({ kind: 'settings', page: 'storage' })}
      />
    </PageScroll>
  );
}
