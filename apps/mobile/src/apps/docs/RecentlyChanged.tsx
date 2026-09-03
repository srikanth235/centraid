import React, { useMemo } from "react";

import { RECENT } from "@centraid/blueprints/apps/docs/shelves";
import {
  captionFor,
  RECENT_RULE,
} from "@centraid/blueprints/apps/docs/view-copy";

import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import DriveList from "./DriveList";
import { useDocs } from "./useDocs";

const RECENT_WINDOW = 50;

export default function RecentlyChanged(): React.JSX.Element {
  const drive = useDocs();
  const docs = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed).slice(0, RECENT_WINDOW),
    [drive.documents]
  );
  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Recently changed" backTo="All" />
      <ReplicaStatusBar />
      <DriveList
        shelf={RECENT}
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
        caption={captionFor(RECENT, { offline: drive.offline })}
        status={RECENT_RULE}
      />
    </DocsScreen>
  );
}
