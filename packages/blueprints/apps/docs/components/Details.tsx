// The DETAILS RAIL (Docs spec §8) — one rail, three tabs.
//
// "One rail, three former screens: properties, the people a document names,
// and the facts about a kind Docs cannot render. All three answer 'what is
// this row', so they belong beside the row and not three screens away from
// it." (§8, verbatim.) The tab bodies are in `DetailsTabs.tsx`; this file is
// the rail: head, tabs, the document's own verbs, and the footer.
//
// TWO THINGS LEFT THIS FILE. Version history is a ROUTE now (§6.2) rather
// than a disclosure inside a drawer, and Activity went with it — "what
// happened to a document and which version it produced are one spine" — so
// the rail's footer sends the member to that screen instead of unfolding a
// second copy of it here.
import { useEffect, useRef, useState } from "react";

import { armConfirm } from "@centraid/design/elements";

import { mountedScopes } from "../../_shared/scope-kit.ts";
import { ShareSheet } from "../../_shared/ShareSheet.tsx";
import { RAIL_NOTES, RAIL_TABS } from "../document-copy.ts";
import type { RailTabId } from "../document-copy.ts";
import {
  custodyMeta,
  extOf,
  fmtBytes,
  isImage,
  isVideo,
  isTextEditable,
  tintBg,
  typeMeta,
} from "../format.ts";
import { I, RENAME_ICON } from "../icons.ts";
import type { CustodyTone, DriveDoc, VersionEntry } from "../types.ts";
import { FactsTab, NamesTab, PropsTab } from "./DetailsTabs.tsx";
import { Icon } from "./Shared.tsx";

import styles from "./Details.module.css";
import shared from "./shared.module.css";

// The custody chip's three tones are compound modifiers on the local base,
// keyed off a lookup map so the tone never becomes `styles[\`custody-${tone}\`]`.
const CUSTODY_CHIP_TONE: Record<CustodyTone, string> = {
  ok: styles.custodyOk!,
  warn: styles.custodyWarn!,
  danger: styles.custodyDanger!,
};

// A hidden file input, self-contained: click-through-to-picker plus the
// change handler live entirely inside this button, so Details.tsx and
// app.tsx never need a global replace-target/hidden-input pair the way
// upload does (upload has no "which document" to remember; replace does,
// and this keeps that fact local to the one place that needs it).
function ReplaceButton({
  doc,
  onReplace,
}: {
  doc: DriveDoc;
  onReplace: (doc: DriveDoc, file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={`kit-btn quiet ${shared.detailBtn}`}
        onClick={() => inputRef.current?.click()}
      >
        Replace file…
      </button>
      {/* Opened programmatically by the button above; `hidden` already keeps it
          out of the a11y tree, so it carries no aria-hidden on top of that. */}
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-label="Replace file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onReplace(doc, file);
        }}
      />
    </>
  );
}

