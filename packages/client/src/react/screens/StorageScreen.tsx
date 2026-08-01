import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  LocalUsageReportDTO,
  StorageLimitsDTO,
  StorageLimitsPatchDTO,
} from "../../gateway-client-local-storage.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import LocalFootprintCard from "./LocalFootprintCard.js";
import StorageLimitsPanel from "./StorageLimitsPanel.js";

import styles from "./StorageScreen.module.css";

// Gateway → Storage answers the local-storage questions an owner asks:
//
//   1. What is Centraid using on this machine, and where did it go?
//   2. What ceiling have I put on that, and what happens when I hit it?
//
// Backup custody remains on Gateway → Overview. The folded Storage tab owns
// only local footprint and limits, with independent loading/error state.

export interface StorageScreenProps {
  /** `GET _gateway/storage/local` — the footprint card's source. */
  loadLocalUsage: (opts?: {
    refresh?: boolean;
  }) => Promise<LocalUsageReportDTO>;
  /** `PUT _gateway/storage/limits`. */
  saveStorageLimits: (
    patch: StorageLimitsPatchDTO
  ) => Promise<StorageLimitsDTO>;
}

/** Footprint refresh cadence. Deliberately slower than the backup card's 10s:
 *  these figures come from a directory walk on the gateway, and disk usage
 *  does not move on a ten-second timescale. The gateway's TTL cache makes an
 *  over-eager poll cheap, but there is no reason to make one. */
const FOOTPRINT_POLL_MS = 60_000;

export default function StorageScreen(props: StorageScreenProps): JSX.Element {
  const { loadLocalUsage, saveStorageLimits } = props;
  const [report, setReport] = useState<LocalUsageReportDTO | null>(null);
  const [limits, setLimits] = useState<StorageLimitsDTO | null>(null);
  const [footprintError, setFootprintError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const mountedRef = useRef(true);

  // The local report carries the limits with it, so ONE fetch keeps the
  // footprint card and the limits panel in agreement — a limit shown beside a
  // total it wasn't evaluated against is worse than no limit shown.
  const refresh = useCallback(
    async (opts: { refresh?: boolean } = {}): Promise<void> => {
      try {
        const next = await loadLocalUsage(opts);
        if (!mountedRef.current) return;
        setReport(next);
        setLimits(next.limits);
        setFootprintError(null);
      } catch (error) {
        if (!mountedRef.current) return;
        setFootprintError(
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    [loadLocalUsage]
  );

  useEffect(() => {
    mountedRef.current = true;
    const initialRefresh = setTimeout(() => void refresh(), 0);
    // Suspended while the tab is hidden and caught up on return (issue #659).
    const stop = startVisibilityTicker(() => void refresh(), FOOTPRINT_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearTimeout(initialRefresh);
      stop();
    };
  }, [refresh]);

  const onRescan = (): void => {
    setRescanning(true);
    void refresh({ refresh: true }).finally(() => {
      if (mountedRef.current) setRescanning(false);
    });
  };

  const onSaveLimits = async (patch: StorageLimitsPatchDTO): Promise<void> => {
    const next = await saveStorageLimits(patch);
    if (mountedRef.current) setLimits(next);
    // Re-read rather than patching the cached report locally: the limit
    // EVALUATION (ok / degraded / error) is the gateway's call, not ours.
    await refresh();
  };

  return (
    <div className={styles.grid}>
      <LocalFootprintCard
        report={report}
        loadError={footprintError}
        onRescan={onRescan}
        rescanning={rescanning}
      />

      <StorageLimitsPanel
        limits={limits}
        report={report}
        onSave={onSaveLimits}
      />
    </div>
  );
}
