import type { JSX } from "react";

import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";

import spaceModalStyles from "../shell/routes/SpaceModal.module.css";
import controlsCss from "../styles/controls.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";

export interface SettingsDeviceScreenProps {
  /** Gateway label this browser is paired with, when it is paired at all. */
  gatewayLabel?: string;
  /** Whether this device keeps an encrypted offline copy of the vault. */
  offlineCopy: boolean;
  onForget: () => void;
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
  onForget,
}: SettingsDeviceScreenProps): JSX.Element {
  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          {gatewayLabel
            ? `This browser is paired with ${gatewayLabel}. The pairing is stored on this device and survives closing the browser — you only need a new ticket if you forget it here or revoke it from Household → Devices.`
            : "This browser is not paired with a gateway yet."}
        </div>
        <div className={controlsCss.note}>
          {offlineCopy
            ? "Offline copy is on: an encrypted replica, queued changes, and cached previews are kept here."
            : "Offline copy is off: nothing but the pairing itself is stored on this device."}
        </div>
      </div>

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
              className={cx(controlsCss.chip, spaceModalStyles.profModalDelete)}
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
