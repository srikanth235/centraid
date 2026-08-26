// ADD EXPENSE — the most rule-dense surface in the app (Tally spec §3).
//
// Two typed fields, and everything else a chip, because everything else is a
// choice from a set. The allocation table and the reconcile line under it
// change WITH the division: the odd penny for equal, a penny of tolerance for
// exact amounts, "it will not commit at 99" for percentages, weights for
// shares, an equal base with an adjustment, typed lines.
//
// THREE OF THE SIX COMMIT, and the other three are drawn in FULL rather than
// hidden: the table renders the shares they would write, the reconcile line
// reads them back, and the commit is refused with the gap named. A member
// deciding whether "By line" is worth asking for has to be able to see it.
//
// *NO GROUP* IS DRAWN AND REFUSED. `tally.add_expense` requires `group_id`
// with a `group_exists` precondition, and `app.json` mirrors it — so the chip
// exists, the note carries the open question, and the commit says why rather
// than sending a write the vault would reject (GAPS.md Tally §4).
//
// THIS SCREEN COMPUTES, AND THAT IS NOT A CONTRADICTION. Every figure Tally
// READS arrives folded by the one balance engine; the shares below are an
// INPUT being validated before it is sent, which `app.json` asks for by name.
// The arithmetic lives in `split-model.ts` and `draft-model.ts`, tested, and
// none of it is written to the vault as a balance.
import type { ReactNode } from "react";

import {
  ADD_COMMIT,
  ADD_HEAD,
  ADD_LEDE,
  CANCEL,
  CURRENCY_CHIPS,
  CURRENCY_NOTE,
  EDIT_COMMIT,
  EDIT_HEAD,
  FIELD_KEYS,
  FIELD_NOTES,
  NO_GROUP_LABEL,
  PLACEHOLDERS,
  WHEN_CHIPS,
  addFoot,
} from "../compose-copy.ts";
import { CATEGORIES, entryValues, settlementMinor } from "../draft-model.ts";
import type { DraftVerdict, ExpenseDraft } from "../draft-model.ts";
import { money } from "../format.ts";
import { DIVISIONS, divisionSpec } from "../split-model.ts";
import type { Division } from "../split-model.ts";
import type { GroupMember, GroupSummary } from "../types.ts";
import {
  AllocTable,
  ChipSet,
  Editor,
  EditorFoot,
  EditorHead,
  FieldRow,
  InlineInput,
  TypedRow,
  ValueRow,
} from "./Fields.tsx";
import type { AllocRow, ChipOption } from "./Fields.tsx";

/** The day before a day key, in UTC on the key itself — the same arithmetic
 *  `activity-model.ts` does, for the same reason. */
