// The three tabs of the details rail (Docs spec §8).
//
// "One rail, three former screens: properties, the people a document names,
// and the facts about a kind Docs cannot render. All three answer 'what is
// this row', so they belong beside the row and not three screens away from
// it." (§8, verbatim.)
//
// The tab BODIES live here rather than in `Details.tsx` for the ordinary
// reason: the rail shell owns the frame, the close, the tab strip and the
// document-level actions, and three fact lists inline in it would push the
// file past the size cap. Every one of them is a pure function of the row.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { capabilityOn } from "../capabilities.ts";
import {
  RAIL_NOTES,
  SHARED_WITH_KEY,
  cannotRenderFact,
  sharedWithNote,
} from "../document-copy.ts";
import {
  canRender,
  custodyMeta,
  fmtBytes,
  fmtFull,
  purgeCountdown,
  typeMeta,
} from "../format.ts";
import type { DriveDoc, VersionEntry } from "../types.ts";
import { Tags } from "./Tags.tsx";

import styles from "./Details.module.css";

function Fact({
  k,
  v,
  note,
  net = false,
}: {
  k: string;
  v: string;
  note?: string;
  net?: boolean;
}): ReactNode {
  return (
    <div className={styles.factRow}>
      <dt className={styles.factKey}>{k}</dt>
      <dd className={styles.factValue} data-net={String(net)}>
        {v}
        {note ? <span className={styles.factNote}>{note}</span> : null}
      </dd>
    </div>
  );
}

export function PropsTab({
  doc,
  folderName,
  onAddTag,
  onRemoveTag,
}: {
  doc: DriveDoc;
  folderName: (id: string | null | undefined) => string;
  onAddTag: (doc: DriveDoc, label: string) => void;
  onRemoveTag: (doc: DriveDoc, tagId: string) => void;
}): ReactNode {
  const kind = typeMeta(doc.media_type, doc.title);
  const custody = custodyMeta(doc.custody_state);
  return (
    <>
      <dl className={styles.facts}>
        <Fact k="Owner" v="you" note={RAIL_NOTES.owner} />
        {/* WHO ELSE CAN REACH THIS, from the vault's own grants — one row per
            live share, and no row at all when there is none or when the share
            reads were denied (`shared_with: null`). A share that came from a
            folder says which folder, because that is the thing the member
            would have to change. */}
        {(doc.shared_with ?? []).map((share) => (
          <Fact
            key={share.grant_id}
            k={SHARED_WITH_KEY}
            v={displayText(share.label)}
            note={sharedWithNote({
              viaFolder:
                share.via === "folder"
                  ? displayText(folderName(share.container_id))
                  : null,
              pending: share.pending_count,
            })}
          />
        ))}
        <Fact
          k={doc.trashed ? "Was filed under" : "Folder"}
          v={displayText(folderName(doc.folder_id))}
          note={RAIL_NOTES.folder}
        />
        {/* CUSTODY IS A PROPERTY OF THE BYTES, and the one custody state a
            member can lose something to is named on the row itself (§4.1
            rung 5). Here it is spelled out in words. A row whose custody the
            sweep has not reached says nothing rather than guessing. */}
        {custody ? <Fact k="On this device" v={custody.label} /> : null}
        {canRender(doc) ? null : (
          <Fact
            k="This kind"
            v={cannotRenderFact(kind.name)}
            note={RAIL_NOTES.cannotRender}
            net
          />
        )}
      </dl>
      <div className={styles.tabLabel}>Tags</div>
      <Tags doc={doc} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />
    </>
  );
}

export function FactsTab({
  doc,
  loadHistory,
}: {
  doc: DriveDoc;
  loadHistory: (
    documentId: string
  ) => Promise<{ versions?: VersionEntry[]; vaultDenied?: unknown }>;
}): ReactNode {
  // The version count is a READ, not a field on the row — so the fact is
  // absent until it lands, rather than printed as a zero the rail invented.
  const [versions, setVersions] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadHistory(doc.document_id).then((res) => {
      if (!cancelled) setVersions(res?.versions?.length ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [doc.document_id, loadHistory]);

  const kind = typeMeta(doc.media_type, doc.title);
  const custody = custodyMeta(doc.custody_state);
  return (
    <dl className={styles.facts}>
      <Fact k="Kind" v={kind.name} />
      <Fact k="Size" v={fmtBytes(doc.byte_size)} />
      <Fact k="Added" v={fmtFull(doc.created_at)} />
      {versions === null ? null : (
        <Fact k="Versions" v={`${versions} · nothing overwritten`} />
      )}
      {/* "Contents" is what the read capability would have produced. It is
          off, so the fact is what is true: nobody has looked. */}
      <Fact k="Contents" v={capabilityOn("read") ? "read" : "not read"} />
      <Fact
        k="Purge date"
        v={
          doc.trashed && doc.purge_at
            ? purgeCountdown(doc.purge_at)
            : "— not in trash"
        }
      />
      {custody ? <Fact k="Backed up" v={custody.label} /> : null}
      {/* The document's own identity, and the one sentence that explains why
          two apps can point at the same bytes without a second copy. */}
      <Fact
        k="Document"
        v={doc.document_id.slice(0, 8)}
        note={RAIL_NOTES.duplicateBytes}
      />
    </dl>
  );
}

export function NamesTab({ doc }: { doc: DriveDoc }): ReactNode {
  const on = capabilityOn("names");
  return (
    <dl className={styles.facts}>
      {/* NO FABRICATED PEOPLE. §8's names row resolves to People records with
          the passage each was read from; the capability that would produce
          them is off and there is no consent record to read, so the rail says
          so and links nowhere. A name here that nothing had actually read
          would be the single most damaging thing this app could print. */}
      <Fact
        k="Who this document names"
        v={on ? "—" : "switched off"}
        note={RAIL_NOTES.namesOff}
        net={!on}
      />
      <Fact k="Document" v={displayText(doc.title || "Untitled")} />
    </dl>
  );
}
