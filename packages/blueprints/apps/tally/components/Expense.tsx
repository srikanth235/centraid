import type { ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  CONFLICT_BOTH,
  CURRENCY_NOTE,
  CURRENCY_NOTE_2,
  EXPENSE_NOTES,
  EXPENSE_ROWS,
  FIELD_KEYS,
  LIFE_ACTS,
  PAID_IT,
  PENDING_STRIP,
  PENDING_VIEW,
  UNDO_SPENT,
  UNDO_VERB,
  dividedValue,
  revisionCount,
  splitFoot,
} from "../compose-copy.ts";
import { metaSentence, money, roleSubLabel } from "../format.ts";
import { DIVISIONS } from "../split-model.ts";
import type { LedgerEntry, Revision } from "../types.ts";
import { paidBy } from "../view-copy.ts";
import { Note, Rows, Section } from "./Blocks.tsx";
import { ValueRow } from "./Fields.tsx";

import styles from "./Compose.module.css";

export function undoIsLive(revision: Revision, nowIso: string): boolean {
  if (revision.undone_at) return false;
  const until = Date.parse(revision.undo_until);
  const now = Date.parse(nowIso);
  return !Number.isNaN(until) && !Number.isNaN(now) && now < until;
}

export interface ExpenseScreenProps {
  entry: LedgerEntry;
  groupName?: string;
  currency: string;
  me: string | null;
  revisions: readonly Revision[] | null;
  now: string;
  narrow: boolean;
  onEdit: () => void;
  onItemise: () => void;
  onTrash: () => void;
  onWaiting: () => void;
  onUndo: (revisionId: string) => void;
}

function paidValue(entry: LedgerEntry, currency: string): string {
  const payers = entry.payers ?? [];
  if (payers.length === 0)
    return `${entry.paid_by_name} · ${money(entry.amount_minor, currency)}`;
  return payers
    .map((payer) => `${payer.name} · ${money(payer.paid_minor, currency)}`)
    .join("  ·  ");
}

function dividedText(entry: LedgerEntry): string {
  const spec = DIVISIONS.find((row) => row.method === entry.split_method);
  return spec ? spec.label : dividedValue(entry.splits.length);
}

function currencyValue(entry: LedgerEntry): string {
  const rate = entry.rate_scaled / 10 ** entry.rate_scale;
  return metaSentence([
    `${money(entry.original_amount_minor, entry.original_currency)} at ${rate}`,
    entry.rate_source,
    entry.rate_date,
  ]);
}

