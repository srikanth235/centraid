import { type JSX, useEffect, useState } from 'react';
import { streamGatewayLogs } from '../../../gateway-client.js';
import GatewayScreen from '../../screens/GatewayScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { PageLoading } from '../status.js';
import { loadDiagnosticsData } from './settingsDiagnosticsData.js';
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
  const { showToast } = useShellActions();
  const snapshot = useGatewayRuntime();
  const { health } = useGatewayHealth();
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
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
        health={health}
        loadHealth={loadDiagnosticsData}
        streamLogs={streamGatewayLogs}
      />
    </PageScroll>
  );
}
