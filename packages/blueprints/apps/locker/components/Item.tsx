// ONE ITEM (README-Locker §1, §5; FLOWS.md "Unlock, re-auth, reveal, copy").
//
// METADATA READS PLAINLY; A SECRET IS A ROW WITH A VERB, and the row states
// the cost of using it — about thirty seconds, and a receipt. Which rows exist
// is decided by the item's TYPE, because a type in this app is a set of
// sections and fields (§3) rather than a label on one shape: a type the vault
// does not have yet degrades to a note with custom fields rather than to
// nothing.
//
// NOTHING ON THIS SCREEN IS REVEALED UNTIL THE MEMBER ASKS. `revealed` is
// empty on arrival and is emptied again by every conceal, every permit
// expiry, every lock and every hide — it lives in the orchestrator's ref bag
// (session.ts `SECRET_BEARING_KEYS`) and is never serialised anywhere.
import type { ReactNode } from "react";

import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { typeLabel, verdictOf } from "../format.ts";
import type { LockerDetail, LockerRow } from "../types.ts";
import { COMPROMISED_WHY, TRASH_CONFIRM_BODY } from "../view-copy.ts";
import { FieldRow, SealedField, StrengthField, TotpField } from "./Fields.tsx";

import styles from "./Rows.module.css";

export interface ItemScreenProps {
  detail: LockerDetail;
  /** The list row for this item, for the verdict chip — the SAME verdict the
   *  list drew, read from the same derivation. */
  row?: LockerRow;
  /** Plaintext values, present only while a reveal is live. */
  revealed: Readonly<Record<string, string>>;
  /** When each reveal landed, for the countdowns. */
  revealedAt: Readonly<Record<string, number>>;
  /** One clock for the whole screen, ticking once a second. */
  now: number;
  onReveal: (field: string) => void;
  onCopySecret: (field: string) => void;
  onCopyCode: (code: string) => void;
  onConceal: (field: string) => void;
  onCopyMetadata: (value: string, label: string) => void;
  onOpenAddress: (url: string) => void;
  onStar: () => void;
  onGenerate: () => void;
  onTrash: () => void;
}

/** The sealed rows one type owns, in the order the screen draws them. */
function sealedFields(
  type: LockerDetail["type"]
): Array<{ field: string; label: string; note?: string }> {
  if (type === "card") {
    return [
      { field: "card_number", label: "Card number" },
      {
        field: "cvv",
        label: "Security code",
        note: "Three digits, sealed like any other secret.",
      },
    ];
  }
  if (type === "note") {
    return [
      {
        field: "content",
        label: "Note",
        note: "Sealed at rest, and deliberately not searched — a note routinely holds recovery codes.",
      },
    ];
  }
  if (type === "wifi") {
    return [
      {
        field: "password",
        label: "Network password",
        note: "Sealed · the network name is not.",
      },
    ];
  }
  if (type === "identity") return [];
  return [{ field: "password", label: "Password" }];
}

/** The metadata rows one type owns. Plain values, no permit, and each says so
 *  once at the top rather than on every line. */
function metadataFields(
  detail: LockerDetail
): Array<{ label: string; value: string; copy?: string }> {
  const rows: Array<{ label: string; value: string; copy?: string }> = [];
  if (detail.username) {
    rows.push({ label: "Username", value: detail.username, copy: "Username" });
  }
  if (detail.type === "identity") {
    if (detail.fullname) rows.push({ label: "Name", value: detail.fullname });
    if (detail.email) {
      rows.push({ label: "Email", value: detail.email, copy: "Email" });
    }
    if (detail.phone) rows.push({ label: "Phone", value: detail.phone });
    if (detail.address) rows.push({ label: "Address", value: detail.address });
  }
  if (detail.type === "card") {
    if (detail.cardholder) {
      rows.push({ label: "Cardholder", value: detail.cardholder });
    }
    if (detail.brand) rows.push({ label: "Brand", value: detail.brand });
  }
  if (detail.type === "wifi" && detail.network) {
    rows.push({ label: "Network", value: detail.network, copy: "Network" });
  }
  return rows;
}

