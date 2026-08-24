import { useEffect } from "react";
import type { JSX } from "react";

import { cx } from "../../ui/cx.js";
import { iconSvg } from "../iconSvg.js";
import type { ConnectFlowProps } from "./ConnectFlow.js";
import ConnectTicketPanel, {
  CONNECT_TICKET_INTRO,
} from "./ConnectTicketPanel.js";

import controlsCss from "../../styles/controls.module.css";
// Reuses VaultModal's overlay/scrim/head/foot chrome verbatim, the precedent
// for the whole "Add X" dialog family (#376) — one implementation of the
// overlay/backdrop/pop-animation CSS shared by every "Add ___" modal in
// Settings/the switcher.
import vaultModalStyles from "./VaultModal.module.css";

export interface ConnectFlowModalProps extends Omit<
  ConnectFlowProps,
  "onCancel"
> {
  onCancel: () => void;
}

/** The switcher's "Add vault…" modal (#382) — dialog chrome around
 *  ConnectTicketPanel, the SAME ticket step onboarding shows, offering the
 *  ticket path only ('local' is always already registered, so re-offering it
 *  here would be a dead end rather than a new connection).
 *
 *  A ticket pairs this device to a VAULT; which gateway happens to host it is
 *  the ticket's business, so the dialog no longer asks the reader to think
 *  about gateways at all. Internal names (`connectGateway`, `addGateway`, the
 *  `'gateway'` method id) are unchanged — this is copy, not a rename. */
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
      <dialog open className={vaultModalStyles.profModal} aria-modal="true">
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
      </dialog>
    </div>
  );
}
