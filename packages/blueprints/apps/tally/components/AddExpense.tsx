// ADD EXPENSE — the most rule-dense surface in the app (Tally spec §3).
//
// Two typed fields, and everything else a chip, because everything else is a
// choice from a set. The allocation table and the reconcile line under it
// change WITH the division: the odd penny for equal, a penny of tolerance for
// exact amounts, "it will not commit at 99" for percentages, weights for
// shares, an equal base with an adjustment, typed lines.
//
// ALL SIX COMMIT, and each has its own table: five put a cell beside every
// person, *By line* puts a row per line with a chip per member. The reconcile
// line under whichever table is showing reads the shares back, and the commit
// is refused only when the ARITHMETIC refuses — percentages at 99, exact
// amounts a pound out, lines that do not sum.
//
// *NO GROUP* IS A REAL CHOICE. `tally.add_expense` has `group_id` optional and
// checks a group-less expense's participants against the friend roster
// instead of a circle, so the chip writes rather than explains (GAPS.md §4).
//
// SEVERAL PAYERS IS NOT A MODE. The payer chip set still names one person; the
// table beside it takes an amount from anyone who put money down, and clearing
// an amount takes them back out.
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
  CURRENCY_NOTE_2,
  EDIT_COMMIT,
  EDIT_HEAD,
  FIELD_KEYS,
  FIELD_NOTES,
  NO_GROUP_LABEL,
  PLACEHOLDERS,
  RATE_SUGGESTION_NOTE,
  WHEN_CHIPS,
  addFoot,
  rateSuggestionChip,
} from "../compose-copy.ts";
import { CATEGORIES, entryValues, settlementMinor } from "../draft-model.ts";
import type { DraftVerdict, ExpenseDraft } from "../draft-model.ts";
import { money } from "../format.ts";
import type { LineDraft } from "../line-model.ts";
import { DIVISIONS, divisionSpec } from "../split-model.ts";
import type { Division } from "../split-model.ts";
import type { GroupMember, GroupSummary, RateSuggestion } from "../types.ts";
import { LineTable, PayerTable } from "./AddExpenseTables.tsx";
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

import styles from "./Compose.module.css";

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
  /** Rates this vault has already been told, per currency pair — offered as a
   *  prefill and never as a lookup: there is no rate provider in this path. */
  rateSuggestions: readonly RateSuggestion[];
  onPatch: (patch: Partial<ExpenseDraft>) => void;
  onEntry: (partyId: string, text: string) => void;
  onPayer: (partyId: string, text: string) => void;
  onLines: (lines: readonly LineDraft[]) => void;
  onAddLine: () => void;
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

/** The suggestion for the pair this draft names, or nothing. The most recent
 *  one the vault holds, which is what `rate_suggestions` already returns. */
function suggestionFor(props: AddExpenseProps): RateSuggestion | undefined {
  const from = props.draft.currency.trim().toUpperCase();
  if (from === "" || from === props.currency.toUpperCase()) return undefined;
  return props.rateSuggestions.find(
    (row) =>
      row.from_currency.toUpperCase() === from &&
      row.to_currency.toUpperCase() === props.currency.toUpperCase()
  );
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
    // `derived` and `lines` are the two divisions with nothing to type beside
    // a person: equal shares are computed, and typed lines are typed above.
    ...(unit === "derived" || unit === "lines"
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
  const suggestion = suggestionFor(props);

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

      {/* ABSENT UNTIL THERE IS SOMEBODY TO PAY. The payer table needs the
          group's members, exactly as the allocation table does. */}
      {props.members.length > 0 ? (
        <PayerTable
          members={props.members}
          payers={draft.payers}
          payerId={draft.payerId}
          onPayer={props.onPayer}
        />
      ) : null}

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
        note={
          draft.foreign
            ? [CURRENCY_NOTE, CURRENCY_NOTE_2]
            : FIELD_NOTES.settlementCurrency
        }
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
            {/* THE VAULT QUOTING ITSELF, not a provider. One chip, carrying
                the rate WITH its source and date, which is the only form in
                which a rate is allowed to appear on this surface. */}
            {suggestion ? (
              <>
                <ChipSet
                  options={[
                    {
                      id: "suggested",
                      label: rateSuggestionChip(
                        String(
                          suggestion.rate_scaled / 10 ** suggestion.rate_scale
                        ),
                        suggestion.rate_source,
                        suggestion.rate_date
                      ),
                    },
                  ]}
                  value={null}
                  label={FIELD_KEYS.rate}
                  onPick={() =>
                    props.onPatch({
                      rate: String(
                        suggestion.rate_scaled / 10 ** suggestion.rate_scale
                      ),
                      rateSource: suggestion.rate_source,
                      rateDate: suggestion.rate_date,
                    })
                  }
                />
                <span className={styles.note}>{RATE_SUGGESTION_NOTE}</span>
              </>
            ) : null}
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
            label: spec.label,
          }))}
          value={draft.division}
          label={FIELD_KEYS.divided}
          onPick={(id) => props.onPatch({ division: id as Division })}
        />
      </FieldRow>

      {/* BY LINE TYPES LINES, not a cell per person, so it swaps the table
          rather than re-labelling it. */}
      {props.members.length > 0 && draft.division === "lines" ? (
        <LineTable
          lines={draft.lines}
          members={props.members}
          onLines={props.onLines}
          onAdd={props.onAddLine}
        />
      ) : null}

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
