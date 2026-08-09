import { useEffect, useState } from "react";
import type { JSX } from "react";

import { createGatewayDeviceTicket } from "../../../gateway-client.js";
import DevicePairPanel from "../../screens/DevicePairPanel.js";
import { cx } from "../../ui/cx.js";
import { iconSvg } from "../iconSvg.js";

import controlsCss from "../../styles/controls.module.css";
import vaultModalStyles from "./VaultModal.module.css";

export interface PairDeviceModalProps {
  onClose: () => void;
}

/**
 * Pairing a device from the account menu, not from Settings.
 *
 * Pairing is a one-off ACT you perform — mint a ticket, scan it, done — the
 * same shape as "Log out" rather than "Appearance", so it left the settings
 * rail for this modal. It hosts the SAME `DevicePairPanel` that Household →
 * Devices offers, deliberately: two ways to reach one surface, not a second
 * implementation that can drift.
 *
 * Not the Electron phone-tunnel screen that used to be Settings → Phone. That
 * one publishes desktop apps over a tunnel and is inert on web (the browser
 * host answers "pairing is managed by the gateway or desktop client"); this is
 * the ticket flow that actually enrolls a phone against this gateway.
 *
 * Landing state — the only state, since #726 — is self-pair, which is what
 * makes "add my own phone" cost nothing: the gateway derives the access from
 * the enrollment you already hold, so there is nothing here to pick.
 */
export default function PairDeviceModal({
  onClose,
}: PairDeviceModalProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  // The panel humanizes its ticket's remaining life, so it needs a clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={vaultModalStyles.profOverlay}>
      <button
        type="button"
        className={vaultModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <dialog
        open
        className={vaultModalStyles.profModal}
        aria-modal="true"
        data-testid="pair-device-modal"
      >
        <div className={vaultModalStyles.profModalHead}>
          <span
            className={vaultModalStyles.profModalHeadIcon}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("Phone", 14) }}
          />
          <h2 className={vaultModalStyles.profModalTitle}>Pair a device</h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, vaultModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onClose}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("X", 14) }}
          />
        </div>
        <div className={vaultModalStyles.profModalBody}>
          <DevicePairPanel
            now={now}
            onCreateTicket={createGatewayDeviceTicket}
            onClose={onClose}
          />
        </div>
      </dialog>
    </div>
  );
}
