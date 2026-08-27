// The PAYER SET and the TYPED LINES tables of Add expense.
//
// NEITHER IS A MODE. Several payers is the ordinary payer chip set with
// amounts typed beside it, and clearing an amount takes that person back out;
// the lines table appears only under *By line*, the one division whose numbers
// are not per-person.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import {
  FIELD_KEYS,
  FIELD_NOTES,
  LINE_VERBS,
  PLACEHOLDERS,
} from "../compose-copy.ts";
import type { LineDraft } from "../line-model.ts";
import { LINE_KIND_LABEL } from "../receipt-model.ts";
import type { GroupMember } from "../types.ts";
import { FieldRow, InlineInput } from "./Fields.tsx";

import styles from "./Compose.module.css";

export interface PayerTableProps {
  members: readonly GroupMember[];
  /** What each payer has typed. A person absent from the map is not a payer. */
  payers: Readonly<Record<string, string>>;
  payerId: string;
  onPayer: (partyId: string, text: string) => void;
}

export function PayerTable(props: PayerTableProps): ReactNode {
  return (
    <FieldRow label={FIELD_KEYS.payers} note={FIELD_NOTES.payers}>
      <div className={styles.payerTable}>
        {props.members.map((member) => (
          <div key={member.party_id} className={styles.allocRow}>
            <span className={styles.allocName}>{displayText(member.name)}</span>
            <InlineInput
              id={`tally-paid-${member.party_id}`}
              label={`Paid by ${member.name}`}
              value={props.payers[member.party_id] ?? ""}
              placeholder={PLACEHOLDERS.amount}
              onChange={(text) => props.onPayer(member.party_id, text)}
            />
            <span className={styles.allocNote}>
              {props.payers[member.party_id] === undefined &&
              member.party_id === props.payerId
                ? LINE_VERBS.paidItAll
                : ""}
            </span>
          </div>
        ))}
      </div>
    </FieldRow>
  );
}

export interface LineTableProps {
  lines: readonly LineDraft[];
  members: readonly GroupMember[];
  onLines: (lines: readonly LineDraft[]) => void;
  onAdd: () => void;
}

/** The same object the Receipt surface allocates, without the photograph;
 *  `line-model.ts` folds them into the shares, so a typed split and a
 *  photographed one are the same arithmetic. */
export function LineTable(props: LineTableProps): ReactNode {
  const replace = (index: number, next: LineDraft): void =>
    props.onLines(props.lines.map((line, at) => (at === index ? next : line)));

  return (
    <FieldRow label={FIELD_KEYS.lines} note={FIELD_NOTES.lines}>
      <div className={styles.lineTable}>
        {props.lines.map((line, index) => (
          <div key={line.lineId} className={styles.lineRow}>
            <InlineInput
              id={`tally-line-what-${line.lineId}`}
              label={FIELD_KEYS.what}
              value={line.description}
              placeholder={PLACEHOLDERS.line}
              onChange={(description) =>
                replace(index, { ...line, description })
              }
            />
            <InlineInput
              id={`tally-line-amount-${line.lineId}`}
              label={FIELD_KEYS.amount}
              value={line.amount}
              placeholder={PLACEHOLDERS.amount}
              onChange={(amount) => replace(index, { ...line, amount })}
            />
            <fieldset
              className={styles.lineWho}
              aria-label={`${LINE_VERBS.whoWasOn} ${line.description || String(index + 1)}`}
            >
              {props.members.map((member) => (
                <button
                  key={member.party_id}
                  type="button"
                  className="kit-chip"
                  aria-pressed={line.who.includes(member.party_id)}
                  onClick={() =>
                    replace(index, {
                      ...line,
                      who: line.who.includes(member.party_id)
                        ? line.who.filter((id) => id !== member.party_id)
                        : [...line.who, member.party_id],
                    })
                  }
                >
                  {displayText(member.name)}
                </button>
              ))}
              {/* Tax and service are lines like any other and are allocated
                  the same way; only the word differs. */}
              <button
                type="button"
                className="kit-chip"
                aria-pressed={line.kind === "tax"}
                onClick={() =>
                  replace(index, {
                    ...line,
                    kind: line.kind === "tax" ? "item" : "tax",
                  })
                }
              >
                {LINE_KIND_LABEL.tax}
              </button>
              <button
                type="button"
                className="kit-chip"
                aria-pressed={line.kind === "tip"}
                onClick={() =>
                  replace(index, {
                    ...line,
                    kind: line.kind === "tip" ? "item" : "tip",
                  })
                }
              >
                {LINE_KIND_LABEL.tip}
              </button>
            </fieldset>
            <button
              type="button"
              className={`kit-plain-btn ${styles.lineDrop}`}
              onClick={() =>
                props.onLines(props.lines.filter((_, at) => at !== index))
              }
            >
              {LINE_VERBS.remove}
            </button>
          </div>
        ))}
        <button type="button" className="kit-btn" onClick={props.onAdd}>
          {LINE_VERBS.add}
        </button>
      </div>
    </FieldRow>
  );
}
