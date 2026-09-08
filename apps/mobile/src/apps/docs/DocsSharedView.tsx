// The Shared shelf — what other people sent you, in the slot Search vacated
// (`docs-band.ts` carries why the trade was worth making).
//
// Newest arrival first, each row led by WHO sent it. That line rides the row's
// one lead slot, the same one a matched passage takes on Search (`DocRow`'s
// `reason`): a row answers "why am I in this set" once.
//
// EVERY ROW IS THIS VAULT'S OWN COPY, so it carries the same menu, star and
// trash as any other document. What it does not do is outlive the share —
// ruling G-revoke hard-deletes it — which is why the empty state says so.

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
  // No placement row, no arrival; trashed drops out as on every other shelf.
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

  // "Could not read" and "nothing arrived" must not look alike, so the unknown
  // case REPLACES the set rather than captioning it.
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
