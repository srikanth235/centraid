// Recently changed (handoff Part 2 §"Two boundaries"; spec §2 row 5).
//
// "Nothing records an opening. So a 'Recent' shelf in the sense a drive
// means it cannot be built honestly. Docs orders by last change and names
// the shelf Recently changed for what it CAN order by" — the status line
// states the rule (`RECENT_RULE`), and the caption repeats the one fact that
// keeps the ordering honest: a machine reading the contents counts as a
// change.

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

/** A bounded recent window, not the whole drive re-sorted — the shelf is a
 *  view over the freshest changes, and All already holds everything. */
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
