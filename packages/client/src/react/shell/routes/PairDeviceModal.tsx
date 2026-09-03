import { useEffect, useState } from "react";
import type { JSX } from "react";

import { createGatewayDeviceTicket } from "../../../gateway-client.js";
import DevicePairPanel from "../../screens/DevicePairPanel.js";
import { cx } from "../../ui/cx.js";
import ShellModal from "../../ui/ShellModal.js";
import { iconSvg } from "../iconSvg.js";

import controlsCss from "../../styles/controls.module.css";
import vaultModalStyles from "./VaultModal.module.css";

export interface PairDeviceModalProps {
  onClose: () => void;
}

export default function PairDeviceModal({
  onClose,
}: PairDeviceModalProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

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
      <ShellModal
        layer="inline"
        className={vaultModalStyles.profModal}
        ariaModal
        data={{ "data-testid": "pair-device-modal" }}
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
      </ShellModal>
    </div>
  );
}
