import { type JSX, useEffect, useState } from 'react';
import {
  confirmGatewayRecoveryKit,
  createGatewayDeviceTicket,
  getGatewayBackupStatus,
  listGatewayDevices,
  revokeGatewayDevice,
  runGatewayBackupNow,
  verifyGatewayBackupsNow,
  streamGatewayLogs,
} from '../../../gateway-client.js';
import GatewayScreen from '../../screens/GatewayScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { PageLoading } from '../status.js';
import { loadDiagnosticsData } from './settingsDiagnosticsData.js';
import { loadStorageCardStatus } from './gatewayStorageData.js';
import { useGatewayHealth } from '../useGatewayHealth.js';
import { useGatewayRuntime } from '../useGatewayRuntime.js';

// React-owned Gateway route — the runtime page over the main-process
// heartbeat monitor, plus the component-health poll and the log stream
// (folded in as the Components/Logs tabs — see GatewayScreen.tsx). Heartbeat
// data arrives as pushed snapshots (useGatewayRuntime); component health has
// no push channel and is polled (useGatewayHealth). The only writes are the
// down-alert settings, saved through the standard settings surface (main
// clamps + re-broadcasts immediately, so the screen reflects the change on
// the next pushed snapshot). A 1s local ticker drives the running counters
// (gateway uptime, "for 2h 14m") between polls.
export default function GatewayRoute(): JSX.Element {
  const { showToast, navigate } = useShellActions();
  const snapshot = useGatewayRuntime();
  const { health } = useGatewayHealth();
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Launch-at-login (issue #351) isn't part of the pushed runtime snapshot —
  // it's a plain settings field, read once on mount via the generic
  // getSettings() surface (same one saveSettings writes through).
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [savingLaunchAtLogin, setSavingLaunchAtLogin] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.CentraidApi.getSettings().then((s) => {
      if (!cancelled) setLaunchAtLogin(Boolean(s.launchAtLogin));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: { gatewayAlertSeconds?: number; gatewayAlertsEnabled?: boolean }) => {
    setSaving(true);
    try {
      await window.CentraidApi.saveSettings(patch);
    } catch (err) {
      showToast(
        `Couldn’t save the alert setting: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const saveLaunchAtLogin = async (enabled: boolean) => {
    setSavingLaunchAtLogin(true);
    const prev = launchAtLogin;
    setLaunchAtLogin(enabled); // optimistic — matches the alert toggle's feel
    try {
      await window.CentraidApi.saveSettings({ launchAtLogin: enabled });
    } catch (err) {
      setLaunchAtLogin(prev);
      showToast(
        `Couldn’t save the login setting: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSavingLaunchAtLogin(false);
    }
  };

  if (!snapshot) {
    return (
      <PageScroll>
        <PageLoading label="Listening for the gateway heartbeat…" />
      </PageScroll>
    );
  }

  return (
    <PageScroll>
      <GatewayScreen
        snapshot={snapshot}
        now={now}
        savingAlert={saving}
        onAlertSecondsChange={(seconds) => void save({ gatewayAlertSeconds: seconds })}
        onAlertsEnabledChange={(enabled) => void save({ gatewayAlertsEnabled: enabled })}
        launchAtLogin={launchAtLogin}
        savingLaunchAtLogin={savingLaunchAtLogin}
        onLaunchAtLoginChange={(enabled) => void saveLaunchAtLogin(enabled)}
        health={health}
        loadHealth={loadDiagnosticsData}
        streamLogs={streamGatewayLogs}
        loadBackupStatus={getGatewayBackupStatus}
        onRunBackupNow={runGatewayBackupNow}
        onVerifyBackupNow={verifyGatewayBackupsNow}
        onExportRecoveryKit={() => window.CentraidApi.exportGatewayRecoveryKit()}
        onConfirmRecoveryKit={confirmGatewayRecoveryKit}
        loadStorageStatus={loadStorageCardStatus}
        onOpenStorageSettings={() => navigate({ kind: 'settings', page: 'storage' })}
        loadDevices={listGatewayDevices}
        onRevokeDevice={revokeGatewayDevice}
        onCurrentDeviceRevoked={() =>
          import('../../../replica/shell-session.js').then((replica) =>
            replica.purgeCurrentReplicaDevice(),
          )
        }
        onCreateDeviceTicket={createGatewayDeviceTicket}
        onRestartGateway={() => window.CentraidApi.restartGateway()}
        onExportDiagnostics={() => window.CentraidApi.exportGatewayDiagnostics()}
      />
    </PageScroll>
  );
}
