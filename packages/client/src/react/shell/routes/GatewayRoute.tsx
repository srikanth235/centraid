import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import {
  getUserPrefs,
  getLocalStorageUsage,
  listGatewayOwners,
  pauseBackgroundWork,
  resumeBackgroundWork,
  saveUserPrefs,
  streamGatewayLogs,
  updateStorageLimits,
} from "../../../gateway-client.js";
import { seat } from "../../host-platform.js";
import GatewayScreen from "../../screens/GatewayScreen.js";
import {
  knobPrefKey,
  parseResourceKnobPrefs,
} from "../../screens/resource-summary.js";
import type {
  ResourceKnobPrefs,
  TunableKnobKey,
} from "../../screens/resource-summary.js";
import {
  parseResourceModePref,
  RESOURCE_MODE_PREF_KEY,
} from "../../screens/ResourceModeCard.js";
import type { ResourceMode } from "../../screens/ResourceModeCard.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { PageLoading } from "../status.js";
import { useGatewayHealth } from "../useGatewayHealth.js";
import { useGatewayRuntime } from "../useGatewayRuntime.js";
import {
  loadConnectionRows,
  loadDiagnosticsData,
} from "./settingsDiagnosticsData.js";
import { startVisibilityTicker } from "./visibility-ticker.js";

// React-owned Gateway route over the main-process heartbeat monitor:
// pushed snapshots (useGatewayRuntime), polled health (useGatewayHealth).
/** Shell-root half of the Connections section — acts only; rows come from
 *  this route's own `loadConnectionRows`. */
export interface GatewayConnectionsProps {
  refreshKey: number;
  onTest: (gatewayId: string, label: string) => void;
  onRename: (gatewayId: string, label: string) => void;
  onRemove: (gatewayId: string, label: string) => void;
}

