// SETTLE UP — a payment that HAPPENED, recorded (Tally spec §3, FLOWS.md).
//
// FROM AND TO ARE BOTH OPEN, so two friends can settle with the owner as
// neither party; when they do, the foot says the §6 line out loud — the
// settlement changes a balance and writes no ledger entry of the owner's.
//
// THE GROUP SCOPE INCLUDES *NO GROUP*, and here that is a real choice rather
// than a stated gap: `settle-up` declares `group_id` optional and the vault
// command agrees. It is the same chip Add expense has to refuse, which is
// exactly why GAPS.md §4 phrases the open question the way it does —
// settlements already work group-less.
//
// A PARTIAL PAYMENT IS A SMALLER AMOUNT. There is no partial mode, no
// percentage of a balance and no "settle everything" button: the member types
// what they paid.
//
// THE SIMPLIFICATION PROPOSAL IS DRAWN AGAINST THE ASK, and drawn WITHOUT
// invented rows. The ruling is opt-in per group, off by default, because it
// rewires who owes whom and a member who agreed to pay Ana should not silently
// owe Tom. No minimal-transfer engine exists, so this app cannot know what the
// three payments would be — printing a plausible three would be inventing
// figures on the one screen whose whole subject is that figures are derived.
// The head, the §6 sentence, the current state and a refused commit are the
// honest whole of it.
import type { ReactNode } from "react";

import {
  BANK_LINE_VALUE,
  CANCEL,
  FIELD_KEYS,
  PLACEHOLDERS,
  SETTLE_COMMIT,
  SETTLE_FOOT_THEIRS,
  SETTLE_FOOT_YOURS,
  SETTLE_HEAD,
  SETTLE_LEDE,
  SETTLE_NOTES,
  SIMPLIFICATION,
  SIMPLIFY_COMMIT,
  SIMPLIFY_HEAD,
  SIMPLIFY_OFF,
  SIMPLIFY_UNBUILT,
  NO_GROUP_LABEL,
  WHEN_CHIPS,
} from "../compose-copy.ts";
import type { SettleDraft, SettleVerdict } from "../draft-model.ts";
import type { FriendSummary, GroupSummary, Person } from "../types.ts";
import {
  ChipSet,
  Editor,
  EditorFoot,
  EditorHead,
  FieldRow,
  InlineInput,
  TypedRow,
} from "./Fields.tsx";
import type { ChipOption } from "./Fields.tsx";

import styles from "./Compose.module.css";

export interface SettleScreenProps {
  draft: SettleDraft;
  /** Everyone this vault can name: the owner and their friends. */
  friends: readonly FriendSummary[];
  me: string | null;
  meName: string;
  groups: readonly GroupSummary[];
  currency: string;
  today: string;
  verdict: SettleVerdict;
  onPatch: (patch: Partial<SettleDraft>) => void;
  onCancel: () => void;
  onCommit: () => void;
}

function parties(props: SettleScreenProps): ChipOption[] {
  const rows: ChipOption[] = props.me
    ? [{ id: props.me, label: props.meName }]
    : [];
  for (const friend of props.friends as readonly Person[])
    rows.push({ id: friend.party_id, label: friend.name });
  return rows;
}

export function SettleScreen(props: SettleScreenProps): ReactNode {
  const { draft, verdict } = props;
  const people = parties(props);

  return (
    <Editor>
      <EditorHead head={SETTLE_HEAD} lede={SETTLE_LEDE} />

      <TypedRow
        id="tally-settle-amount"
        label={FIELD_KEYS.amount}
        value={draft.amount}
        placeholder={PLACEHOLDERS.amount}
        num
        onChange={(amount) => props.onPatch({ amount })}
      />

      <FieldRow label={FIELD_KEYS.from} note={SETTLE_NOTES.from}>
        <ChipSet
          options={people}
          value={draft.fromId}
          label={FIELD_KEYS.from}
          onPick={(fromId) => props.onPatch({ fromId })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.to}>
        <ChipSet
          options={people}
          value={draft.toId}
          label={FIELD_KEYS.to}
          onPick={(toId) => props.onPatch({ toId })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.group} note={SETTLE_NOTES.group}>
        <ChipSet
          options={[
            ...props.groups.map((group) => ({
              id: group.group_id,
              label: group.name,
            })),
            { id: "", label: NO_GROUP_LABEL },
          ]}
          value={draft.groupId ?? ""}
          label={FIELD_KEYS.group}
          onPick={(id) => props.onPatch({ groupId: id === "" ? null : id })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.when}>
        <ChipSet
          options={[{ id: "today", label: WHEN_CHIPS.today }]}
          value={draft.paidOn === props.today ? "today" : null}
          label={FIELD_KEYS.when}
          onPick={() => props.onPatch({ paidOn: props.today })}
        />
        <InlineInput
          id="tally-settle-date"
          label={FIELD_KEYS.when}
          type="date"
          value={draft.paidOn}
          onChange={(paidOn) => props.onPatch({ paidOn })}
        />
      </FieldRow>

      {/* SURFACED, AND HONEST ABOUT ITS DOOR. Binding a settlement to an
          imported transaction is an assistant-only command today; the row is
          where it belongs, and the note says so. */}
      <FieldRow label={FIELD_KEYS.bankLine} note={SETTLE_NOTES.bankLine}>
        <span className={styles.value}>{BANK_LINE_VALUE}</span>
      </FieldRow>

      <div className={styles.tableHead}>{SIMPLIFY_HEAD}</div>
      <p className={styles.lede}>{SIMPLIFICATION}</p>
      <p className={styles.note}>{SIMPLIFY_OFF}</p>
      <p className={styles.note}>{SIMPLIFY_UNBUILT}</p>
      <div className={styles.foot}>
        <span className={styles.footCopy} />
        <span className={styles.footActs}>
          <button type="button" className="kit-btn" disabled>
            {SIMPLIFY_COMMIT}
          </button>
        </span>
      </div>

      <EditorFoot
        copy={verdict.yours ? SETTLE_FOOT_YOURS : SETTLE_FOOT_THEIRS}
        cancelLabel={CANCEL}
        onCancel={props.onCancel}
        commit={{
          label: SETTLE_COMMIT,
          ...(verdict.ok ? {} : { refusal: verdict.refusal ?? "" }),
          run: props.onCommit,
        }}
      />
    </Editor>
  );
}
