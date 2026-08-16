import { useState } from "react";
import type { JSX } from "react";

import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";

import vaultModalStyles from "../shell/routes/VaultModal.module.css";
import controlsCss from "../styles/controls.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";
import styles from "./SettingsDeviceScreen.module.css";

export interface SettingsDeviceScreenProps {
  /** Gateway label this browser is paired with, when it is paired at all. */
  gatewayLabel?: string;
  /** Whether this device keeps an encrypted offline copy of the vault. */
  offlineCopy: boolean;
  /** Flip the offline copy. Resolves with the value that actually took effect
   *  — a refused or failed write comes back as the UNCHANGED value, so the
   *  switch can never show a state the device is not in. */
  onOfflineCopy: (next: boolean) => Promise<boolean>;
  onForget: () => void;
  /** Pair a phone. It hung off the sidebar's account menu until #707 retired
   *  that column; pairing is an act about THIS device, which is this page. */
  onPairDevice?: () => void;
  /** The release-notes dialog, same reasoning. */
  onWhatsNew?: () => void;
  /** Drop this device's pairing and return to onboarding. Distinct from
   *  `onForget`, which is the local-only purge below. */
  onLogOut?: () => void;
}

/**
 * Settings → This device — the browser's own half of the pairing.
 *
 * The gateway-side view of enrolled devices is Household → Devices; this page
 * owns only what lives in THIS browser: the private device key that is its
 * enrolled identity, the offline copy, and the tunnel caches. Forgetting is
 * deliberately local — the enrollment stays on the gateway until it is revoked
 * there, so a lost or shared browser is cleaned up in two places on purpose.
 */
export default function SettingsDeviceScreen({
  gatewayLabel,
  offlineCopy,
  onOfflineCopy,
  onForget,
  onPairDevice,
  onWhatsNew,
  onLogOut,
}: SettingsDeviceScreenProps): JSX.Element {
  // Once the user has flipped the switch, THEIR answer is the truth on screen:
  // the `offlineCopy` prop is a one-shot read from mount (`loadThisDeviceData`)
  // and does not re-run, so letting it win back would flip the switch under
  // them on the next render.
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = override ?? offlineCopy;
  const flip = (next: boolean): void => {
    setBusy(true);
    void onOfflineCopy(next)
      .then((effective) => setOverride(effective))
      .finally(() => setBusy(false));
  };
  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          {gatewayLabel
            ? `This browser is paired with ${gatewayLabel}; the pairing survives closing it.`
            : "This browser is not paired with a gateway yet."}
        </div>
        {/* The question pairing no longer asks. It defaults ON and lives here
            instead, where the reader has seen the product and can judge it —
            and where turning it off actually purges what was kept. */}
        <label className={styles.offlineRow} data-on={enabled}>
          <input
            type="checkbox"
            aria-label="Keep an offline copy"
            checked={enabled}
            disabled={busy}
            onChange={(event) => flip(event.target.checked)}
          />
          <span>
            <strong>Keep an offline copy</strong>
            <small>
              An encrypted replica, queued changes, and cached previews stay on
              this device, so it keeps working on a bad connection. Turning this
              off erases them here and leaves only the pairing; either way this
              device stays paired until you forget it.
            </small>
          </span>
        </label>
      </div>

      {onPairDevice || onWhatsNew ? (
        <div className={drawerGroupCss.group}>
          <div className={drawerGroupCss.groupLabel}>This account</div>
          <div className={drawerGroupCss.groupBody}>
            {onPairDevice ? (
              <button
                type="button"
                className={controlsCss.chip}
                onClick={onPairDevice}
              >
                <Icon name="Phone" size={12} />
                Pair a phone
              </button>
            ) : null}
            {onWhatsNew ? (
              <button
                type="button"
                className={controlsCss.chip}
                onClick={onWhatsNew}
              >
                <Icon name="Gift" size={12} />
                What&apos;s new
              </button>
            ) : null}
            {onLogOut ? (
              <button
                type="button"
                className={cx(
                  controlsCss.chip,
                  vaultModalStyles.profModalDelete
                )}
                onClick={onLogOut}
              >
                <Icon name="ArrowRight" size={12} />
                Log out
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {gatewayLabel ? (
        <div className={drawerGroupCss.group}>
          <div className={drawerGroupCss.groupLabel}>Danger zone</div>
          <div className={drawerGroupCss.groupBody}>
            <div className={controlsCss.note}>
              Forgetting removes this browser's device key, its offline copy,
              and its cached previews. Your vault is untouched, and the
              enrollment stays on the gateway until you revoke it from Household
              → Devices. You'll need a new pairing ticket to come back.
            </div>
            <button
              type="button"
              className={cx(controlsCss.chip, vaultModalStyles.profModalDelete)}
              onClick={onForget}
            >
              <Icon name="Trash" size={12} />
              Forget this device
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
