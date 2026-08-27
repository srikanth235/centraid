// The seven routes this wave draws, resolved to a body.
//
// SPLIT OUT OF `Route.tsx` so the route table stays readable AS a route table.
// The composing routes need a different bundle of state from the ledger lists
// — a draft, a verdict, an allocation, a selection — and threading all of it
// through the one switch would bury the fifteen-route map in editor plumbing.
//
// EVERY ONE OF THEM RENDERS NOTHING RATHER THAN A GUESS. An expense whose
// group ledger has not landed, a receipt whose expense is not loaded, a
// template list before the dashboard answers: each is ABSENT, because a
// half-drawn expense is a claim about an expense nobody has read.
import type { ReactNode } from "react";

import type { ComposeActs } from "../compose-acts.ts";
import type { ComposeBag, ComposeState } from "../compose-state.ts";
import type { ContribSections } from "../contrib-model.ts";
import type { DraftVerdict, SettleVerdict } from "../draft-model.ts";
import {
  ADD,
  EXPENSE,
  EXPORT,
  RECEIPT,
  RECURRING,
  SETTLE,
  WAITING,
} from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type {
  DashboardData,
  ExportData,
  GroupData,
  GroupMember,
  LedgerEntry,
} from "../types.ts";
import { AddExpense } from "./AddExpense.tsx";
import { ExpenseScreen } from "./Expense.tsx";
import { ExportScreen } from "./Export.tsx";
import { ReceiptScreen } from "./Receipt.tsx";
import { RecurringScreen } from "./Recurring.tsx";
import { SettleScreen } from "./Settle.tsx";
import { WaitingScreen } from "./Waiting.tsx";

/** Everything the composing routes stand on, assembled once by the
 *  orchestrator so no leaf has to ask a second question of the room. */
export interface ComposeView {
  state: ComposeState;
  acts: ComposeActs;
  /** The composing bag, dereferenced ONCE by the orchestrator. */
  bag: ComposeBag;
  /** The open expense, re-found in the ledger the room re-read. `null` while
   *  that read is in flight — and then the route draws nothing. */
  entry: LedgerEntry | null;
  verdict: DraftVerdict;
  settleVerdict: SettleVerdict;
  contrib: ContribSections;
  /** Does this host hold an approval inbox at all? */
  hasApprovals: boolean;
  /** An authed `blob:` URL for the open receipt's photograph, or `null`. */
  shotUrl: string | null;
  /** The chosen group's members, empty until that group's read lands. */
  members: readonly GroupMember[];
  /** Does this host hold the per-intent Approve/Decline door? */
  canDecide: boolean;
  /** The chosen group's export payload, or `null` while that read is in
   *  flight — and then the counts are absent rather than zero. */
  exportData: ExportData | null;
}

export interface ComposeRoutesProps {
  shelf: ShelfId;
  dashboard: DashboardData;
  group: GroupData | null;
  compose: ComposeView;
  now: string;
  narrow: boolean;
  compact: boolean;
  offline: boolean;
  meName: string;
  go: (shelf: ShelfId) => void;
  onBack: () => void;
  onWaiting: () => void;
  /** Assemble the file and hand it to the member. Nothing has left the vault
   *  until this runs, which is what the foot says. */
  onSaveExport: () => void;
}

