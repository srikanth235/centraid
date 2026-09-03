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

export interface ComposeView {
  state: ComposeState;
  acts: ComposeActs;
  bag: ComposeBag;
  entry: LedgerEntry | null;
  verdict: DraftVerdict;
  settleVerdict: SettleVerdict;
  contrib: ContribSections;
  hasApprovals: boolean;
  shotUrl: string | null;
  members: readonly GroupMember[];
  canDecide: boolean;
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
