// The Shared shelf — what other people sent you, in the slot Search vacated
// (`docs-band.ts` carries why the trade was worth making).
//
// Shaped after the shelf everybody already knows, Drive's Shared tab: newest
// arrival first, and each row led by WHO sent it rather than by how big it is.
// That line rides the row's one lead slot, the same one a matched passage
// takes on Search — both answer "why is this document in this set", and a row
// may only answer that once (`DocRow`'s `reason`).
//
// The kind mark stays. Drive can afford to spend a row's leading square on a
// face because its rows carry a thumbnail too; ours carries one glyph, and
// trading "what kind of thing is this" for "who sent it" would cost more than
// it bought when the sender is already named a few pixels below.
//
// EVERY ROW HERE IS THE MEMBER'S OWN. A delivered share is a copy in this
// vault, not a window into someone else's — it survives an unshare and it goes
// into this vault's backup — so these rows carry the same menu, the same star
// and the same trash as any other document, and the shelf says so once at its
// foot rather than badging every row.

import React, { useMemo } from "react";

import {
  SHARED_CAPTION,
  SHARED_EMPTY_BODY,
  SHARED_EMPTY_TITLE,
  SHARED_UNKNOWN_BODY,
  SHARED_UNKNOWN_TITLE,
  sharedFromLine,
  sharedStatus,
} from "./docs-copy";
import DriveList from "./DriveList";
import type { UseDocsResult } from "./useDocs";

export default function DocsSharedView({
  drive,
}: {
  drive: UseDocsResult;
}): React.JSX.Element {
  // A placement record is the whole answer: no row, no arrival. Trashed ones
  // drop out here as they do on every other shelf — the trash is one place.
  const docs = useMemo(
    () =>
      drive.documents
        .filter((doc) => !doc.trashed && doc.shared_from !== null)
        .sort((a, b) => (b.shared_from?.at ?? 0) - (a.shared_from?.at ?? 0)),
    [drive.documents]
  );

  const reasons = useMemo(
    () =>
      Object.fromEntries(
        docs.flatMap((doc) =>
          doc.shared_from
            ? [[doc.document_id, sharedFromLine(doc.shared_from)] as const]
            : []
        )
      ),
    [docs]
  );

  // "Could not read" and "nothing arrived" are different answers and must not
  // look alike, so the unknown case replaces the set rather than captioning
  // it — the same rule the linked-people roster follows.
  const known = drive.sharedFromKnown;

  return (
    <DriveList
      shelf={null}
      docs={known ? docs : []}
      folders={drive.folders}
      loading={drive.loading}
      connection={drive.connection}
      {...(drive.error ? { error: drive.error } : {})}
      {...(drive.unavailableReason
        ? { unavailableReason: drive.unavailableReason }
        : {})}
      offline={drive.offline}
      refresh={drive.refresh}
      reasons={reasons}
      emptyCopy={
        known
          ? { title: SHARED_EMPTY_TITLE, body: SHARED_EMPTY_BODY }
          : { title: SHARED_UNKNOWN_TITLE, body: SHARED_UNKNOWN_BODY }
      }
      caption={known && docs.length > 0 ? SHARED_CAPTION : null}
      status={known ? sharedStatus(docs.length) : null}
    />
  );
}
