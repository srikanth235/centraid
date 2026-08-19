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

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { mountedScopes } from "../../_shared/scope-kit.ts";
import { SAVED_TO_MY_VAULT } from "../../_shared/shared-copy.ts";
import { RAIL_NOTES, RAIL_TABS } from "../document-copy.ts";
import type { DocsShareHost } from "../grant-audiences.ts";
import type { RailTabId } from "../document-copy.ts";
import { custodyMeta, extOf, fmtBytes, tintBg, typeMeta } from "../format.ts";
import { I, KIND_ICONS_LG } from "../icons.ts";
import type { CustodyTone, DriveDoc, VersionEntry } from "../types.ts";
import { FactsTab, NamesTab, PropsTab } from "./DetailsTabs.tsx";
import { ActionBtn, Icon } from "./Shared.tsx";

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
      <ActionBtn
        icon="replace"
        label="Replace file…"
        tone="quiet"
        className={shared.detailBtn!}
        onClick={() => inputRef.current?.click()}
      />
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
  /** DOCKED, not drawn over the drive. At a desk the rail is a column beside
   *  the set (Chrome.tsx's content row) and the set stays reachable behind
   *  no scrim at all — which is the only way §8's own closing sentence works:
   *  the rail follows the selection, so the selection has to be clickable
   *  while it is open. The compact form factor keeps the modal drawer, where
   *  a 308px column beside a 390px set is not a column. */
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
  /** §6.2's route. The rail SENDS the member to the spine; it no longer
   *  unfolds a second copy of it inside a drawer. */
  onOpenVersions: (documentId: string) => void;
  onAddTag: (doc: DriveDoc, label: string) => void;
  onRemoveTag: (doc: DriveDoc, tagId: string) => void;
  /** The roster and status line Share needs. `null` where this seat has no
   *  grant plane to reach — the rail then offers no Share at all, rather than
   *  a control that can only refuse. */
  shareHost: DocsShareHost | null;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const trashed = doc.trashed;
  const [tab, setTab] = useState<RailTabId>("props");
  // A document is shared as a STANDING GRANT through the one shared kit —
  // Docs holds no share state of its own beyond "is the sheet open".
  const [shareOpen, setShareOpen] = useState(false);
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
      shareHost?.onStatus(SAVED_TO_MY_VAULT);
    } catch (error) {
      shareHost?.onStatus(
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

  // ONE BODY, TWO HOUSINGS. The rail's contents do not change with the form
  // factor — the same head, tabs, facts and verbs — so the fork is the box
  // around them and nothing else. Docked it is a plain landmark in the
  // content row; as a drawer it is a modal dialog over a scrim, and only that
  // form gets a backdrop, because only that form takes the screen.
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
          {/* The kind glyph, the same one the rows and the cards wear, for
                every kind including a picture — never a thumbnail (the rail
                is a fact sheet, not a viewer; Open puts the document on the
                stage), and never `DOC` / `PDF` / `XLS`, which is the filename
                extension wearing a badge two lines above where the rail
                prints it. */}
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
          {/* Exactly one primary in this sheet (DESIGN.md: at most one
                filled ink element per view) — opening the document is the
                drawer's reason to exist; everything beside it is `quiet`,
                which has no fill, so the six actions stop reading as six
                equals. */}
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
          {/* THE STAR LOSES ITS ★ AND KEEPS ITS GLYPH. It used to draw a
                filled/hollow star character beside the word while every other
                verb in this rail drew nothing — one region, two vocabularies.
                The line glyph is the same shape the row menu, the selection bar
                and the stage give this verb; whether it is ON is `aria-pressed`
                and the word, which is where a state belongs. */}
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
          {/* NO IN-PLACE EDIT, for any kind. Docs holds, versions and files
                a document; it does not open one to type into. A new version
                arrives as a whole FILE through Replace, which is the same
                door an upload comes through and the same version chain
                History reads — one write path instead of two. */}
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
                {/* OBJECT-FIRST: the rail is already about this one document,
                    so the sheet opens over it and asks only who. Outcomes go
                    to the app's single status line, never a second one here. */}
                <GrantSheet
                  open={shareOpen}
                  onClose={() => setShareOpen(false)}
                  audiences={shareHost.audiences}
                  subject={{
                    subjectType: "core.document",
                    subjectId: doc.document_id,
                    ...(doc.title ? { label: doc.title } : {}),
                  }}
                  onStatus={shareHost.onStatus}
                />
              </>
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
        <ActionBtn
          icon="history"
          label="Version history"
          tone="quiet"
          className={shared.detailBtn!}
          onClick={() => onOpenVersions(doc.document_id)}
        />
        {/* §8's own closing sentence: the rail is about ONE row, and it
              follows the selection rather than pinning itself to a document
              the member has moved on from. */}
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
    // A LANDMARK, NOT A DIALOG. Docked, this takes no focus trap, no
    // `aria-modal` and no backdrop: nothing behind it is inert, which is the
    // point — the member is meant to keep picking rows while it is open.
    // `<aside>` because it is content beside the set and about the set.
    <aside className={styles.railDock} aria-label="Document details">
      {body}
    </aside>
  ) : (
    <>
      {/* Dismiss-on-outside-click as a real button, so the same gesture has a
          keyboard equivalent. Only the drawer has one: a docked column takes
          nothing away, so there is nothing for an outside click to dismiss. */}
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
