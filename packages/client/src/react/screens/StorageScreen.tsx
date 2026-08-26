import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  LocalUsageReportDTO,
  StorageLimitsDTO,
  StorageLimitsPatchDTO,
} from "../../gateway-client-local-storage.js";
import type { GatewayOwner } from "../../gateway-client-owners.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import SectionBlock from "../ui/SectionBlock.js";
import LocalFootprintCard from "./LocalFootprintCard.js";
import { footprintScale, formatBytes } from "./localUsageView.js";
import StorageLimitsPanel from "./StorageLimitsPanel.js";
import VaultFootprintRows from "./VaultFootprintRows.js";

import styles from "./StorageScreen.module.css";

export interface StorageScreenProps {
  loadLocalUsage: (opts?: {
    refresh?: boolean;
  }) => Promise<LocalUsageReportDTO>;
  /** `PUT _gateway/storage/limits`. */
  saveStorageLimits: (
    patch: StorageLimitsPatchDTO
  ) => Promise<StorageLimitsDTO>;
  /** `GET _gateway/owners` (#726); optional. */
  loadOwners?: () => Promise<GatewayOwner[]>;
  /** Serving machine, named when a read-only seat's rows withhold verbs. */
  gatewayLabel?: string;
  readOnly?: boolean;
}

/** Slower than backup's 10s poll: figures come from a directory walk. */
const FOOTPRINT_POLL_MS = 60_000;

export default function StorageScreen(props: StorageScreenProps): JSX.Element {
  const { loadLocalUsage, saveStorageLimits, loadOwners } = props;
  const [report, setReport] = useState<LocalUsageReportDTO | null>(null);
  const [limits, setLimits] = useState<StorageLimitsDTO | null>(null);
  const [footprintError, setFootprintError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [ownerLabels, setOwnerLabels] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const mountedRef = useRef(true);

  // The report carries the limits: ONE fetch keeps card and panel in agreement.
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
      // Roster failure isn't fatal: rows render without "(owner)" suffixes.
      void loadOwners?.()
        .then((owners) => {
          if (!mountedRef.current) return;
          setOwnerLabels(
            new Map(
              owners.flatMap((owner) =>
                owner.vaults.map(
                  (vault) => [vault.vaultId, owner.label] as const
                )
              )
            )
          );
        })
        .catch(() => undefined);
    },
    [loadLocalUsage, loadOwners]
  );

  useEffect(() => {
    mountedRef.current = true;
    const initialRefresh = setTimeout(() => void refresh(), 0);
    // Suspended while hidden (#659).
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
    // Re-read rather than patching: limit EVALUATION is the gateway's call.
    await refresh();
  };

  const scale = report ? footprintScale(report) : null;
  const capacityMeta = ((): string => {
    if (report === null) return "measuring";
    if (scale !== null && scale.againstBytes !== null)
      return `${formatBytes(report.totalBytes)} of ${formatBytes(scale.againstBytes)}`;
    return formatBytes(report.totalBytes);
  })();

  return (
    <div className={styles.grid}>
      {/* Rescan re-measures everything below, not any single row. */}
      <SectionBlock
        label="Capacity"
        meta={capacityMeta}
        {...(props.readOnly
          ? {}
          : {
              action: {
                hint: "Walk the disk and recount",
                label: rescanning ? "Measuring…" : "Rescan",
                onClick: onRescan,
                ...(rescanning || !report ? { off: true } : {}),
              },
            })}
      />
      <LocalFootprintCard
        report={report}
        loadError={footprintError}
        rescanning={rescanning}
      />

      {/* Three shapes for three questions: fullness (rail vs ceiling),
          ownership (ordered rows), limits (editable rows). */}
      {report ? (
        <VaultFootprintRows report={report} ownerLabels={ownerLabels} />
      ) : null}

      <StorageLimitsPanel
        limits={limits}
        report={report}
        onSave={onSaveLimits}
        {...(props.gatewayLabel ? { gatewayLabel: props.gatewayLabel } : {})}
        readOnly={props.readOnly}
      />
    </div>
  );
}
