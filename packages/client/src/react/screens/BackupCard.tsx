import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type { CentraidGatewayDevice } from "../../gateway-client-devices.js";
import type { GatewayHomeDiscoveryDTO } from "../../gateway-client.js";
import type { UsageInput } from "../../storage-metrics.js";
import { formatDuration } from "../shell/routes/gatewayData.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import SectionBlock from "../ui/SectionBlock.js";
import BackupCopyCards from "./BackupCopyCards.js";
import BackupDeviceList from "./BackupDeviceList.js";
import BackupHealthMetrics, { ClockLine } from "./BackupHealthMetrics.js";
import BackupInventoryPanel from "./BackupInventoryPanel.js";
import type {
  BackupReconciliationDTO,
  ProviderPolicyStatusDTO,
} from "./BackupInventoryPanel.js";
import BackupLossSummary from "./BackupLossSummary.js";
import { computeStorageMetrics, deriveLossSummary } from "./backupMetrics.js";
import BackupPolicyPanel from "./BackupPolicyPanel.js";
import type {
  BackupDestinationDTO,
  BackupPolicyDTO,
  BackupPolicyPatchDTO,
} from "./BackupPolicyPanel.js";
import BackupSummaryRows from "./BackupSummaryRows.js";
import RecoveryKitGate from "./RecoveryKitGate.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./BackupCard.module.css";
import gwStyles from "./GatewayScreen.module.css";

// Gateway → Backups: the owner surface over the offsite backup engine. This
// card now renders EXACTLY the five metrics of the §6 contract (#436)
// via `BackupHealthMetrics` — Freshness, Recovery window, Privacy, Cost, Exit —
// computed ONCE from `computeStorageMetrics`. Everything that is not one of
// the five (the raw custody clocks, the manual back-up/verify triggers,
// per-vault policy + the provider inventory) lives behind the collapsed
// "Diagnostics" disclosure. The recovery-kit
// gate stays on the primary surface: it is Privacy/Exit-adjacent and blocking-
// critical — losing the seal key makes every offsite byte unrecoverable.

export interface BackupVaultStatusDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastWalDrainAt?: string;
  lastError?: string;
  running?: boolean;
  /** Required on the v0 wire; optional here so a loading fixture can stay terse. */
  policy?: BackupPolicyDTO;
  destination?: BackupDestinationDTO;
  pendingOffsite?: { count: number; bytes: number };
  providerPolicy?: ProviderPolicyStatusDTO;
  reconciliation?: BackupReconciliationDTO;
}