export function ComposeRoutes(props: ComposeRoutesProps): ReactNode {
  const { compose, dashboard } = props;
  const bag = compose.bag;
  const currency = dashboard.currency;
  const today = props.now.slice(0, 10);

  if (props.shelf === ADD) {
    return (
      <AddExpense
        draft={bag.draft}
        editing={bag.editing}
        members={compose.members}
        groups={dashboard.groups}
        currency={currency}
        today={today}
        verdict={compose.verdict}
        rateSuggestions={dashboard.rate_suggestions ?? []}
        onPayer={(partyId, text) => compose.state.setPayer(partyId, text)}
        onLines={(lines) => compose.state.setLines(lines)}
        onAddLine={() => compose.state.addLine()}
        onPatch={(patch) => {
          // Choosing a DIVISION rewrites the typed cells, because their unit
          // changed; every other field is an ordinary patch.
          if (patch.division === undefined) {
            compose.state.patchDraft(patch);
            return;
          }
          compose.state.setDivision(
            patch.division,
            compose.verdict.amountMinor ?? 0,
            compose.members.map((member) => member.party_id)
          );
        }}
        onEntry={(partyId, text) => compose.state.setEntry(partyId, text)}
        onCancel={props.onBack}
        onCommit={() => compose.acts.commitExpense()}
      />
    );
  }

  if (props.shelf === EXPENSE) {
    const entry = compose.entry;
    if (!entry) return null;
    return (
      <ExpenseScreen
        entry={entry}
        {...(props.group?.group?.name
          ? { groupName: props.group.group.name }
          : {})}
        currency={currency}
        me={dashboard.me}
        revisions={compose.state.revisions}
        now={props.now}
        narrow={props.narrow}
        onEdit={() => {
          compose.acts.openEditFrom(entry);
          props.go(ADD);
        }}
        onItemise={() => props.go(RECEIPT)}
        onTrash={() =>
          compose.state.show({ kind: "trash", expenseId: entry.expense_id })
        }
        onWaiting={props.onWaiting}
        onUndo={(revisionId) => compose.acts.undo(entry.expense_id, revisionId)}
      />
    );
  }

  if (props.shelf === RECEIPT) {
    const entry = compose.entry;
    if (!entry) return null;
    return (
      <ReceiptScreen
        entry={entry}
        members={compose.members}
        currency={currency}
        me={dashboard.me}
        compact={props.compact}
        selection={bag.selection}
        shotUrl={compose.shotUrl}
        onToggle={(lineId, partyId) =>
          compose.state.toggleLine(lineId, partyId)
        }
        onCancel={props.onBack}
        onCommit={() => compose.acts.reallocate(entry, bag.selection)}
      />
    );
  }

  if (props.shelf === SETTLE) {
    return (
      <SettleScreen
        draft={bag.settle}
        friends={dashboard.friends}
        me={dashboard.me}
        meName={props.meName}
        groups={dashboard.groups}
        currency={currency}
        today={today}
        verdict={compose.settleVerdict}
        simplification={props.group?.simplification ?? null}
        names={
          new Map(
            (props.group?.members ?? []).map((member) => [
              member.party_id,
              member.name,
            ])
          )
        }
        onPatch={(patch) => compose.state.patchSettle(patch)}
        onSimplify={(simplify) => {
          const groupId = bag.settle.groupId;
          if (groupId) compose.acts.setSimplify(groupId, simplify);
        }}
        onCancel={props.onBack}
        onCommit={() => compose.acts.commitSettle()}
      />
    );
  }

  if (props.shelf === RECURRING) {
    return (
      <RecurringScreen
        templates={dashboard.recurring}
        groups={dashboard.groups}
        now={props.now}
        narrow={props.narrow}
        offline={props.offline}
        onPause={(template) => compose.acts.pauseTemplate(template)}
        onSkip={(template) => compose.acts.skipTemplate(template)}
        onMaterialise={(due) => compose.acts.materialise(due)}
      />
    );
  }

  if (props.shelf === WAITING) {
    return (
      <WaitingScreen
        sections={compose.contrib}
        hasApprovals={compose.hasApprovals}
        canDecide={compose.canDecide}
        nudges={dashboard.nudges ?? []}
        people={dashboard.friends}
        narrow={props.narrow}
        onVerb={(verb, row) => compose.acts.contribVerb(verb, row)}
      />
    );
  }

  if (props.shelf === EXPORT) {
    return (
      <ExportScreen
        draft={bag.exportDraft}
        groups={dashboard.groups}
        data={compose.exportData}
        onPatch={(patch) => compose.state.patchExport(patch)}
        onCancel={props.onBack}
        onCommit={props.onSaveExport}
      />
    );
  }

  return null;
}
