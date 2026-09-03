import { useEffect } from "react";
import type { JSX } from "react";

import { cx } from "../../ui/cx.js";
import ShellModal from "../../ui/ShellModal.js";
import { iconSvg } from "../iconSvg.js";
import type { ConnectFlowProps } from "./ConnectFlow.js";
import ConnectTicketPanel, {
  CONNECT_TICKET_INTRO,
} from "./ConnectTicketPanel.js";

import controlsCss from "../../styles/controls.module.css";
import vaultModalStyles from "./VaultModal.module.css";

export interface ConnectFlowModalProps extends Omit<
  ConnectFlowProps,
  "onCancel"
> {
  onCancel: () => void;
}

const DEFAULT_METHODS: ConnectFlowModalProps["methods"] = ["gateway"];

export default function ConnectFlowModal({
  methods = DEFAULT_METHODS,
  onCancel,
  onDone,
  context,
}: ConnectFlowModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={vaultModalStyles.profOverlay}>
      <button
        type="button"
        className={vaultModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onCancel}
      />
      <ShellModal
        layer="inline"
        className={vaultModalStyles.profModal}
        ariaModal
      >
        <div className={vaultModalStyles.profModalHead}>
          <span
            className={vaultModalStyles.profModalHeadIcon}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("Plug", 14) }}
          />
          <h2 className={vaultModalStyles.profModalTitle}>Add vault</h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, vaultModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onCancel}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("X", 14) }}
          />
        </div>
        <div className={vaultModalStyles.profModalBody}>
          <p className={controlsCss.note}>{CONNECT_TICKET_INTRO}</p>
          <ConnectTicketPanel
            context={context}
            methods={methods}
            onDone={onDone}
          />
        </div>
      </ShellModal>
    </div>
  );
}
