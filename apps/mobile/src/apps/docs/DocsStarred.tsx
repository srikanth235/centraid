// Starred (spec §2; #821). One star for the whole product — a
// photograph starred in Photos carries the SAME flags-scheme tag, but Docs'
// replica scope reads document wrappers only, so this shelf lists starred
// DOCUMENTS and its status counts exactly that. The spec's sample adds a
// photograph count; that half is withheld here rather than fabricated (see
// INTEGRATION-NOTES.md → Withholdings).

import React, { useMemo } from "react";

import { STARRED } from "@centraid/blueprints/apps/docs/shelves";
import { captionFor } from "@centraid/blueprints/apps/docs/view-copy";

import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { starredStatus } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import DriveList from "./DriveList";
import { useDocs } from "./useDocs";

export default function DocsStarred(): React.JSX.Element {
  const drive = useDocs();
  const docs = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed && doc.starred),
    [drive.documents]
  );
  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Starred" backTo="All" />
      <ReplicaStatusBar />
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
    </DocsScreen>
  );
}
