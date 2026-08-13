import { useState } from "react";
import type { JSX } from "react";

import { formatDuration } from "../shell/routes/gatewayData.js";
import Button from "../ui/Button.js";
import Icon from "../ui/Icon.js";
import type { RowDef } from "../ui/RowsBlock.js";
import { lastDeviceVault } from "./device-errors.js";
import type { GroupedDevice } from "./device-groups.js";

import styles from "./HouseholdScreen.module.css";

/*
 * One hardware binding, as a row in the Devices page's row block (#726, #765).
 *
 * The v9 row carries a title, one explanatory sub line, one state word, and
 * ONE trailing action. Everything a device can have done to it — rename,
 * compute, revoke — is more than one verb, so the trailing action opens the
 * row's own detail underneath it (`RowDef.children`) rather than the row
 * growing a second and a third button.
 *
 * "Revoke device" is still the narrow verb — this phone was lost, the person
 * keeps their access and their other devices. Removing the PERSON is a
 * host-custody act on this machine (`owners-routes.ts`), never a verb this
 * page offers.
 */

/** A device unseen for this long reads as `Dormant` rather than `Fine`. */
const DORMANT_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeviceRowActions {
  /** Absent when the host cannot revoke devices at all. */
  onRevoke?: (
    device: GroupedDevice,
    confirmLastDevice?: string
  ) => Promise<void>;
  onRename?: (device: GroupedDevice, label: string) => Promise<void>;
  onUpdateCompute?: (device: GroupedDevice, enabled: boolean) => Promise<void>;
}

export interface DeviceRowOptions extends DeviceRowActions {
  device: GroupedDevice;
  /** Live clock (the route ticks it) — drives the humanized ages. */
  now: number;
  /** Name the person this device acts as. Set for everyone but yourself: in
   *  your own section the answer is always "you", and saying it on every row
   *  would be the loudest thing in the block. */
  showOwner?: boolean;
  open: boolean;
  onToggle: () => void;
}

export function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

/** The day something happened, in the reader's own locale ("3 March"). A
 *  pairing is remembered as a date; only "last seen" is read as an age. */
export function dateLabel(iso: string | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/** The row's one mono word: what this device IS to you right now. */
function stateWord(device: GroupedDevice, now: number, other: boolean): string {
  if (device.current) return "This device";
  if (other) return "Other person";
  const seen = Date.parse(device.lastUsedAt ?? device.addedAt ?? "");
  if (!Number.isNaN(seen) && now - seen > DORMANT_MS) return "Dormant";
  return "Fine";
}

/** The row's sub line — what this device is doing, and since when. */
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
  const seen = device.lastUsedAt
    ? `seen ${ageLabel(device.lastUsedAt, now)}`
    : "never used";
  const paired = device.addedAt ? `paired ${dateLabel(device.addedAt)}` : "";
  return [
    showOwner ? device.ownerLabel : "",
    device.current ? "This device" : "",
    compute ?? "",
    device.platform ?? "",
    paired,
    seen,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Which verb the trailing control offers, given what this host can do. */
function actionLabel(actions: DeviceRowActions): string | undefined {
  if (actions.onRevoke || actions.onUpdateCompute) return "Manage";
  if (actions.onRename) return "Rename";
  return undefined;
}

/** One live device, as a row definition for `RowsBlock`. */
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

/**
 * One tombstone, as an OFF row. It stays in the list rather than behind a
 * disclosure because a revoked binding is how a past write still resolves to
 * the device that made it — present for audit, inert, and out of every count.
 */
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

/** The row's own detail: every verb this device answers to, opened in place. */
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
  // Set only once the gateway has refused: this device is the last live one
  // of the vault's last owner, so the confirm escalates in place.
  const [strandedVault, setStrandedVault] = useState<string | null>(null);
  const [computeBusy, setComputeBusy] = useState(false);
  const [name, setName] = useState(device.label);

  const revoke = async (confirmLastDevice?: string): Promise<void> => {
    if (!onRevoke) return;
    setBusy(true);
    setError(null);
    try {
      await onRevoke(device, confirmLastDevice);
      // On success the parent drops the row; nothing more to do here.
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
      {/* Every vault this device reaches — it holds one enrollment per vault,
          and naming only the first read as "paired to Shared" for a device
          that also reached Personal. */}
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
          would need the gateway machine and its command line.
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