export function ItemScreen(props: ItemScreenProps): ReactNode {
  const { detail } = props;
  const verdict = props.row ? verdictOf(props.row) : null;
  const password = props.revealed.password ?? null;
  const address = detail.url ? safeExternalUrl(detail.url) : null;
  const exactHost = detail.url_match_policy === "exact-host";

  return (
    <article className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.itemTitle}>{displayText(detail.title)}</h2>
        <p className={styles.itemLede}>
          <span>{typeLabel(detail.type)}</span>
          {detail.url ? <span>{displayText(detail.url)}</span> : null}
          {verdict ? (
            <span className={styles.status} data-tone={verdict.tone}>
              {verdict.label}
            </span>
          ) : null}
        </p>
      </header>

      {detail.compromised ? (
        <FieldRow label="Compromised" value="Flagged" note={COMPROMISED_WHY} />
      ) : null}

      {metadataFields(detail).map((row) => (
        <FieldRow
          key={row.label}
          label={row.label}
          value={row.value}
          {...(row.label === "Username"
            ? {
                note: "Metadata · searchable, and it never needed a permit.",
              }
            : {})}
          {...(row.copy
            ? {
                acts: [
                  {
                    label: "Copy",
                    run: () => props.onCopyMetadata(row.value, row.copy ?? ""),
                  },
                ],
              }
            : {})}
        />
      ))}

      {sealedFields(detail.type).map((field) => (
        <SealedField
          key={field.field}
          label={field.label}
          field={field.field}
          revealed={props.revealed[field.field] ?? null}
          revealedAt={props.revealedAt[field.field] ?? null}
          now={props.now}
          {...(field.note ? { note: field.note } : {})}
          onReveal={props.onReveal}
          onCopy={props.onCopySecret}
          onConceal={props.onConceal}
        />
      ))}

      {password ? (
        <StrengthField password={password} onGenerate={props.onGenerate} />
      ) : null}

      {detail.otp_seed !== undefined && detail.type === "login" ? (
        <TotpField
          seed={props.revealed.otp_seed ?? null}
          now={props.now}
          revealedAt={props.revealedAt.otp_seed ?? null}
          onReveal={props.onReveal}
          onCopy={props.onCopyCode}
          onConceal={props.onConceal}
        />
      ) : null}

      {detail.type === "card" && detail.expiry ? (
        <FieldRow
          label="Expiry"
          value={detail.expiry}
          numeric
          note="Read by Review · 90 days out is a verdict."
        />
      ) : null}

      {detail.type === "login" && detail.url ? (
        <FieldRow
          label="Address"
          value={detail.url}
          note={
            exactHost
              ? "Exact host · Companion offers this on that host and nowhere else."
              : "Registrable domain · any host under it."
          }
          {...(address
            ? {
                acts: [
                  { label: "Open", run: () => props.onOpenAddress(address) },
                ],
              }
            : {})}
        />
      ) : null}

      <FieldRow
        label="Tags"
        note="Free-form, and the same vocabulary the rest of the superapp uses."
      >
        <span className={styles.chipRow}>
          {(detail.tags ?? []).length === 0 ? (
            <span className={styles.fieldValue}>No tags.</span>
          ) : (
            (detail.tags ?? []).map((tag) => (
              <span key={tag} className="kit-chip" data-active="true">
                #{displayText(tag)}
              </span>
            ))
          )}
        </span>
      </FieldRow>

      <FieldRow
        label="Starred"
        value={detail.favorite ? "Starred" : "Not starred"}
        note="The one product-wide star — the same one Docs and Photos use."
        acts={[
          { label: detail.favorite ? "Unstar" : "Star", run: props.onStar },
        ]}
      />

      <FieldRow
        label="Alias"
        value={detail.alias ?? "None"}
        note="A stable name an automation can hold, so rotating the secret does not break it."
      />

      <FieldRow
        label="Memo"
        value={detail.notes ?? "No memo."}
        note="Plaintext, yours, never a secret and never searched."
      />

      <div className={styles.life}>
        <button
          type="button"
          className="kit-btn"
          data-net="true"
          onClick={props.onTrash}
          title={TRASH_CONFIRM_BODY}
        >
          Trash
        </button>
      </div>
    </article>
  );
}
