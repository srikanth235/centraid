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
  compact: boolean;
  selection: LineSelection;
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
          ...(folded.reconciles ? {} : { refusal: folded.sentence }),
          run: props.onCommit,
        }}
      />
    </Editor>
  );
}