export interface RecoveryKitStatusDTO {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

export interface BackupStatusDTO {
  configured: boolean;
  provider?: string;
  vaults: BackupVaultStatusDTO[];
  /** Optional so a pre-wave-4 fixture / stub still type-checks; treated as
   *  "never confirmed" when absent. */
  recoveryKit?: RecoveryKitStatusDTO;
  /** Provider-declared retention + restore-egress promises (#436) — feeds
   *  the Recovery-window and Exit metrics. Absent ⇒ those degrade to neutral. */
  home?: GatewayHomeDiscoveryDTO;
}

export interface BackupCardProps {
  /** Live clock (parent ticks it) — drives the humanized ages. */
  now: number;
  loadStatus: () => Promise<BackupStatusDTO>;
  /** Aggregate provider-reported usage (the Cost metric's source) — `null`
   *  before the first poll. */
  loadUsage?: () => Promise<UsageInput | null>;
  streamCustody?: (onChange: () => void, signal: AbortSignal) => Promise<void>;
  onRunNow: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  onVerifyNow?: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  onUpdatePolicy?: (
    vaultId: string,
    patch: BackupPolicyPatchDTO
  ) => Promise<{ policy: BackupPolicyDTO }>;
  onVerifyBucket?: (
    vaultId: string
  ) => Promise<{ vaultId: string; reconciliation: BackupReconciliationDTO }>;
  onExportRecoveryKit?: (input: {
    password: string;
  }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  /** Verifies the re-selected wrapped file, password, and explicit loss consent. */
  onConfirmRecoveryKit: (input: {
    kit: unknown;
    password: string;
    lossConsent: true;
  }) => Promise<{ confirmedAt: number }>;
  /** Optional setup destination for hosts that expose backup configuration. */
  onOpenSettings?: () => void;
  /** The paired-device roster (#708 A2's device list) — absent only
   *  when a caller has no device plane to offer (older embed). */
  loadDevices?: () => Promise<CentraidGatewayDevice[]>;
  /**
   * Restore from an offsite copy. Absent today on every host — restore is
   * still a gateway-side/CLI recovery act (docs/recovery/backup-restore.md),
   * not a wired client action — so the control renders disabled with that
   * reason rather than being hidden (#708 A2: never buried).
   */
  onRestore?: () => void;
  readOnly?: boolean;
}

/** Regular refresh cadence — matches useGatewayHealth's poll order of
 *  magnitude; a manual refresh also fires right after "Back up now". */
const POLL_MS = 10_000;
/** A short follow-up poll after triggering a run — local backups of a
 *  small vault often land well inside this window. */
const FOLLOWUP_MS = 1500;

function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "never";
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

const DEFAULT_POLICY: BackupPolicyDTO = {
  rpoSeconds: 60,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  outboxBudgetBytes: 512 * 1024 ** 2,
  reservedHeadroomBytes: 256 * 1024 ** 2,
  walBaseRollBytes: 16 * 1024 ** 2,
  walBaseRollHours: 24,
};

/** One diagnostic custody clock as a plain labelled age. */
function VaultRow({
  vault,
  now,
  provider,
  onUpdatePolicy,
  onVerifyBucket,
}: {
  vault: BackupVaultStatusDTO;
  now: number;
  provider?: string;
  onUpdatePolicy?: BackupCardProps["onUpdatePolicy"];
  onVerifyBucket?: BackupCardProps["onVerifyBucket"];
}): JSX.Element {
  const neverBackedUp = !vault.lastBackupAt;
  const destination = vault.destination ?? { kind: "gateway-local" as const };
  const hasRemoteInventory =
    destination.kind !== "gateway-local" ||
    provider !== undefined ||
    vault.providerPolicy !== undefined ||
    vault.reconciliation !== undefined;
  return (
    <div className={styles.vaultRow} data-testid="backup-vault-row">
      <div className={styles.vaultHead}>
        <span className={styles.vaultName}>{vault.name ?? vault.vaultId}</span>
        {vault.running ? (
          <span className={styles.runningBadge}>backing up…</span>
        ) : null}
      </div>
      <div className={styles.vaultMeta}>
        <span data-emphasis={neverBackedUp ? "warn" : undefined}>
          backed up {ageLabel(vault.lastBackupAt, now)}
        </span>
        <span>verified {ageLabel(vault.lastVerifyAt, now)}</span>
      </div>
      {vault.lastError ? (
        <div className={styles.vaultError}>{vault.lastError}</div>
      ) : null}
      <BackupPolicyPanel
        vaultId={vault.vaultId}
        now={now}
        policy={vault.policy ?? DEFAULT_POLICY}
        destination={destination}
        snapshotProvider={provider}
        pendingOffsite={vault.pendingOffsite ?? { count: 0, bytes: 0 }}
        lastWalDrainAt={vault.lastWalDrainAt}
        onUpdate={onUpdatePolicy}
      />
      {hasRemoteInventory ? (
        <BackupInventoryPanel
          vaultId={vault.vaultId}
          now={now}
          providerPolicy={vault.providerPolicy}
          reconciliation={vault.reconciliation}
          onVerifyBucket={onVerifyBucket}
        />
      ) : null}
    </div>
  );
}

export default function BackupCard({
  now,
  loadStatus,
  loadUsage,
  streamCustody,
  onRunNow,
  onVerifyNow,
  onUpdatePolicy,
  onVerifyBucket,
  onExportRecoveryKit,
  onConfirmRecoveryKit,
  onOpenSettings,
  loadDevices,
  onRestore,
  readOnly,
}: BackupCardProps): JSX.Element {
  const [status, setStatus] = useState<BackupStatusDTO | null>(null);
  const [usage, setUsage] = useState<UsageInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Guards the two async setState paths (the interval poll and the
  // post-run follow-up) against firing after unmount — the follow-up in
  // particular is a bare `setTimeout` outside the effect below, so it
  // needs its own cleanup rather than relying on an effect's teardown.
  const mountedRef = useRef(true);
  const followupTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  const refresh = useCallback((): void => {
    loadStatus()
      .then((s) => {
        if (!mountedRef.current) return;
        setStatus(s);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    if (loadUsage) {
      loadUsage()
        .then((u) => {
          if (mountedRef.current) setUsage(u);
        })
        .catch(() => {
          // Usage is best-effort — the Cost metric falls back to unmetered/zero.
        });
    }
  }, [loadStatus, loadUsage]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // Suspended while the tab is hidden and caught up on return (#659).
    const stop = startVisibilityTicker(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      stop();
      if (followupTimerRef.current !== undefined)
        clearTimeout(followupTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!streamCustody) return;
    const controller = new AbortController();
    void streamCustody(refresh, controller.signal).catch(() => {
      // The regular poll remains the transport-independent fallback.
    });
    return () => controller.abort();
  }, [refresh, streamCustody]);

  const runNow = async (): Promise<void> => {
    setTriggering(true);
    setRunError(null);
    try {
      await onRunNow();
      refresh();
      followupTimerRef.current = setTimeout(refresh, FOLLOWUP_MS);
    } catch (error) {
      if (mountedRef.current)
        setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setTriggering(false);
    }
  };

  const anyRunning =
    triggering || (status?.vaults.some((v) => v.running) ?? false);

  const verifyNow = async (): Promise<void> => {
    if (!onVerifyNow) return;
    setVerifying(true);
    setRunError(null);
    try {
      await onVerifyNow();
      refresh();
      followupTimerRef.current = setTimeout(refresh, FOLLOWUP_MS);
    } catch (error) {
      if (mountedRef.current)
        setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setVerifying(false);
    }
  };

  const metrics = useMemo(
    () => (status ? computeStorageMetrics(status, usage, now) : null),
    [status, usage, now]
  );

  const hasBackups =
    (status?.configured ?? false) ||
    (status?.vaults.some((v) => v.lastBackupAt) ?? false);
  const clocks = metrics?.freshness.clocks;
  // The headline the whole screen leads with (#708) — computed from
  // the SAME `metrics` every other readout on this surface reads, so it can
  // never disagree with the five-metric health block below it.
  const lossSummary =
    status && metrics ? deriveLossSummary(status, metrics) : null;

  // WHEN IT LAST RAN IS THE META, because that is the question the section
  // answers at a glance; the provider is who holds it, which only matters once
  // the answer to "when" is not "never". The newest of the vault clocks, so a
  // gateway holding several vaults reports the freshest copy rather than an
  // arbitrary first one.
  const lastRunAt = (status?.vaults ?? [])
    .map((vault) => (vault.lastBackupAt ? Date.parse(vault.lastBackupAt) : NaN))
    .filter((at) => Number.isFinite(at))
    .reduce<number | null>(
      (best, at) => (best === null || at > best ? at : best),
      null
    );
  const headMeta = ((): string => {
    if (status === null) return "reading";
    if (lastRunAt !== null)
      return `last run ${formatDuration(Math.max(0, now - lastRunAt))} ago`;
    return status.provider ? `${status.provider} · never run` : "no copies yet";
  })();

  return (
    <>
      {/* The section head sits ABOVE the container, over its own hairline
          (binding layer v11): a head inside the border reads as a caption on
          the card rather than as the name of this stretch of the page. When it
          last ran is a fact, so it is stated in the meta; Manage is a verb
          about this section, so it is the head's quiet action. */}
      <SectionBlock
        label="Backups"
        meta={headMeta}
        {...(onOpenSettings && !readOnly
          ? {
              action: {
                hint: "Backup settings",
                label: "Manage",
                onClick: onOpenSettings,
              },
            }
          : {})}
      />
      {/* THE FOUR ANSWERS FIRST, then the diagnosis. When it last ran, how
          often it runs, whether the copies can be opened, and who has one —
          stated as rows before any panel, so a gateway with no backups reads as
          four facts rather than as one sentence and a lot of border. */}
      {status ? (
        // `onRunNow` follows the same rule as the diagnostics disclosure
        // below: a run verb needs a destination to run to. Withheld until one
        // is configured, so the row states the fact ("No backup has ever run")
        // without offering a button that can only come back with an error.
        <BackupSummaryRows
          status={status}
          now={now}
          lastRunAt={lastRunAt}
          running={anyRunning}
          {...(readOnly || !status.configured
            ? {}
            : { onRunNow: () => void runNow() })}
          {...(onOpenSettings && !readOnly ? { onOpenSettings } : {})}
        />
      ) : null}
      <section className={cx(gwStyles.panel, styles.card)}>
        <div className={styles.body}>
          {loadError ? (
            <div className={styles.loadError}>
              Couldn’t reach the gateway: {loadError}
            </div>
          ) : !status || !metrics ? (
            <div className={gwStyles.panelEmpty}>Checking backup status…</div>
          ) : hasBackups ? (
            <>
              {lossSummary ? <BackupLossSummary summary={lossSummary} /> : null}

              <BackupHealthMetrics metrics={metrics} now={now} />

              {loadDevices ? (
                <BackupDeviceList now={now} loadDevices={loadDevices} />
              ) : null}

              <BackupCopyCards
                status={status}
                metrics={metrics}
                readOnly={readOnly}
                {...(!readOnly && onRestore ? { onRestore } : {})}
              />

              {readOnly ? null : (
                <RecoveryKitGate
                  configured={status.configured}
                  recoveryKit={status.recoveryKit ?? { confirmedAt: null }}
                  onConfirm={onConfirmRecoveryKit}
                  onExport={onExportRecoveryKit}
                />
              )}

              {/* NOTHING TO DIAGNOSE UNTIL THERE IS A DESTINATION. Verify and
                  Back up now both act on a configured backup; offered before
                  one exists they can only fail, and a disclosure holding two
                  buttons that are guaranteed to error is worse than no
                  disclosure. The explainer above already says what to do. */}
              {readOnly || !status.configured ? null : (
                <details
                  className={styles.diagnostics}
                  data-testid="backup-diagnostics"
                >
                  <summary>Diagnostics</summary>
                  <div className={styles.diagnosticsBody}>
                    <div className={styles.actions}>
                      {onVerifyNow ? (
                        <button
                          type="button"
                          className={cx(
                            buttonCss.btn,
                            buttonCss.sm,
                            controlsCss.soft
                          )}
                          disabled={anyRunning || verifying}
                          onClick={() => void verifyNow()}
                        >
                          <Icon name="CheckCircle" size={13} />
                          <span>{verifying ? "Verifying…" : "Verify now"}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={cx(
                          buttonCss.btn,
                          buttonCss.sm,
                          controlsCss.soft
                        )}
                        disabled={anyRunning || verifying}
                        onClick={() => void runNow()}
                      >
                        <span
                          className={styles.runIcon}
                          data-spin={anyRunning || undefined}
                        >
                          <Icon
                            name={anyRunning ? "Loader" : "Save"}
                            size={13}
                          />
                        </span>
                        <span>
                          {anyRunning ? "Backing up…" : "Back up now"}
                        </span>
                      </button>
                    </div>
                    {runError ? (
                      <div className={styles.runError}>{runError}</div>
                    ) : null}

                    {clocks ? (
                      <div
                        className={styles.clockGrid}
                        data-testid="freshness-clocks"
                      >
                        <ClockLine
                          label="Newest snapshot"
                          at={clocks.lastRegisteredSnapshotAt}
                          now={now}
                        />
                        <ClockLine
                          label="Last verification"
                          at={clocks.lastSuccessfulVerificationAt}
                          now={now}
                        />
                        <ClockLine
                          label="Newest WAL segment"
                          at={clocks.lastAckedWalSegmentAt}
                          now={now}
                        />
                        <ClockLine
                          label="Outbox drained"
                          at={clocks.outboxDrainedWatermarkAt}
                          now={now}
                        />
                      </div>
                    ) : null}

                    {status.vaults.length > 0 ? (
                      <div className={styles.vaultList}>
                        {status.vaults.map((v) => (
                          <VaultRow
                            key={v.vaultId}
                            vault={v}
                            now={now}
                            provider={status.provider}
                            onUpdatePolicy={onUpdatePolicy}
                            onVerifyBucket={onVerifyBucket}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>
              )}
            </>
          ) : (
            <>
              {lossSummary ? <BackupLossSummary summary={lossSummary} /> : null}
              {/* NO BARE "Not backed up offsite yet." LINE HERE. The summary
                  rows above say it four ways, each with the consequence
                  attached; a bare repeat costs a line and carries no
                  information. */}
              {readOnly ? null : (
                <RecoveryKitGate
                  configured={status.configured}
                  recoveryKit={status.recoveryKit ?? { confirmedAt: null }}
                  onConfirm={onConfirmRecoveryKit}
                  onExport={onExportRecoveryKit}
                />
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