export function Details({
  doc,
  folderName,
  onClose,
  onOpenQuick,
  onToggleStar,
  onMove,
  onTrash,
  onRestore,
  onEdit,
  onReplace,
  loadHistory,
  onOpenVersions,
  onAddTag,
  onRemoveTag,
}: {
  doc: DriveDoc;
  folderName: (id: string | null | undefined) => string;
  onClose: () => void;
  onOpenQuick: (id: string) => void;
  onToggleStar: (doc: DriveDoc) => void;
  onMove: (anchor: HTMLElement, docs: DriveDoc[]) => void;
  onTrash: (doc: DriveDoc) => void;
  onRestore: (doc: DriveDoc) => void;
  onEdit: (doc: DriveDoc) => void;
  onReplace: (doc: DriveDoc, file: File) => void;
  loadHistory: (
    documentId: string
  ) => Promise<{ versions?: VersionEntry[]; vaultDenied?: unknown }>;
  /** §6.2's route. The rail SENDS the member to the spine; it no longer
   *  unfolds a second copy of it inside a drawer. */
  onOpenVersions: (documentId: string) => void;
  onAddTag: (doc: DriveDoc, label: string) => void;
  onRemoveTag: (doc: DriveDoc, tagId: string) => void;
}) {
  const m = typeMeta(doc.media_type);
  const trashed = doc.trashed;
  const [tab, setTab] = useState<RailTabId>("props");
  // Documents use the same ceremony-free commons sheet as every container.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const actorVaultId = mountedScopes()[0]?.id ?? "";
  const [residentDocumentId, setResidentDocumentId] = useState<string | null>(
    null
  );
  const commonsResident = residentDocumentId === doc.document_id;
  useEffect(() => {
    let active = true;
    if (!actorVaultId || !window.centraid.commonsResidents) return;
    void window.centraid
      .commonsResidents(actorVaultId)
      .then((items) => {
        if (active)
          setResidentDocumentId(
            items.some(
              (item) =>
                item.itemType === "core.document" &&
                item.itemId === doc.document_id
            )
              ? doc.document_id
              : null
          );
      })
      .catch(() => {
        if (active) setResidentDocumentId(null);
      });
    return () => {
      active = false;
    };
  }, [actorVaultId, doc.document_id]);

  const saveToMyVault = async (): Promise<void> => {
    if (!commonsResident || !actorVaultId || !window.centraid.retainCommonsItem)
      return;
    try {
      await window.centraid.retainCommonsItem({
        actorVaultId,
        itemType: "core.document",
        itemId: doc.document_id,
      });
      setResidentDocumentId(null);
      setShareStatus(
        "Saved to my vault. This copy survives if the share ends."
      );
    } catch (error) {
      setShareStatus(
        error instanceof Error
          ? `Document was not saved: ${error.message}`
          : "Document was not saved to your vault."
      );
    }
  };
  // The blob custody projection (issue #352 phase 4) — null for an inline
  // document or one the standing sweep hasn't reached yet, rendered as
  // nothing rather than a guess.
  const custody = custodyMeta(doc.custody_state);

  return (
    <>
      {/* Dismiss-on-outside-click as a real button, so the same gesture has a
          keyboard equivalent. */}
      <button
        type="button"
        className={`kit-plain-btn ${styles.detailsBackdrop}`}
        aria-label="Dismiss details"
        onClick={onClose}
      />
      <dialog
        open
        className={styles.details}
        aria-modal="true"
        aria-label="Document details"
      >
        <div className={styles.detailsHead}>
          <span className={styles.lbl}>Details</span>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Close details"
            onClick={onClose}
          >
            <Icon svg={I.close!} />
          </button>
        </div>
        <div className={styles.detailsBody}>
          <div className={styles.hero} style={{ background: tintBg(m.cv, 12) }}>
            {isImage(doc) ? (
              <img src={doc.content_uri} alt="" />
            ) : isVideo(doc) && doc.poster_uri ? (
              <>
                <img
                  src={doc.poster_uri}
                  alt=""
                  onError={(e) => e.currentTarget.remove()}
                />
                <span className={shared.mediaPlay} aria-hidden="true">
                  ▶
                </span>
              </>
            ) : (
              <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
            )}
          </div>
          <div className={styles.detailName}>{doc.title ?? "Untitled"}</div>
          <div className={styles.detailExt}>
            {extOf(doc)} · {fmtBytes(doc.byte_size)}
          </div>
          {custody ? (
            <div className={styles.detailCustody}>
              <span
                className={`kit-chip ${styles.custodyChip} ${CUSTODY_CHIP_TONE[custody.tone]}`}
                title="Backup status"
              >
                {custody.label}
              </span>
            </div>
          ) : null}
          <div className={shared.detailActions}>
            {/* Exactly one primary in this sheet (DESIGN.md: at most one
                filled ink element per view) — opening the document is the
                drawer's reason to exist; everything beside it is `quiet`,
                which has no fill, so the six actions stop reading as six
                equals. */}
            <button
              type="button"
              className={`kit-btn primary ${shared.detailBtn}`}
              onClick={() => onOpenQuick(doc.document_id)}
            >
              Open
            </button>
            <a
              className={`kit-btn quiet ${shared.detailBtn}`}
              href={doc.content_uri}
              download={doc.title ?? "file"}
            >
              Download
            </a>
            {trashed ? null : (
              <button
                type="button"
                className={`kit-btn quiet ${shared.detailBtn}`}
                aria-pressed={Boolean(doc.starred)}
                onClick={() => onToggleStar(doc)}
              >
                <span aria-hidden="true">{doc.starred ? "★" : "☆"}</span>
                {doc.starred ? "Starred" : "Star"}
              </button>
            )}
            {trashed ? null : isTextEditable(doc) ? (
              <button
                type="button"
                className={`kit-btn quiet ${shared.detailBtn}`}
                onClick={() => onEdit(doc)}
              >
                <Icon svg={RENAME_ICON} />
                Edit
              </button>
            ) : (
              <ReplaceButton doc={doc} onReplace={onReplace} />
            )}
          </div>
          {trashed ? null : (
            <>
              {commonsResident ? (
                <button
                  type="button"
                  className={`kit-btn quiet ${shared.detailBtn}`}
                  onClick={() => void saveToMyVault()}
                >
                  Save to my vault
                </button>
              ) : null}
              <button
                type="button"
                className={`kit-btn quiet ${shared.detailBtn}`}
                onClick={() => setShareOpen(true)}
              >
                Share document
              </button>
              <ShareSheet
                open={shareOpen}
                onClose={() => setShareOpen(false)}
                sourceScopeId={mountedScopes()[0]?.id ?? ""}
                scopes={mountedScopes()}
                itemType="core.document"
                itemIds={[doc.document_id]}
                appLabel="Docs"
                onDone={(outcome) => setShareStatus(outcome.message)}
              />
              {shareStatus ? (
                <output className={styles.shareStatus} aria-live="polite">
                  {shareStatus}
                </output>
              ) : null}
            </>
          )}
          {/* §8's tab strip. Three tabs, one underline — the same 2px ink
              bar the shelf strip uses, so "which of these am I looking at"
              means the same thing everywhere in the app. */}
          <div className={styles.tabs} role="tablist" aria-label="Details">
            {RAIL_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={styles.tab}
                data-current={String(tab === entry.id)}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {tab === "props" ? (
            <PropsTab
              doc={doc}
              folderName={folderName}
              onAddTag={onAddTag}
              onRemoveTag={onRemoveTag}
            />
          ) : tab === "facts" ? (
            <FactsTab doc={doc} loadHistory={loadHistory} />
          ) : (
            <NamesTab doc={doc} />
          )}
          <button
            type="button"
            className={`kit-btn quiet ${shared.detailBtn}`}
            onClick={() => onOpenVersions(doc.document_id)}
          >
            Version history
          </button>
          {/* §8's own closing sentence: the rail is about ONE row, and it
              follows the selection rather than pinning itself to a document
              the member has moved on from. */}
          <p className={styles.railFoot}>{RAIL_NOTES.footer}</p>
        </div>
        <div className={styles.detailsFoot}>
          {trashed ? (
            <button
              type="button"
              className={`kit-btn ${shared.detailBtn}`}
              onClick={() => onRestore(doc)}
            >
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`kit-btn ${shared.detailBtn}`}
                onClick={(e) => onMove(e.currentTarget, [doc])}
              >
                Move
              </button>
              <button
                type="button"
                className={`kit-btn destructive danger ${shared.detailBtn}`}
                onClick={(e) => {
                  if (
                    !armConfirm(e.currentTarget, {
                      armedLabel: "Trash — sure?",
                    })
                  )
                    return;
                  onTrash(doc);
                }}
              >
                Trash
              </button>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
