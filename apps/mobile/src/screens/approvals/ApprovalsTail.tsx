// The reference tail of the Notifications page (#765): standing grants, the
// updates that are news rather than demands, and the archive.

import React from "react";
import { View } from "react-native";

import NoteBlock from "../../kit/components/NoteBlock";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import {
  GRANTS_NOTE,
  NO_GRANTS_NOTE,
  activeNotices,
  grantRowCopy,
  rowVerb,
  isAttention,
  noticeSub,
} from "./approvals-model";
import { NoticeVerbs } from "./RowParts";
import type { BodyProps } from "./view-types";

/**
 * The page's reference material: standing grants, the updates that are news
 * rather than demands, and the archive. It renders in EVERY state including
 * empty — a consent surface that hides the record of what it already
 * consented to is not a record.
 */
export default function Tail(props: BodyProps): React.JSX.Element {
  const { page } = props;
  const notices = page.data ? page.data.notices : [];
  const updates = activeNotices(notices).filter(
    (notice) => !isAttention(notice)
  );
  const archived = notices.filter((notice) => notice.archivedAt !== null);
  const grantRows: RowsBlockRow[] = page.grants.map((grant) => {
    const copy = grantRowCopy(grant, page.now);
    return {
      ...copy,
      action: rowVerb(copy, () => page.revokeGrant(grant.grantId), "Revoke"),
      dangerous: true,
      off: page.busyId === grant.grantId,
    };
  });

  return (
    <>
      <View
        onLayout={(event) => props.onGrantsLayout(event.nativeEvent.layout.y)}
      >
        <SectionBlock
          label="Standing grants"
          meta={String(page.grants.length)}
        />
        {grantRows.length > 0 ? (
          <RowsBlock accessibilityLabel="Standing grants" rows={grantRows} />
        ) : (
          <NoteBlock text={NO_GRANTS_NOTE} />
        )}
        <NoteBlock text={GRANTS_NOTE} />
      </View>
      {updates.length > 0 ? (
        <>
          <SectionBlock label="Updates" meta={String(updates.length)} />
          <RowsBlock
            accessibilityLabel="Updates"
            rows={updates.map((notice) => ({
              action: {
                hint: `Open — ${notice.headline}`,
                label: "Open",
                onPress: () => props.onOpenNotice(notice),
              },
              children: (
                <NoticeVerbs
                  busy={page.busyId === notice.noticeId}
                  notice={notice}
                  page={page}
                />
              ),
              key: notice.noticeId,
              sub: noticeSub(notice, page.now),
              title: notice.headline,
            }))}
          />
        </>
      ) : null}
      {archived.length > 0 ? (
        <>
          <SectionBlock label="Archived" meta={String(archived.length)} />
          <RowsBlock
            accessibilityLabel="Archived notices"
            rows={archived.map((notice) => ({
              action: {
                hint: `Open — ${notice.headline}`,
                label: "Open",
                onPress: () => props.onOpenNotice(notice),
              },
              key: notice.noticeId,
              sub: noticeSub(notice, page.now),
              title: notice.headline,
            }))}
          />
        </>
      ) : null}
    </>
  );
}