export function ExpenseScreen(props: ExpenseScreenProps): ReactNode {
  const { entry } = props;
  const isMine =
    props.me !== null &&
    (entry.paid_by === props.me ||
      (entry.payers ?? []).some((payer) => payer.party_id === props.me));
  const pending = entry.pending === true;
  const conflict = entry.intentStatus === "conflict";
  const foreign = entry.original_currency !== entry.settlement_currency;
  const revisions = props.revisions;

  return (
    <div className={styles.detail}>
      {pending ? (
        <div className={styles.strip}>
          <span className={styles.stripCopy}>{PENDING_STRIP}</span>
          <button
            type="button"
            className="kit-plain-btn"
            onClick={props.onWaiting}
          >
            {PENDING_VIEW}
          </button>
          {/* Retry and Discard are the OUTBOX's verbs, drawn by the one shared
              component every app uses, so a held write reads identically here
              and in Tasks. */}
          <PendingWriteActions
            row={entry as unknown as Record<string, unknown>}
          />
        </div>
      ) : null}

      <div className={styles.detailHead}>
        <span className={`${styles.detailFig} ${styles.num}`}>
          {money(entry.amount_minor, props.currency)}
        </span>
        <h2 className={styles.detailTitle}>
          {displayText(entry.description ?? "")}
        </h2>
        <p className={styles.detailLede}>
          {metaSentence([
            paidBy(entry.paid_by_name, isMine),
            props.groupName,
            entry.spent_on,
          ])}
        </p>
      </div>

      <ValueRow
        label={FIELD_KEYS.paidBy}
        value={paidValue(entry, props.currency)}
        note={EXPENSE_NOTES.paidBy}
        num
      />
      <ValueRow
        label={FIELD_KEYS.divided}
        value={metaSentence([
          dividedText(entry),
          dividedValue(entry.splits.length),
        ])}
        note={EXPENSE_NOTES.divided}
      />
      <ValueRow
        label={FIELD_KEYS.yourShare}
        value={`${money(entry.your_amount_minor, props.currency)} · ${roleSubLabel(entry.your_role)}`}
        note={EXPENSE_NOTES.yourShare}
        num
      />
      <ValueRow label={FIELD_KEYS.category} value={entry.category ?? ""} />
      <ValueRow
        label={FIELD_KEYS.group}
        value={props.groupName ?? ""}
        note={EXPENSE_NOTES.group}
      />
      {foreign ? (
        <ValueRow
          label={FIELD_KEYS.currency}
          value={currencyValue(entry)}
          note={[CURRENCY_NOTE, CURRENCY_NOTE_2]}
          num
        />
      ) : null}
      {/* SURFACED, AND HONEST ABOUT ITS DOOR. The memo and the bank line are
          real capabilities that only the assistant can write today; the row is
          where they belong, and the note says so rather than a control
          pretending otherwise. */}
      <ValueRow
        label={FIELD_KEYS.memo}
        value={EXPENSE_ROWS.noMemo}
        note={EXPENSE_NOTES.memo}
      />
      <ValueRow
        label={FIELD_KEYS.bankLine}
        value={EXPENSE_ROWS.noBankLine}
        note={EXPENSE_NOTES.bankLine}
      />

      <Section
        label={EXPENSE_ROWS.splitHead}
        count={entry.splits.length}
        narrow={props.narrow}
      >
        <Rows>
          {entry.splits.map((split) => (
            <div key={split.party_id} className={styles.allocRow}>
              <span className={styles.allocName}>
                {displayText(split.name)}
              </span>
              <span className={`${styles.allocValue} ${styles.num}`}>
                {money(split.share_minor, props.currency)}
              </span>
              <span className={styles.allocNote}>
                {(entry.payers ?? []).some(
                  (payer) => payer.party_id === split.party_id
                ) || split.party_id === entry.paid_by
                  ? PAID_IT
                  : ""}
              </span>
            </div>
          ))}
        </Rows>
        <Note>
          {splitFoot(
            money(entry.amount_minor, props.currency),
            entry.splits.length
          )}
        </Note>
      </Section>

      {conflict ? <Note>{CONFLICT_BOTH}</Note> : null}

      {revisions ? (
        <Section
          label={EXPENSE_ROWS.revisions}
          meta={revisionCount(revisions.length)}
          count={revisions.length}
          empty={EXPENSE_ROWS.noRevisions}
          narrow={props.narrow}
        >
          <Rows>
            {revisions.map((revision) => (
              <div key={revision.revision_id} className={styles.revision}>
                <span className={`${styles.revWhen} ${styles.num}`}>
                  {revision.recorded_at.slice(0, 16).replace("T", " ")}
                </span>
                <span className={styles.revWhat}>
                  {displayText(revision.operation)}
                </span>
                <span className={styles.revActs}>
                  {undoIsLive(revision, props.now) ? (
                    <button
                      type="button"
                      className="kit-plain-btn"
                      onClick={() => props.onUndo(revision.revision_id)}
                    >
                      {UNDO_VERB}
                    </button>
                  ) : (
                    <span className={styles.note}>
                      {revision.undone_at ? UNDO_SPENT : ""}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </Rows>
          <Note>{EXPENSE_NOTES.history}</Note>
        </Section>
      ) : null}

      <div className={styles.foot}>
        <span className={styles.footCopy} />
        <span className={styles.footActs}>
          <button type="button" className="kit-btn" onClick={props.onEdit}>
            {LIFE_ACTS.edit}
          </button>
          {entry.receipt ? (
            <button type="button" className="kit-btn" onClick={props.onItemise}>
              {LIFE_ACTS.itemise}
            </button>
          ) : null}
          {/* DESTRUCTIVE IS OUTLINED IN `--net`, never filled. */}
          <button
            type="button"
            className="kit-btn destructive"
            onClick={props.onTrash}
          >
            {LIFE_ACTS.trash}
          </button>
        </span>
      </div>
    </div>
  );
}
