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
import { degradationCopy, passwordAge } from "../field-model.ts";
import { typeLabel, verdictOf } from "../format.ts";
import {
  DEGRADED_ROW,
  PASSWORD_AGE_NOTE,
  PASSWORD_AGE_ROW,
} from "../item-copy.ts";
import { metadataFieldsFor, sealedFieldsFor } from "../item-fields.ts";
import type { LockerDetail, LockerRow } from "../types.ts";
import { COMPROMISED_WHY, TRASH_CONFIRM_BODY } from "../view-copy.ts";
import { FieldRow, SealedField, StrengthField, TotpField } from "./Fields.tsx";
import {
  AddressSection,
  AttachmentSection,
  FieldSections,
  FieldsHead,
  HistorySection,
  LifeRows,
  PasskeySection,
  degradedText,
} from "./ItemSidecars.tsx";
import type { SidecarRevealProps } from "./ItemSidecars.tsx";

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
  /** Keep it forever and take it out of the lists — the opposite end of the
   *  trash's countdown, never the same act. */
  onArchive: () => void;
  /** Clone-and-edit for a sibling account. */
  onDuplicate: () => void;
  onCopySecret: (field: string) => void;
  onCopyCode: (code: string) => void;
  onConceal: (field: string) => void;
  onCopyMetadata: (value: string, label: string) => void;
  onOpenAddress: (url: string) => void;
  onStar: () => void;
  onGenerate: () => void;
  onTrash: () => void;
}

export function ItemScreen(props: ItemScreenProps): ReactNode {
  const { detail } = props;
  // ONE SET OF VERBS FOR EVERY SEALED ROW ON THIS SCREEN (#873). The item's own
  // columns and the sealed sidecars read the same reveal state and call the
  // same three handlers — which is what makes "a secret is a row with a verb"
  // true of a custom field and a retained password, not only of a password.
  const reveal: SidecarRevealProps = {
    revealed: props.revealed,
    revealedAt: props.revealedAt,
    now: props.now,
    onReveal: props.onReveal,
    onCopy: props.onCopySecret,
    onConceal: props.onConceal,
  };
  const verdict = props.row ? verdictOf(props.row) : null;
  const password = props.revealed.password ?? null;
  const address = detail.url ? safeExternalUrl(detail.url) : null;
  const exactHost = detail.url_match_policy === "exact-host";
  const ageCopy = passwordAge(detail.password_set_at, props.now);

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

      {/* A TYPE THIS BUILD CANNOT DRAW IS NAMED, NOT RELABELLED. The item
          opens as a note that still carries its fields, and the row says what
          the vault actually stores — silently rendering it as a note would be
          this app renaming a member's own data. */}
      {detail.degraded_from ? (
        <FieldRow
          label={DEGRADED_ROW}
          value={degradedText(detail.degraded_from)}
          note={degradationCopy(detail.degraded_from) ?? ""}
        />
      ) : null}

      {detail.compromised ? (
        <FieldRow label="Compromised" value="Flagged" note={COMPROMISED_WHY} />
      ) : null}

      {metadataFieldsFor(detail).map((row) => (
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

      {sealedFieldsFor(detail.type).map((field) => (
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

      {/* THE AGE OF THE CURRENT PASSWORD — read off the item's own clock, not
          off a revealed value, so it stands whether or not anything is open.
          Review scores the same field (`format.isPasswordStale`). */}
      {ageCopy ? (
        <FieldRow
          label={PASSWORD_AGE_ROW}
          value={ageCopy}
          numeric
          note={PASSWORD_AGE_NOTE}
        />
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

      {/* READ BACK AT LAST (#872). The binding that exists is shown, and the
          form above it can clear or reassign it — the first of the paper cuts
          README-Locker §8 names. */}
      <FieldRow
        label="Alias"
        value={detail.alias ? displayText(detail.alias) : "None"}
        note="A stable name an automation can hold, so rotating the secret does not break it."
      />

      <FieldRow
        label="Memo"
        value={detail.notes ?? "No memo."}
        note="Plaintext, yours, never a secret and never searched."
      />

      <FieldsHead detail={detail} />
      <FieldSections detail={detail} reveal={reveal} />
      <AddressSection detail={detail} onOpen={props.onOpenAddress} />
      <PasskeySection detail={detail} reveal={reveal} />
      <AttachmentSection detail={detail} />
      <HistorySection detail={detail} />

      <LifeRows
        detail={detail}
        onArchive={props.onArchive}
        onDuplicate={props.onDuplicate}
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
