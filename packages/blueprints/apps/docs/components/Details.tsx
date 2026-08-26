// Details rail (Docs spec §8); tab bodies live in `DetailsTabs.tsx`.
// Version history and activity are a ROUTE (§6.2) — the footer links there.
import { useEffect, useRef, useState } from "react";

import { armConfirm } from "@centraid/design/elements";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { mountedScopes } from "../../_shared/scope-kit.ts";
import { SAVED_TO_MY_VAULT } from "../../_shared/shared-copy.ts";
import { RAIL_NOTES, RAIL_TABS } from "../document-copy.ts";
import type { RailTabId } from "../document-copy.ts";
import { custodyMeta, extOf, fmtBytes, tintBg, typeMeta } from "../format.ts";
import type { DocsShareHost } from "../grant-audiences.ts";
import { I, KIND_ICONS_LG } from "../icons.ts";
import type { CustodyTone, DriveDoc, VersionEntry } from "../types.ts";
import { FactsTab, NamesTab, PropsTab } from "./DetailsTabs.tsx";
import { ActionBtn, Icon } from "./Shared.tsx";

import styles from "./Details.module.css";
import shared from "./shared.module.css";

// Pre-keyed tone classes; never dynamic `styles[`custody-${tone}`]`.
const CUSTODY_CHIP_TONE: Record<CustodyTone, string> = {
  ok: styles.custodyOk!,
  warn: styles.custodyWarn!,
  danger: styles.custodyDanger!,
};

