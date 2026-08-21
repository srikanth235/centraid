import { useRef, useState } from "react";
import type { JSX } from "react";

import { formatClock } from "../shell/routes/gatewayData.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import type { BackupCardProps, RecoveryKitStatusDTO } from "./BackupCard.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./BackupCard.module.css";

export default function RecoveryKitGate({
  configured,
  recoveryKit,
  onConfirm,
  onExport,
}: {
  configured: boolean;
  recoveryKit: RecoveryKitStatusDTO;
  onConfirm: BackupCardProps["onConfirmRecoveryKit"];
  onExport?: BackupCardProps["onExportRecoveryKit"];
}): JSX.Element {
  const [confirmedAt, setConfirmedAt] = useState(recoveryKit.confirmedAt);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [exported, setExported] = useState(false);
  const [selectedKit, setSelectedKit] = useState<unknown>();
  const [selectedName, setSelectedName] = useState("");
  const [lossConsent, setLossConsent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A fresh confirmation timestamp from the gateway replaces the local one.
  // Adjusted during render, so the gate never paints the stale value once.
  const [seenConfirmedAt, setSeenConfirmedAt] = useState(
    recoveryKit.confirmedAt
  );
  if (seenConfirmedAt !== recoveryKit.confirmedAt) {
    setSeenConfirmedAt(recoveryKit.confirmedAt);
    setConfirmedAt(recoveryKit.confirmedAt);
  }

  const exportKit = async (): Promise<void> => {
    if (!onExport || password.length === 0) {
      setError("Choose a recovery-kit password first.");
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const result = await onExport({ password });
      if (!result.ok) {
        if (result.canceled) return;
        throw new Error(result.error ?? "Recovery kit export failed");
      }
      setExported(true);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      setConfirming(false);
    }
  };

  const selectKit = async (file: File | undefined): Promise<void> => {
    setSelectedKit(undefined);
    setSelectedName("");
    setError(null);
    if (!file) return;
    try {
      setSelectedKit(JSON.parse(await file.text()) as unknown);
      setSelectedName(file.name);
    } catch {
      setError("That file isn’t a recovery kit — select the one you saved.");
    }
  };

  const verifyKit = async (): Promise<void> => {
    if (selectedKit === undefined || !lossConsent) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await onConfirm({
        kit: selectedKit,
        password,
        lossConsent: true,
      });
      setConfirmedAt(result.confirmedAt);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      setConfirming(false);
    }
  };

  if (confirmedAt != null) {
    return (
      <div
        className={styles.sealConfirmed}
        data-testid="recovery-kit-confirmed"
      >
        <Icon name="CheckCircle" size={13} />
        <span>Recovery kit confirmed {formatClock(confirmedAt * 1000)}</span>
      </div>
    );
  }

  return (
    <div className={styles.sealNudge} data-testid="recovery-kit-gate">
      <Icon name="Key" size={13} />
      <div className={styles.sealNudgeBody}>
        <span>
          Save this recovery kit somewhere offline. It unlocks backed-up vaults
          on a new machine; local-only vaults are not included.
        </span>
        {configured ? (
          <div className={styles.kitCeremony}>
            <label className={styles.kitField}>
              <span>Recovery-kit password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value);
                  setExported(false);
                  setSelectedKit(undefined);
                  setLossConsent(false);
                }}
              />
            </label>
            <button
              type="button"
              className={cx(
                buttonCss.btn,
                buttonCss.sm,
                controlsCss.soft,
                styles.sealConfirmBtn
              )}
              disabled={confirming || password.length === 0 || !onExport}
              onClick={() => void exportKit()}
            >
              {confirming && !exported
                ? "Exporting…"
                : "Export wrapped recovery kit"}
            </button>
            {exported ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className={styles.hiddenFile}
                  onChange={(event) =>
                    void selectKit(event.currentTarget.files?.[0])
                  }
                />
                <button
                  type="button"
                  className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                  onClick={() => fileRef.current?.click()}
                >
                  {selectedName
                    ? `Selected: ${selectedName}`
                    : "Re-select the saved file"}
                </button>
                <label className={styles.lossConsent}>
                  <input
                    type="checkbox"
                    checked={lossConsent}
                    onChange={(event) =>
                      setLossConsent(event.currentTarget.checked)
                    }
                  />
                  <span>
                    I understand that losing this file or its password makes
                    backed-up vaults unrecoverable.
                  </span>
                </label>
                <button
                  type="button"
                  className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                  disabled={
                    confirming || selectedKit === undefined || !lossConsent
                  }
                  onClick={() => void verifyKit()}
                >
                  {confirming ? "Verifying…" : "Verify selected recovery kit"}
                </button>
              </>
            ) : null}
            {error ? <div className={styles.runError}>{error}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
