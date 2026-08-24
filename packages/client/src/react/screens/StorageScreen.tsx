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
  /**
   * `GET _gateway/owners` (#726) — joined client-side onto the
   * footprint's per-vault rows so the gateway owner sees what hosting each
   * vault costs, and for whom. Optional so a host with no owner surface (or
   * a test) still renders the footprint, unlabeled.
   */
  loadOwners?: () => Promise<GatewayOwner[]>;
  /** The machine serving this gateway — named by a read-only seat's rows when
   *  they withhold a verb, so "no control" reads as "not from here". */
  gatewayLabel?: string;
  readOnly?: boolean;
}

/** Footprint refresh cadence. Deliberately slower than the backup card's 10s:
 *  these figures come from a directory walk on the gateway, and disk usage
 *  does not move on a ten-second timescale. The gateway's TTL cache makes an
 *  over-eager poll cheap, but there is no reason to make one. */
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
      // A roster the gateway won't serve is not fatal: the footprint still
      // renders, just without the "(owner)" suffix on each vault line.
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
    // Suspended while the tab is hidden and caught up on return (#659).
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

  // THE HEAD CARRIES THE ANSWER, THE ROWS CARRY THE DETAIL (binding layer v11).
  // "Capacity · 8.2 GB of 512 GB" is the whole question most people arrive
  // with, so it is stated on the section head rather than inside the card. The
  // scale is the owner's budget when they set one and the disk otherwise —
  // `footprintScale` owns that choice, and it is not re-decided here.
  const scale = report ? footprintScale(report) : null;
  const capacityMeta = ((): string => {
    if (report === null) return "measuring";
    if (scale !== null && scale.againstBytes !== null)
      return `${formatBytes(report.totalBytes)} of ${formatBytes(scale.againstBytes)}`;
    return formatBytes(report.totalBytes);
  })();

  return (
    <div className={styles.grid}>
      {/* The head sits above the container, over its own hairline, and carries
          the one verb this stretch has: a rescan is a re-measure of everything
          below it, not of any single row. */}
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

      {/* THREE DIFFERENT SHAPES, because there are three different questions:
          how full is the machine (a rail against a ceiling), whose bytes those
          are (rows that can be ordered against each other), and where the two
          lines are (rows that can be changed). A section whose every block is
          the same block answers the first question three times. */}
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
