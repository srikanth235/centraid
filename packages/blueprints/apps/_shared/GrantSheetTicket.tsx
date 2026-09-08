// The link-ticket offer under the reach line (#929 S6), browser seat.
//
// It is an OFFER, never a grant: #903's rule that a share needs a live binding
// is untouched, the sheet's submit still refuses, and nothing is sent on the
// member's behalf. What this draws is the one act that would change the
// answer — the same one-time ticket the People and Settings link rows mint,
// offered where the refusal is said instead of as a sentence pointing at
// another screen. The native seat draws the same panel over the same state
// (`apps/mobile/src/kit/share/GrantSheetTicket.tsx`).

import type { JSX } from "react";

import {
  LINK_TICKET_ACTION,
  LINK_TICKET_BUSY,
  LINK_TICKET_COPIED,
  LINK_TICKET_COPY_ACTION,
  LINK_TICKET_NOTE,
} from "./grant-copy.ts";
import type { LinkTicketPanel } from "./link-ticket-panel.ts";

import styles from "./GrantSheet.module.css";

export function GrantSheetTicket({
  panel,
}: {
  panel: LinkTicketPanel;
}): JSX.Element {
  const minted = panel.ticket;
  return (
    <div className={styles.ticket}>
      {minted ? (
        <>
          <code className={styles.ticketCode}>{minted.ticket}</code>
          <button
            type="button"
            className="kit-btn"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(minted.ticket)
                .then(panel.noteCopied);
            }}
          >
            {panel.copied ? LINK_TICKET_COPIED : LINK_TICKET_COPY_ACTION}
          </button>
          <span className={styles.note}>{panel.expiry}</span>
        </>
      ) : (
        <button
          type="button"
          className="kit-btn"
          disabled={panel.busy}
          onClick={() => void panel.make()}
        >
          {panel.busy ? LINK_TICKET_BUSY : LINK_TICKET_ACTION}
        </button>
      )}
      {panel.refusal ? <p className={styles.refusal}>{panel.refusal}</p> : null}
      <p className={styles.note}>{LINK_TICKET_NOTE}</p>
    </div>
  );
}