export default function GatewayRoute({
  initialTab,
  focus,
  cause,
  connections,
}: {
  initialTab?:
    | "overview"
    | "components"
    | "storage"
    | "logs"
    | "alerts"
    | "restart";
  focus?: "backups" | "capacity";
  cause?: "backup-alert";
  /** #665 host plumbing: acts open shell-root-owned modals, so App hands
   *  callbacks down; `refreshKey` bumps once one commits. */
  connections?: GatewayConnectionsProps;
} = {}): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const snapshot = useGatewayRuntime();
  const { health, refresh: refreshHealth } = useGatewayHealth();
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Launch-at-login (#351) isn't in the pushed snapshot — read once on mount.
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [savingLaunchAtLogin, setSavingLaunchAtLogin] = useState(false);

  // 1s uptime ticker, suspended while the tab is hidden (#528 Phase D).
  useEffect(() => startVisibilityTicker(() => setNow(Date.now())), []);

  useEffect(() => {
    let cancelled = false;
    void window.CentraidApi.getSettings().then((s) => {
      if (!cancelled) setLaunchAtLogin(Boolean(s.launchAtLogin));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: {
    gatewayAlertSeconds?: number;
    gatewayAlertsEnabled?: boolean;
  }) => {
    setSaving(true);
    try {
      await window.CentraidApi.saveSettings(patch);
    } catch (error) {
      showToast(
        `Couldn’t save the alert setting: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSaving(false);
    }
  };

  const saveLaunchAtLogin = async (enabled: boolean) => {
    setSavingLaunchAtLogin(true);
    const prev = launchAtLogin;
    setLaunchAtLogin(enabled);
    try {
      await window.CentraidApi.saveSettings({ launchAtLogin: enabled });
    } catch (error) {
      setLaunchAtLogin(prev);
      showToast(
        `Couldn’t save the login setting: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSavingLaunchAtLogin(false);
    }
  };

  // Stable so ResourceModeCard doesn't re-fetch prefs on every tick.
  const loadResourceMode = useCallback(
    async (): Promise<ResourceMode> =>
      parseResourceModePref(await getUserPrefs()),
    []
  );
  const saveResourceMode = useCallback(async (mode: ResourceMode) => {
    await saveUserPrefs({ [RESOURCE_MODE_PREF_KEY]: mode });
  }, []);
  // L3 "Tune" rung knob overrides (#528); stable identities vs the 1s tick.
  const loadKnobPrefs = useCallback(
    async (): Promise<ResourceKnobPrefs> =>
      parseResourceKnobPrefs(await getUserPrefs()),
    []
  );
  const saveKnobPrefs = useCallback(
    async (patch: Partial<Record<TunableKnobKey, number | null>>) => {
      const prefPatch: Record<string, number | null> = {};
      for (const [key, value] of Object.entries(patch)) {
        prefPatch[knobPrefKey(key as TunableKnobKey)] = value ?? null;
      }
      await saveUserPrefs(prefPatch);
    },
    []
  );
  // Pause/resume hot-apply, then nudge health so paused state reconciles.
  const pauseBackground = useCallback(
    async (durationMs?: number) => {
      const res = await pauseBackgroundWork(durationMs);
      refreshHealth();
      return res;
    },
    [refreshHealth]
  );
  const resumeBackground = useCallback(async () => {
    const res = await resumeBackgroundWork();
    refreshHealth();
    return res;
  }, [refreshHealth]);
  // A DRILL-IN IS A HISTORY ENTRY: System pages are ROUTES, not local state
  // under a second back control; `routeKey` keys routes by tab so each is
  // a distinct entry.
  const openTab = useCallback(
    (
      tab: "overview" | "components" | "storage" | "logs" | "alerts" | "restart"
    ) =>
      navigate(
        tab === "overview" ? { kind: "gateway" } : { kind: "gateway", tab }
      ),
    [navigate]
  );

  if (!snapshot) {
    return (
      <PageScroll>
        <PageLoading label="Listening for the gateway heartbeat…" />
      </PageScroll>
    );
  }

  return (
    <PageScroll>
      {/* NO `backup` PROP: System draws no Backups section — offsite backup
          isn't part of v0, and a perpetual nothing-has-run section alarms.
          Restoring it restores one prop. */}
      <GatewayScreen
        snapshot={snapshot}
        now={now}
        savingAlert={saving}
        onAlertSecondsChange={(seconds) =>
          void save({ gatewayAlertSeconds: seconds })
        }
        onAlertsEnabledChange={(enabled) =>
          void save({ gatewayAlertsEnabled: enabled })
        }
        launchAtLogin={launchAtLogin}
        savingLaunchAtLogin={savingLaunchAtLogin}
        onLaunchAtLoginChange={(enabled) => void saveLaunchAtLogin(enabled)}
        health={health}
        loadHealth={loadDiagnosticsData}
        {...(connections
          ? {
              connections: {
                loadConnections: loadConnectionRows,
                onRemove: connections.onRemove,
                onRename: connections.onRename,
                onTest: connections.onTest,
                refreshKey: connections.refreshKey,
              },
            }
          : {})}
        streamLogs={streamGatewayLogs}
        onRestartGateway={() => window.CentraidApi.restartGateway()}
        onExportDiagnostics={() =>
          window.CentraidApi.exportGatewayDiagnostics()
        }
        loadResourceMode={loadResourceMode}
        saveResourceMode={saveResourceMode}
        onPauseBackgroundWork={pauseBackground}
        onResumeBackgroundWork={resumeBackground}
        loadKnobPrefs={loadKnobPrefs}
        saveKnobPrefs={saveKnobPrefs}
        initialTab={initialTab}
        onOpenTab={openTab}
        focus={focus}
        cause={cause}
        loadLocalUsage={getLocalStorageUsage}
        saveStorageLimits={updateStorageLimits}
        loadOwners={listGatewayOwners}
        readOnly={seat() === "viewer"}
      />
    </PageScroll>
  );
}
