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

// React-owned Gateway route — the runtime page over the main-process
// heartbeat monitor, plus the component-health poll and the log stream
// (folded in as the Components/Logs tabs — see GatewayScreen.tsx). Heartbeat
// data arrives as pushed snapshots (useGatewayRuntime); component health has
// no push channel and is polled (useGatewayHealth). The only writes are the
// down-alert settings, saved through the standard settings surface (main
// clamps + re-broadcasts immediately, so the screen reflects the change on
// the next pushed snapshot). A 1s local ticker drives the running counters
// (gateway uptime, "for 2h 14m") between polls.
/** The shell-root half of the Connections section — just the acts; the rows
 *  come from this route's own `loadConnectionRows`. */
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
  /** Host plumbing for the Components tab's Connections section (issue #665).
   *  The three acts open modals the shell root owns (they must sit above every
   *  page), so App hands the callbacks down rather than this route wiring
   *  them; `refreshKey` is bumped once one commits so the list re-reads. */
  connections?: GatewayConnectionsProps;
} = {}): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const snapshot = useGatewayRuntime();
  const { health, refresh: refreshHealth } = useGatewayHealth();
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Launch-at-login (issue #351) isn't part of the pushed runtime snapshot —
  // it's a plain settings field, read once on mount via the generic
  // getSettings() surface (same one saveSettings writes through).
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [savingLaunchAtLogin, setSavingLaunchAtLogin] = useState(false);

  // 1s uptime ticker, suspended while the tab is hidden (issue #528 Phase D
  // wakeup hygiene) so a backgrounded window stops waking the machine.
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
    setLaunchAtLogin(enabled); // optimistic — matches the alert toggle's feel
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

  // Stable identity so ResourceModeCard does not re-fetch prefs on every
  // 1s uptime tick (or any other parent re-render).
  const loadResourceMode = useCallback(
    async (): Promise<ResourceMode> =>
      parseResourceModePref(await getUserPrefs()),
    []
  );
  const saveResourceMode = useCallback(async (mode: ResourceMode) => {
    await saveUserPrefs({ [RESOURCE_MODE_PREF_KEY]: mode });
  }, []);
  // L3 "Tune" rung knob overrides (issue #528 Phase F) — plain prefs read/write.
  // Stable identities so the 1s uptime tick doesn't re-fetch or re-create them.
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
  // Pause/resume hot-apply, then nudge the health poll so the paused state
  // reconciles quickly. Stable identities (same discipline as loadResourceMode)
  // so the 1s uptime tick doesn't re-create the callbacks.
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
  // A DRILL-IN IS A HISTORY ENTRY. System's pages are ROUTES, not local state
  // under a "‹ System · Back" row drawn at the top of each one — that row is a
  // second back control sitting under the frame's own back arrow and pointing
  // at the same place. Routed, the arrow already works and a page can be
  // deep-linked.
  // `routeKey` keys gateway routes by tab, so each is a distinct entry rather
  // than a repeat of the one before it.
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
      {/* NO `backup` PROP, so System draws no Backups section. Offsite backup
          is not part of v0, and a section that states "no backup has ever run
          · nothing has been copied off this machine" on every gateway is an
          alarm about a feature that has not shipped. `BackupCard` and its
          gateway calls are intact; restoring the section is restoring one
          prop. */}
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
