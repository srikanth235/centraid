// Version history (Docs spec §6.2) — screen `versions`.
//
// A ROUTE, NOT AN OVERLAY. It used to be a disclosure inside the details
// drawer, which made a document's spine something you could only see while
// standing in a sheet over the drive. §6.2 gives it a breadcrumb of its own
// (`Docs → <title> → History`), which is only meaningful for a screen.
//
// AND IT FOLDS ACTIVITY IN. "Cut: Activity as its own screen. What happened to
// a document and which version it produced are one spine. The third column
// records whether a member, an app or a machine did it." (§6.2/§14, verbatim.)
// So the two reads that used to be two panels in a drawer are one screen here,
// in that order, with the sentence that explains the fold printed under them.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import {
  VERSIONS_ACTIVITY_HEAD,
  VERSIONS_ACTIVITY_META,
  VERSIONS_CUT_NOTE,
} from "../document-copy.ts";
import { crumbsFor } from "../drive-copy.ts";
import type { ActivityEvent, DriveDoc, VersionEntry } from "../types.ts";
import { Activity } from "./Activity.tsx";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { History } from "./History.tsx";

import styles from "./VersionsRoute.module.css";

export function VersionsRoute({
  doc,
  loadHistory,
  loadActivity,
  onRestoreVersion,
  onSelectShelf,
  onClose,
}: {
  doc: DriveDoc;
  loadHistory: (
    documentId: string
  ) => Promise<{ versions?: VersionEntry[]; vaultDenied?: unknown }>;
  loadActivity: (
    documentId: string
  ) => Promise<{ events?: ActivityEvent[]; vaultDenied?: unknown }>;
  onRestoreVersion: (doc: DriveDoc, contentId: string) => void;
  onSelectShelf: (shelf: null) => void;
  onClose: () => void;
}): ReactNode {
  const title = displayText(doc.title || "Untitled");
  return (
    <div className={styles.wrap}>
      <Breadcrumb
        crumbs={crumbsFor(null, { title, tail: "History" })}
        onSelectShelf={() => onSelectShelf(null)}
      />
      <div className={styles.top}>
        <button
          type="button"
          className={`kit-plain-btn ${styles.back}`}
          onClick={onClose}
        >
          ← Back
        </button>
      </div>
      <section className={styles.section} aria-label="Version history">
        {/* A trashed document's versions are readable and not restorable —
            the same rule the drawer carried, moved with the screen. */}
        <History
          key={doc.content_id}
          documentId={doc.document_id}
          readOnly={doc.trashed}
          loadVersions={loadHistory}
          onRestoreVersion={(_documentId, contentId) =>
            onRestoreVersion(doc, contentId)
          }
        />
      </section>
      <div className={styles.head}>
        <h2 className={styles.headLabel}>{VERSIONS_ACTIVITY_HEAD}</h2>
        <span className={styles.headMeta}>{VERSIONS_ACTIVITY_META}</span>
      </div>
      <section className={styles.section} aria-label="Activity">
        <Activity
          key={doc.document_id}
          documentId={doc.document_id}
          loadActivity={loadActivity}
        />
      </section>
      <p className={styles.note}>{VERSIONS_CUT_NOTE}</p>
    </div>
  );
}
