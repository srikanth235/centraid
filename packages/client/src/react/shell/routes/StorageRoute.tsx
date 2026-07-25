import { type JSX, useCallback, useEffect, useState } from 'react';
import {
  confirmGatewayRecoveryKit,
  getGatewayBackupStatus,
  getLocalStorageUsage,
  runGatewayBackupNow,
  updateGatewayBackupPolicy,
  updateStorageLimits,
  verifyGatewayBackupBucket,
  verifyGatewayBackupsNow,
  streamStorageCustody,
} from '../../../gateway-client.js';
import StorageScreen from '../../screens/StorageScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { loadStorageUsageAggregate } from './gatewayStorageData.js';

// React-owned Storage route (issue #544 — this was BackupsRoute). Local
// footprint, the owner's limits, and the offsite snapshot custody that used
// to be the whole page. Every card fetches its own status over plain HTTP and
// renders its own loading/error state, so unlike GatewayRoute there is NO
// snapshot gate here: Storage has nothing to do with the main-process
// heartbeat monitor, and blocking on `useGatewayRuntime()` would leave the
// page blank whenever the heartbeat is merely late — for a page whose whole
// job is reassurance about durability, "we can't even tell you" is the worst
// possible first paint. The only thing the route owns is the 1s ticker
// driving the backup card's relative ages ("verified 4m ago"), same as
// GatewayRoute.
export default function StorageRoute(): JSX.Element {
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
      title="Storage"
      subtitle="What Centraid is using on this machine, the limits you've set, and where your bytes actually live."
    >
      <StorageScreen
        now={now}
        loadLocalUsage={getLocalStorageUsage}
        saveStorageLimits={updateStorageLimits}
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
