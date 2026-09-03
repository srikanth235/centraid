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