// Self-contained hidden input: picker + change handler live here.
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
      <ActionBtn
        icon="replace"
        label="Replace file…"
        tone="quiet"
        className={shared.detailBtn!}
        onClick={() => inputRef.current?.click()}
      />
      {/* Opened programmatically; `hidden` keeps it out of the a11y tree. */}
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
  docked,
  folderName,
  onClose,
  onOpenQuick,
  onToggleStar,
  onMove,
  onTrash,
  onRestore,
  onReplace,
  loadHistory,
  onOpenVersions,
  onAddTag,
  onRemoveTag,
  shareHost,
}: {
  doc: DriveDoc;
  /** Docked: a column beside the set, no scrim (§8). */
  docked: boolean;
  folderName: (id: string | null | undefined) => string;
  onClose: () => void;
  onOpenQuick: (id: string) => void;
  onToggleStar: (doc: DriveDoc) => void;
  onMove: (anchor: HTMLElement, docs: DriveDoc[]) => void;
  onTrash: (doc: DriveDoc) => void;
  onRestore: (doc: DriveDoc) => void;
  onReplace: (doc: DriveDoc, file: File) => void;
  loadHistory: (
    documentId: string
  ) => Promise<{ versions?: VersionEntry[]; vaultDenied?: unknown }>;
  /** §6.2's route: the rail SENDS the member to the spine. */
  onOpenVersions: (documentId: string) => void;
  onAddTag: (doc: DriveDoc, label: string) => void;
  onRemoveTag: (doc: DriveDoc, tagId: string) => void;
  /** `null` where this seat has no grant plane — no Share offered at all. */
  shareHost: DocsShareHost | null;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const trashed = doc.trashed;
  const [tab, setTab] = useState<RailTabId>("props");
  // Sharing is a standing grant via the shared kit; local state = sheet open.
  const [shareOpen, setShareOpen] = useState(false);
  // Every outcome leaves through the app's single status line.
  const handleStatus = (message: string): void => shareHost?.onStatus(message);
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
      handleStatus(SAVED_TO_MY_VAULT);
    } catch (error) {
      handleStatus(
        error instanceof Error
          ? `Document was not saved: ${error.message}`
          : "Document was not saved to your vault."
      );
    }
  };
  // Blob custody projection (#352): null renders as nothing, not a guess.
  const custody = custodyMeta(doc.custody_state);

  const body = (
    <>
      <div className={styles.detailsHead}>
        <span className={styles.lbl}>Details</span>
        <button
          type="button"
          className={`kit-icon-btn ${styles.railClose}`}
          aria-label="Close details"
          onClick={onClose}
        >
          <Icon svg={I.closeSm!} />
        </button>
      </div>
      <div className={styles.detailsBody}>
        <div className={styles.hero} style={{ background: tintBg(m.cv, 12) }}>
          {/* Kind glyph, same one the rows and cards wear, for every kind
                including a picture — never a thumbnail (the rail is a fact
                sheet; Open stages the document), never an extension badge. */}
          <span className={styles.heroGlyph}>
            <Icon svg={KIND_ICONS_LG[m.glyph]} />
          </span>
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
          {/* Exactly one primary per view (DESIGN.md); the rest are `quiet`. */}
          <ActionBtn
            icon="open"
            label="Open"
            tone="primary"
            className={shared.detailBtn!}
            onClick={() => onOpenQuick(doc.document_id)}
          />
          <ActionBtn
            icon="download"
            label="Download"
            tone="quiet"
            className={shared.detailBtn!}
            href={doc.content_uri ?? undefined}
            extra={{ download: doc.title ?? "file" }}
          />
          {/* Star keeps its glyph, takes no ★; ON lives in `aria-pressed`
                + the label. */}
          {trashed ? null : (
            <ActionBtn
              icon="star"
              label={doc.starred ? "Starred" : "Star"}
              tone="quiet"
              className={shared.detailBtn!}
              onClick={() => onToggleStar(doc)}
              extra={{ "aria-pressed": Boolean(doc.starred) }}
            />
          )}
          {/* NO IN-PLACE EDIT, for any kind: versions arrive as whole files
                via Replace — one write path, the chain History reads. */}
          {trashed ? null : <ReplaceButton doc={doc} onReplace={onReplace} />}
        </div>
        {trashed ? null : (
          <>
            {commonsResident ? (
              <ActionBtn
                icon="save"
                label="Save to my vault"
                tone="quiet"
                className={shared.detailBtn!}
                onClick={() => void saveToMyVault()}
              />
            ) : null}
            {shareHost ? (
              <>
                <ActionBtn
                  icon="share"
                  label="Share document"
                  tone="quiet"
                  className={shared.detailBtn!}
                  onClick={() => setShareOpen(true)}
                />
                {/* Opens over this document, not a separate screen. */}
                <GrantSheet
                  open={shareOpen}
                  onClose={() => setShareOpen(false)}
                  audiences={shareHost.audiences}
                  subject={{
                    subjectType: "core.document",
                    subjectId: doc.document_id,
                    ...(doc.title ? { label: doc.title } : {}),
                  }}
                  onStatus={handleStatus}
                />
              </>
            ) : null}
          </>
        )}
        {/* Three tabs, one 2px underline — the same ink bar as the shelf. */}
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
        <ActionBtn
          icon="history"
          label="Version history"
          tone="quiet"
          className={shared.detailBtn!}
          onClick={() => onOpenVersions(doc.document_id)}
        />
        {/* §8's closing sentence: the rail follows the selection. */}
        <p className={styles.railFoot}>{RAIL_NOTES.footer}</p>
      </div>
      <div className={styles.detailsFoot}>
        {trashed ? (
          <ActionBtn
            icon="restore"
            label="Restore"
            className={shared.detailBtn!}
            onClick={() => onRestore(doc)}
          />
        ) : (
          <>
            <ActionBtn
              icon="move"
              label="Move"
              className={shared.detailBtn!}
              onClick={(e) => onMove(e.currentTarget, [doc])}
            />
            <ActionBtn
              icon="trash"
              label="Trash"
              tone="destructive danger"
              className={shared.detailBtn!}
              onClick={(e) => {
                if (
                  !armConfirm(e.currentTarget as HTMLElement, {
                    armedLabel: "Trash — sure?",
                  })
                )
                  return;
                onTrash(doc);
              }}
            />
          </>
        )}
      </div>
    </>
  );

  return docked ? (
    // A LANDMARK, NOT A DIALOG: no focus trap, no `aria-modal`, no backdrop.
    <aside className={styles.railDock} aria-label="Document details">
      {body}
    </aside>
  ) : (
    <>
      {/* Outside-click dismiss as a real button for keyboard parity. */}
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
        {body}
      </dialog>
    </>
  );
}
