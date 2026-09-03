import { useState } from "react";
import type { JSX } from "react";

import Button from "../ui/Button.js";
import Icon from "../ui/Icon.js";
import type { RowDef } from "../ui/RowsBlock.js";
import { lastDeviceVault } from "./device-errors.js";
import type { GroupedDevice } from "./device-groups.js";
import { replicaClause, seenAge } from "./vault-custody.js";

import styles from "./HouseholdScreen.module.css";

const DORMANT_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeviceRowActions {
  onRevoke?: (
    device: GroupedDevice,
    confirmLastDevice?: string
  ) => Promise<void>;
  onRename?: (device: GroupedDevice, label: string) => Promise<void>;
  onUpdateCompute?: (device: GroupedDevice, enabled: boolean) => Promise<void>;
}

export interface DeviceRowOptions extends DeviceRowActions {
  device: GroupedDevice;
  now: number;
  showOwner?: boolean;
  open: boolean;
  onToggle: () => void;
}

export function ageLabel(iso: string | undefined, now: number): string {
  return seenAge(iso, now);
}

export function dateLabel(iso: string | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

function stateWord(device: GroupedDevice, now: number, other: boolean): string {
  if (device.current) return "This device";
  if (other) return "Other person";
  const seen = Date.parse(device.lastUsedAt ?? device.addedAt ?? "");
  if (!Number.isNaN(seen) && now - seen > DORMANT_MS) return "Dormant";
  return "Fine";
}

function subLine(
  device: GroupedDevice,
  now: number,
  showOwner: boolean
): string {
  const compute = device.compute
    ? device.compute.contributeWhileCharging
      ? "contributing compute"
      : "not contributing compute"
    : undefined;
  const seen = device.current
    ? ""
    : device.lastUsedAt
      ? `seen ${ageLabel(device.lastUsedAt, now)}`
      : "never used";
  const paired = device.addedAt ? `paired ${dateLabel(device.addedAt)}` : "";
  return [
    showOwner ? device.ownerLabel : "",
    device.current ? "This device" : "",
    compute ?? "",
    replicaClause(device),
    device.platform ?? "",
    paired,
    seen,
  ]
    .filter(Boolean)
    .join(" · ");
}

function actionLabel(actions: DeviceRowActions): string | undefined {
  if (actions.onRevoke || actions.onUpdateCompute) return "Manage";
  if (actions.onRename) return "Rename";
  return undefined;
}

export function deviceRowDef(options: DeviceRowOptions): RowDef {
  const { device, now, showOwner = false, open, onToggle } = options;
  const label = actionLabel(options);
  return {
    id: device.endpointId,
    meta: stateWord(device, now, showOwner),
    sub: subLine(device, now, showOwner),
    title: device.label,
    ...(label
      ? { action: { label: open ? "Close" : label, onClick: onToggle } }
      : {}),
    ...(open
      ? {
          children: (
            <DeviceRowDetail
              device={device}
              now={now}
              {...(options.onRevoke ? { onRevoke: options.onRevoke } : {})}
              {...(options.onRename ? { onRename: options.onRename } : {})}
              {...(options.onUpdateCompute
                ? { onUpdateCompute: options.onUpdateCompute }
                : {})}
            />
          ),
        }
      : {}),
  };
}

export function tombstoneRowDef(device: GroupedDevice, now: number): RowDef {
  const sub = [
    device.vaultName ?? device.vaultId,
    device.addedAt ? `paired ${dateLabel(device.addedAt)}` : "",
    device.lastUsedAt ? `last seen ${ageLabel(device.lastUsedAt, now)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: device.endpointId,
    meta: "Revoked",
    off: true,
    sub,
    title: device.label,
  };
}

export function DeviceRowDetail({
  device,
  now,
  onRevoke,
  onRename,
  onUpdateCompute,
}: { device: GroupedDevice; now: number } & DeviceRowActions): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strandedVault, setStrandedVault] = useState<string | null>(null);
  const [computeBusy, setComputeBusy] = useState(false);
  const [name, setName] = useState(device.label);

  const revoke = async (confirmLastDevice?: string): Promise<void> => {
    if (!onRevoke) return;
    setBusy(true);
    setError(null);
    try {
      await onRevoke(device, confirmLastDevice);
    } catch (caughtError) {
      const stranded = lastDeviceVault(caughtError);
      if (stranded !== undefined && confirmLastDevice === undefined) {
        setStrandedVault(stranded);
      } else {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        );
        setConfirming(false);
        setStrandedVault(null);
      }
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!onRename || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void onRename(device, name.trim())
      .catch((caughtError: unknown) =>
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        )
      )
      .finally(() => setBusy(false));
  };

  const updateCompute = async (enabled: boolean): Promise<void> => {
    if (!onUpdateCompute) return;
    setComputeBusy(true);
    setError(null);
    try {
      await onUpdateCompute(device, enabled);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      setComputeBusy(false);
    }
  };

  return (
    <div className={styles.detail}>
      {/* Every vault this device reaches — one enrollment per vault. */}
      <ul className={styles.detailVaults}>
        {device.vaults.map((vault) => (
          <li key={vault.vaultId}>
            <Icon name="Key" size={11} />
            {vault.vaultName ?? vault.vaultId}
          </li>
        ))}
      </ul>

      {onRename ? (
        <form
          className={styles.renameForm}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            className={styles.renameInput}
            aria-label="Device name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            commit
            disabled={busy || name.trim().length === 0}
            label="Save"
            onClick={save}
            size="sm"
            variant="secondary"
          />
        </form>
      ) : null}

      {/* The same replica string the row and the custody line quote. */}
      <p className={styles.detailNote}>
        What it holds · {replicaClause(device)}
      </p>

      {device.grantProfile === undefined ? null : (
        <p className={styles.detailNote}>
          {device.grantProfile.length > 0
            ? `Companion · ${device.grantProfile.join(" · ")}`
            : "Companion · no modules"}
        </p>
      )}

      {onUpdateCompute ? (
        <label className={styles.computeToggle}>
          <input
            type="checkbox"
            checked={device.compute?.contributeWhileCharging ?? false}
            disabled={computeBusy}
            onChange={(event) => void updateCompute(event.target.checked)}
          />
          <span>Help index your library while charging and unmetered</span>
        </label>
      ) : null}

      {device.compute?.contributeWhileCharging ? (
        <p className={styles.detailNote}>
          {Object.entries(device.compute.capabilities)
            .filter(([, enabled]) => enabled)
            .map(([capability]) => capability)
            .join(" · ")}
        </p>
      ) : null}

      {strandedVault ? (
        <p className={styles.detailWarn}>
          This is the last owner device for {strandedVault}. Getting back in
          would need the vault host machine and its command line.
        </p>
      ) : null}
      {error ? <p className={styles.detailWarn}>{error}</p> : null}

      {/* A viewer looking at someone else's device gets no verb at all. */}
      {onRevoke === undefined ? null : confirming ? (
        <div className={styles.detailActions}>
          <span className={styles.detailAsk}>
            {device.current ? "Sign out this device?" : "Revoke this device?"}
          </span>
          <Button
            commit
            disabled={busy}
            label={strandedVault ? "Revoke anyway" : "Revoke"}
            onClick={() => void revoke(strandedVault ?? undefined)}
            size="sm"
            variant="destructive"
          />
          <Button
            commit={false}
            disabled={busy}
            label="Cancel"
            onClick={() => {
              setConfirming(false);
              setStrandedVault(null);
            }}
            size="sm"
            variant="secondary"
          />
        </div>
      ) : (
        <div className={styles.detailActions}>
          <Button
            label="Revoke device"
            onClick={() => setConfirming(true)}
            size="sm"
            variant="destructive"
          />
          <span className={styles.detailAsk}>
            {device.lastUsedAt
              ? `Last seen ${ageLabel(device.lastUsedAt, now)}.`
              : "This device has never been used."}
          </span>
        </div>
      )}
    </div>
  );
}