function yesterdayOf(today: string): string {
  const stamp = Date.parse(`${today.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(stamp)) return today;
  return new Date(stamp - 86_400_000).toISOString().slice(0, 10);
}

export interface AddExpenseProps {
  draft: ExpenseDraft;
  /** Editing an expense that already exists rather than adding one. */
  editing: boolean;
  /** The chosen group's members, in the order the table draws them. Empty
   *  while the group's own read has not landed — and then the table is ABSENT
   *  rather than drawn empty. */
  members: readonly GroupMember[];
  groups: readonly GroupSummary[];
  /** What the group settles in. */
  currency: string;
  today: string;
  verdict: DraftVerdict;
  onPatch: (patch: Partial<ExpenseDraft>) => void;
  onEntry: (partyId: string, text: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}

function groupChips(groups: readonly GroupSummary[]): ChipOption[] {
  return [
    ...groups.map((group) => ({ id: group.group_id, label: group.name })),
    { id: "", label: NO_GROUP_LABEL },
  ];
}

function whenChip(draft: ExpenseDraft, today: string): string {
  if (draft.spentOn === today) return "today";
  return draft.spentOn === yesterdayOf(today) ? "yesterday" : "pick";
}

/** The unit's own label for one typed cell, so three inputs in a row are three
 *  named controls rather than three boxes. */
function cellLabel(division: Division, name: string): string {
  const unit = divisionSpec(division).unit;
  if (unit === "percent") return `Percentage for ${name}`;
  if (unit === "shares") return `Shares for ${name}`;
  return division === "adjust"
    ? `Adjustment for ${name}`
    : `Amount for ${name}`;
}

function allocRows(props: AddExpenseProps): AllocRow[] {
  const { draft, verdict } = props;
  const unit = divisionSpec(draft.division).unit;
  const byParty = new Map(
    (verdict.allocation?.shares ?? []).map((share) => [
      share.party_id,
      share.share_minor,
    ])
  );
  const values = entryValues(draft.division, draft.entries);
  const amount = verdict.amountMinor ?? 0;
  const evenly = amount % Math.max(1, props.members.length) === 0;
  return props.members.map((member) => ({
    partyId: member.party_id,
    name: member.name,
    figure: money(byParty.get(member.party_id) ?? 0, props.currency),
    ...(unit === "derived"
      ? {}
      : {
          typed: {
            value: draft.entries[member.party_id] ?? "",
            label: cellLabel(draft.division, member.name),
            onChange: (text: string) => props.onEntry(member.party_id, text),
          },
        }),
    ...(draft.division === "equal" &&
    !evenly &&
    member.party_id === draft.payerId
      ? { note: "remainder, one penny" }
      : {}),
    ...(unit === "percent" ? { note: `${values[member.party_id] ?? 0}%` } : {}),
  }));
}

export function AddExpense(props: AddExpenseProps): ReactNode {
  const { draft, verdict } = props;
  const settlement = settlementMinor(draft);
  const groupName =
    props.groups.find((group) => group.group_id === draft.groupId)?.name ??
    null;
  const payers: ChipOption[] = props.members.map((member) => ({
    id: member.party_id,
    label: member.name,
  }));
  const when = whenChip(draft, props.today);

  return (
    <Editor>
      <EditorHead head={props.editing ? EDIT_HEAD : ADD_HEAD} lede={ADD_LEDE} />

      <TypedRow
        id="tally-add-what"
        label={FIELD_KEYS.what}
        value={draft.description}
        placeholder={PLACEHOLDERS.description}
        onChange={(description) => props.onPatch({ description })}
      />
      <TypedRow
        id="tally-add-amount"
        label={FIELD_KEYS.amount}
        value={draft.amount}
        placeholder={PLACEHOLDERS.amount}
        num
        onChange={(amount) => props.onPatch({ amount })}
      />

      <FieldRow label={FIELD_KEYS.paidBy} note={FIELD_NOTES.paidBy}>
        <ChipSet
          options={payers}
          value={draft.payerId}
          label={FIELD_KEYS.paidBy}
          onPick={(payerId) => props.onPatch({ payerId })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.group} note={FIELD_NOTES.group}>
        <ChipSet
          options={groupChips(props.groups)}
          value={draft.groupId ?? ""}
          label={FIELD_KEYS.group}
          onPick={(id) => props.onPatch({ groupId: id === "" ? null : id })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.category} note={FIELD_NOTES.category}>
        <ChipSet
          options={CATEGORIES.map(([id, label]) => ({ id, label }))}
          value={draft.category}
          label={FIELD_KEYS.category}
          onPick={(category) => props.onPatch({ category })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.when} note={FIELD_NOTES.when}>
        <ChipSet
          options={[
            { id: "today", label: WHEN_CHIPS.today },
            { id: "yesterday", label: WHEN_CHIPS.yesterday },
            { id: "pick", label: WHEN_CHIPS.pick },
          ]}
          value={when}
          label={FIELD_KEYS.when}
          onPick={(id) =>
            props.onPatch({
              spentOn:
                id === "today"
                  ? props.today
                  : id === "yesterday"
                    ? yesterdayOf(props.today)
                    : draft.spentOn,
            })
          }
        />
        {when === "pick" ? (
          <InlineInput
            id="tally-add-date"
            label={FIELD_KEYS.when}
            type="date"
            value={draft.spentOn}
            onChange={(spentOn) => props.onPatch({ spentOn })}
          />
        ) : null}
      </FieldRow>

      <FieldRow
        label={FIELD_KEYS.currency}
        note={draft.foreign ? CURRENCY_NOTE : FIELD_NOTES.settlementCurrency}
      >
        <ChipSet
          options={[
            { id: "home", label: `${CURRENCY_CHIPS.home} · ${props.currency}` },
            { id: "other", label: CURRENCY_CHIPS.other },
          ]}
          value={draft.foreign ? "other" : "home"}
          label={FIELD_KEYS.currency}
          onPick={(id) => props.onPatch({ foreign: id === "other" })}
        />
        {draft.foreign ? (
          <>
            <InlineInput
              id="tally-add-cur"
              label={FIELD_KEYS.entered}
              value={draft.currency}
              placeholder={PLACEHOLDERS.currency}
              onChange={(currency) => props.onPatch({ currency })}
            />
            <InlineInput
              id="tally-add-rate"
              label={FIELD_KEYS.rate}
              value={draft.rate}
              placeholder={PLACEHOLDERS.rate}
              onChange={(rate) => props.onPatch({ rate })}
            />
            <InlineInput
              id="tally-add-rate-source"
              label={FIELD_KEYS.source}
              value={draft.rateSource}
              placeholder={PLACEHOLDERS.rateSource}
              onChange={(rateSource) => props.onPatch({ rateSource })}
            />
            <InlineInput
              id="tally-add-rate-date"
              label={FIELD_KEYS.when}
              type="date"
              value={draft.rateDate}
              onChange={(rateDate) => props.onPatch({ rateDate })}
            />
          </>
        ) : null}
      </FieldRow>

      {draft.foreign && settlement !== null ? (
        <ValueRow
          label={props.currency}
          value={money(settlement, props.currency)}
          num
        />
      ) : null}

      <FieldRow label={FIELD_KEYS.divided} note={FIELD_NOTES.divided}>
        <ChipSet
          options={DIVISIONS.map((spec) => ({
            id: spec.id,
            label: spec.backed
              ? spec.label
              : `${spec.label} · [backend-needed]`,
          }))}
          value={draft.division}
          label={FIELD_KEYS.divided}
          onPick={(id) => props.onPatch({ division: id as Division })}
        />
      </FieldRow>

      {/* ABSENT IS NOT EMPTY: before the group's members land there is no
          table, because an empty one would claim the group has nobody in it. */}
      {props.members.length > 0 && verdict.allocation ? (
        <AllocTable
          head={FIELD_NOTES.alloc}
          rows={allocRows(props)}
          reconcile={verdict.allocation.line}
          balanced={verdict.allocation.balanced}
        />
      ) : null}

      <EditorFoot
        copy={addFoot(draft.groupId === null ? null : groupName)}
        cancelLabel={CANCEL}
        onCancel={props.onCancel}
        commit={{
          label: props.editing ? EDIT_COMMIT : ADD_COMMIT,
          ...(verdict.ok ? {} : { refusal: verdict.refusal ?? "" }),
          run: props.onCommit,
        }}
      />
    </Editor>
  );
}
