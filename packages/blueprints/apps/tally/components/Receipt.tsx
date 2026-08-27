// THE RECEIPT — the allocation surface (Tally spec §3, FLOWS.md).
//
// CAPTURE BELONGS TO THE PHONE and the lines arrive already reviewed. What
// this surface owns is WHO HAD WHAT: the photograph beside the lines, a chip
// per member on every line, and the reconciliation stated as arithmetic in the
// foot — six lines total £132.50, the expense is £132.50, yours is £41.17 — so
// a mis-allocation is visible before saving rather than after.
//
// THE COMMIT IS ONE WRITE, and it has to be: `tally.reallocate_receipt`
// rewrites every line allocation AND the splits they imply in one transaction,
// re-validating that the lines still sum to the expense. An `edit-expense`
// that rewrote only the splits would leave `tally.expense_line_allocation`
// disagreeing with them inside the vault — the lines and the shares are one
// fact, and one fact takes one write. The amount never changes.
//
// THE FOOT RECOMPUTES AS THE CHIPS MOVE, which is the whole point of stating
// the reconciliation as arithmetic: a mis-allocation is visible before saving
// rather than after, and the commit is refused while the lines do not sum.
//
// THE PHOTOGRAPH GOES THROUGH THE SHELL'S BLOB DOOR. The document origin is
// not the gateway — the PWA rides a tunnel and desktop runs from `file://` —
// so a relative `src` on a `/_vault/blobs/…` path resolves nowhere and carries
// no credential. The URL arrives already minted by `window.centraid.blobUrl`,
// and a host without that door draws the placeholder instead of a broken box.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import {
  CANCEL,
  RECEIPT_COMMIT,
  RECEIPT_HEAD,
  RECEIPT_LEDE_ORIGIN,
  RECEIPT_LEDE_OTHER,
  RECEIPT_NONE,
  RECEIPT_SHOT_ABSENT,
  RECEIPT_SHOT_ALT,
  unallocatedLines,
} from "../compose-copy.ts";
import { metaSentence, money } from "../format.ts";
import { LINE_KIND_LABEL, onLine, reconcile } from "../receipt-model.ts";
import type { LineSelection } from "../receipt-model.ts";
import type { GroupMember, LedgerEntry } from "../types.ts";
import { Editor, EditorFoot, EditorHead } from "./Fields.tsx";

import styles from "./Compose.module.css";

export interface ReceiptScreenProps {
  entry: LedgerEntry;
  members: readonly GroupMember[];
  currency: string;
  me: string | null;
  /** Is this the phone — the seat where the capture itself happens? */
  compact: boolean;
  selection: LineSelection;
  /** An authed `blob:` URL for the photograph, or `null` where this host has
   *  no blob door and the placeholder stands instead. */
  shotUrl: string | null;
  onToggle: (lineId: string, partyId: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}

export function ReceiptScreen(props: ReceiptScreenProps): ReactNode {
  const receipt = props.entry.receipt;
  if (!receipt) {
    return (
      <Editor>
        <EditorHead head={RECEIPT_HEAD} lede={RECEIPT_NONE} />
      </Editor>
    );
  }

  const folded = reconcile({
    lines: receipt.lines,
    selection: props.selection,
    expenseMinor: props.entry.amount_minor,
    me: props.me,
    currency: props.currency,
    participants: props.members.map((member) => member.party_id),
  });

  return (
    <Editor>
      <EditorHead
        head={RECEIPT_HEAD}
        lede={props.compact ? RECEIPT_LEDE_ORIGIN : RECEIPT_LEDE_OTHER}
      />

      <div className={styles.receiptBody}>
        <div className={styles.shot}>
          {props.shotUrl ? (
            <img
              className={styles.shotImage}
              src={props.shotUrl}
              alt={RECEIPT_SHOT_ALT}
            />
          ) : (
            RECEIPT_SHOT_ABSENT
          )}
        </div>

        <div className={styles.lines}>
          {receipt.lines.map((line) => (
            <div key={line.line_item_id} className={styles.lineRow}>
              <span className={styles.lineTitle}>
                {displayText(
                  metaSentence([line.description, LINE_KIND_LABEL[line.kind]])
                )}
              </span>
              <span className={`${styles.lineAmount} ${styles.num}`}>
                {money(line.amount_minor, props.currency)}
              </span>
              <fieldset
                className={styles.lineWho}
                aria-label={line.description}
              >
                {props.members.map((member) => (
                  <button
                    key={member.party_id}
                    type="button"
                    className="kit-chip"
                    aria-pressed={onLine(
                      props.selection,
                      line.line_item_id,
                      member.party_id
                    )}
                    onClick={() =>
                      props.onToggle(line.line_item_id, member.party_id)
                    }
                  >
                    {displayText(member.name)}
                  </button>
                ))}
              </fieldset>
            </div>
          ))}
        </div>
      </div>

      <EditorFoot
        copy={metaSentence([
          folded.sentence,
          folded.unallocated > 0 ? unallocatedLines(folded.unallocated) : "",
        ])}
        cancelLabel={CANCEL}
        onCancel={props.onCancel}
        commit={{
          label: RECEIPT_COMMIT,
          // THE ARITHMETIC IS THE ONLY GATE. Lines that do not sum to the
          // expense would be refused by the command anyway; saying so here is
          // the same refusal, in front of the press rather than behind it.
          ...(folded.reconciles ? {} : { refusal: folded.sentence }),
          run: props.onCommit,
        }}
      />
    </Editor>
  );
}
