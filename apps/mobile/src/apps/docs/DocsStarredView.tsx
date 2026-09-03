import React, { useMemo } from "react";

import { STARRED } from "@centraid/blueprints/apps/docs/shelves";
import { captionFor } from "@centraid/blueprints/apps/docs/view-copy";

import { starredStatus } from "./docs-copy";
import DriveList from "./DriveList";
import type { UseDocsResult } from "./useDocs";

export default function DocsStarredView({
  drive,
}: {
  drive: UseDocsResult;
}): React.JSX.Element {
  const docs = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed && doc.starred),
    [drive.documents]
  );
  return (
    <DriveList
      shelf={STARRED}
      docs={docs}
      folders={drive.folders}
      loading={drive.loading}
      connection={drive.connection}
      {...(drive.error ? { error: drive.error } : {})}
      {...(drive.unavailableReason
        ? { unavailableReason: drive.unavailableReason }
        : {})}
      offline={drive.offline}
      refresh={drive.refresh}
      caption={captionFor(STARRED, { offline: drive.offline })}
      status={starredStatus(docs.length)}
    />
  );
}
