import React from "react";

import ChipsBlock from "../../kit/components/ChipsBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import { describeInvocationInput } from "../../lib/decision-detail";
import {
  ALWAYS_SUB,
  ALWAYS_TITLE,
  DENY_SUB,
  DENY_TITLE,
  EDIT_SUB,
  EDIT_TITLE,
  WAITING_CHIPS,
  isAttention,
  matchesFilter,
  needsAuthRowCopy,
  noticeRowCopy,
  outboxRowCopy,
  parkedRowCopy,
  rowVerb,
  scopeRowCopy,
  stagedBody,
  stagedEyebrow,
  stagedFacts,
  stagedTitle,
  waitingMeta,
} from "./approvals-model";
import { Detail, NoticeVerbs } from "./RowParts";
import { AlwaysAllow, StagedEditForm } from "./StagedWrite";
import type { BodyProps } from "./view-types";

export default function Queue(props: BodyProps): React.JSX.Element | null {
  const { focus, page, patch } = props;
  const data = page.data;
  if (!data) return null;
  const { decisions } = data;
  const { filter } = focus;

  const staged =
    decisions.outbox.find((row) => row.itemId === focus.selectedItemId) ??
    decisions.outbox[0];
  const stagedBusy = staged !== undefined && page.busyId === staged.itemId;
  const showStaged = staged !== undefined && matchesFilter(filter, "staged");

  const rows: RowsBlockRow[] = [];
  for (const row of decisions.outbox) {
    if (staged && row.itemId === staged.itemId) continue;
    const copy = outboxRowCopy(row, page.now);
    if (!matchesFilter(filter, copy.kind)) continue;
    rows.push({
      ...copy,
      action: rowVerb(copy, () =>
        patch({ editing: false, selectedItemId: row.itemId })
      ),
      off: page.busyId === row.itemId,
    });
  }
  for (const row of decisions.needsAuth) {
    const copy = needsAuthRowCopy(row);
    if (!matchesFilter(filter, copy.kind)) continue;
    rows.push({
      ...copy,
      action: rowVerb(
        copy,
        () => page.reconnect(row.connectionId),
        page.busyId === row.connectionId ? "Opening…" : copy.action
      ),
      off: page.busyId === row.connectionId,
    });
  }
  for (const row of decisions.parked) {
    const open = focus.expandedId === row.invocationId;
    const copy = parkedRowCopy(row, page.now, open);
    if (!matchesFilter(filter, copy.kind)) continue;
    rows.push({
      ...copy,
      children: open ? (
        <Detail
          busy={page.busyId === row.invocationId}
          onApprove={() => page.confirmParkedInvocation(row.invocationId, true)}
          onDeny={() => page.confirmParkedInvocation(row.invocationId, false)}
          text={describeInvocationInput(row.input)}
        />
      ) : undefined,
      action: rowVerb(copy, () =>
        patch({ expandedId: open ? undefined : row.invocationId })
      ),
    });
  }
  for (const row of decisions.scopeRequests) {
    const open = focus.expandedId === row.requestId;
    const copy = scopeRowCopy(row, page.now, open);
    if (!matchesFilter(filter, copy.kind)) continue;
    rows.push({
      ...copy,
      children: open ? (
        <Detail
          busy={page.busyId === row.requestId}
          onApprove={() => page.decideScope(row.requestId, true)}
          onDeny={() => page.decideScope(row.requestId, false)}
          text={row.purpose}
        />
      ) : undefined,
      action: rowVerb(copy, () =>
        patch({ expandedId: open ? undefined : row.requestId })
      ),
    });
  }
  for (const notice of data.notices.filter(isAttention)) {
    const copy = noticeRowCopy(notice, page.now);
    if (!matchesFilter(filter, copy.kind)) continue;
    rows.push({
      ...copy,
      children: (
        <NoticeVerbs
          busy={page.busyId === notice.noticeId}
          notice={notice}
          page={page}
        />
      ),
      action: rowVerb(copy, () => props.onOpenNotice(notice)),
    });
  }

  const shown = rows.length + (showStaged ? 1 : 0);
  return (
    <>
      {page.state === "full" ? (
        <ChipsBlock
          accessibilityLabel="Filter what is waiting"
          chips={WAITING_CHIPS.map((chip) => ({
            id: chip.key,
            label: chip.label,
            on: filter === chip.key,
            onPress: () => patch({ filter: chip.key }),
          }))}
        />
      ) : null}
      <SectionBlock
        label="Waiting on you"
        meta={waitingMeta(shown, page.waiting)}
      />
      {showStaged && staged ? (
        <PanelBlock
          accessibilityLabel="The staged write waiting on you"
          body={stagedBody(staged)}
          eyebrow={stagedEyebrow(staged, page.now)}
          facts={stagedFacts(staged)}
          action={
            stagedBusy
              ? undefined
              : {
                  filled: true,
                  label: "Approve and send",
                  onPress: () =>
                    page.approveOutbox(staged.itemId, focus.alwaysAllow),
                }
          }
          quote
          action2={
            stagedBusy || !staged.canEdit || focus.editing
              ? undefined
              : {
                  label: "Edit and approve",
                  onPress: () => patch({ editing: true }),
                }
          }
          title={stagedTitle(staged)}
        />
      ) : null}
      {showStaged && staged ? (
        <RowsBlock
          accessibilityLabel="This staged write"
          rows={[
            ...(focus.editing
              ? [
                  {
                    children: (
                      <StagedEditForm
                        busy={stagedBusy}
                        onCancel={() => patch({ editing: false })}
                        onSubmit={(artifact) => {
                          patch({ editing: false });
                          page.approveOutbox(
                            staged.itemId,
                            focus.alwaysAllow,
                            artifact
                          );
                        }}
                        row={staged}
                      />
                    ),
                    key: "staged-edit",
                    sub: EDIT_SUB,
                    title: EDIT_TITLE,
                  },
                ]
              : []),
            {
              children: (
                <AlwaysAllow
                  checked={focus.alwaysAllow}
                  disabled={stagedBusy}
                  label={ALWAYS_TITLE}
                  onChange={(next) => patch({ alwaysAllow: next })}
                />
              ),
              key: "staged-always",
              sub: ALWAYS_SUB,
              title: ALWAYS_TITLE,
            },
            {
              dangerous: true,
              key: "staged-deny",
              sub: DENY_SUB,
              title: DENY_TITLE,
              ...(stagedBusy
                ? {}
                : {
                    action: {
                      hint: `Deny — ${DENY_TITLE}`,
                      label: "Deny",
                      onPress: () => page.denyOutbox(staged.itemId),
                    },
                  }),
            },
          ]}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          {showStaged ? (
            <SectionBlock label="Also waiting" meta={String(rows.length)} />
          ) : null}
          <RowsBlock accessibilityLabel="Waiting on you" rows={rows} />
        </>
      ) : null}
    </>
  );
}
