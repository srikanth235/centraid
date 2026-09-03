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

export interface BackupVaultStatusDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastWalDrainAt?: string;
  lastError?: string;
  running?: boolean;
  policy?: BackupPolicyDTO;
  destination?: BackupDestinationDTO;
  pendingOffsite?: { count: number; bytes: number };
  providerPolicy?: ProviderPolicyStatusDTO;
  reconciliation?: BackupReconciliationDTO;
}

export interface RecoveryKitStatusDTO {
  confirmedAt: number | null;
}

export interface BackupStatusDTO {
  configured: boolean;
  provider?: string;
  vaults: BackupVaultStatusDTO[];
  recoveryKit?: RecoveryKitStatusDTO;
  home?: GatewayHomeDiscoveryDTO;
}

export interface BackupCardProps {
  now: number;
  loadStatus: () => Promise<BackupStatusDTO>;
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
  onConfirmRecoveryKit: (input: {
    kit: unknown;
    password: string;
    lossConsent: true;
  }) => Promise<{ confirmedAt: number }>;
  onOpenSettings?: () => void;
  loadDevices?: () => Promise<CentraidGatewayDevice[]>;
  onRestore?: () => void;
  readOnly?: boolean;
}

const POLL_MS = 10_000;
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
        .catch(() => {});
    }
  }, [loadStatus, loadUsage]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
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
    void streamCustody(refresh, controller.signal).catch(() => {});
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
  const lossSummary =
    status && metrics ? deriveLossSummary(status, metrics) : null;

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
      {/* Head sits ABOVE the container (binding layer v11); when it last ran
          is a fact in the meta; Manage is this section's verb. */}
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
      {/* THE FOUR ANSWERS FIRST, then the diagnosis. */}
      {status ? (
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

              {/* NOTHING TO DIAGNOSE UNTIL THERE IS A DESTINATION — offered
                  earlier they can only fail. */}
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
              {/* NO BARE "Not backed up offsite yet." LINE — the summary rows
                  above say it four ways, each with the consequence attached. */}
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
