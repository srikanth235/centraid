// THE STAGE'S PROPERTIES PANEL (§7's `vInfo`/`vMeaning`/`vFacts`).
//
// It is a panel BESIDE the document and never a sheet over it, because the
// question it answers — "what am I looking at" — is asked WHILE looking, and
// closing the thing you are asking about to go and read about it is the one
// move a viewer must not force.
//
// TWO REGISTERS, IN THIS ORDER, and the order is the point. The MEANING rows
// come first: a key, a value, and a note saying what the value means — what a
// folder is, where the bytes are. The FACTS come second: a flat key/value
// ledger with no notes, because a size does not need explaining. A panel that
// mixed them would read as a form; this one reads as an answer followed by its
// receipts.
//
// The rail stands ON THE STAGE, not on paper. Photos' info rail is paper
// because every row there is an editable field; here only the title is, so the
// panel keeps the ground the document is standing on and the handoff's own
// `vInfoStyle` — no background of its own, one hairline seam.
import type { ReactNode } from "react";

import { STAGE_PROPS } from "../document-copy.ts";
import { custodyMeta, fmtBytes, fmtFull, typeMeta } from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./QuickLook.module.css";

/** One meaning row: what it is called, what it says, and what that means. */
function Meaning({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.meaning}>
      <dt className={styles.meaningKey}>{label}</dt>
      <dd className={styles.meaningValue}>{children}</dd>
      {note ? <p className={styles.meaningNote}>{note}</p> : null}
    </div>
  );
}

export function QuickLookInfo({
  doc,
  folderName,
  onClose,
  onRename,
}: {
  doc: DriveDoc;
  folderName: (id: string | null | undefined) => string;
  /** Closes the panel, not the stage — the document stays open behind it. */
  onClose: () => void;
  /** Absent where the shelf cannot write (trash): the title then draws as a
   *  plain value, with no dashed rule promising an edit that would be refused. */
  onRename?: () => void;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const custody = custodyMeta(doc.custody_state);

  // The flat ledger. Every entry is a fact THIS projection carries — the
  // handoff's `Versions` and `Contents` rows are withheld because the drive
  // row has no version count and no read date on it, and a panel that guessed
  // at either would be the screen inventing provenance.
  const facts: [string, string][] = [
    ["Kind", m.name],
    ["Size", fmtBytes(doc.byte_size)],
    ["Added", fmtFull(doc.created_at)],
    ["Last change", fmtFull(doc.updated_at)],
    ["Document", doc.document_id.slice(0, 8)],
  ];

  return (
    <aside className={styles.info} aria-label={STAGE_PROPS.head}>
      <div className={styles.infoHead}>
        <span className={styles.infoHeadLabel}>{STAGE_PROPS.head}</span>
        <button
          type="button"
          className={styles.infoClose}
          aria-label="Close properties"
          onClick={onClose}
        >
          <Icon svg={I.close!} />
        </button>
      </div>
      <div className={styles.infoScroll}>
        <dl className={styles.meanings}>
          <Meaning label={STAGE_PROPS.title}>
            {onRename ? (
              // The dashed rule is the panel's way of saying "this is editable
              // in place" without a pencil on every row (§7.2's caption rule,
              // which Photos' info rail keeps too). It is a real control: it
              // fires the same rename the row menu fires.
              <button
                type="button"
                className={styles.editable}
                title={STAGE_PROPS.titleHint}
                onClick={onRename}
              >
                {doc.title || "Untitled"}
              </button>
            ) : (
              doc.title || "Untitled"
            )}
          </Meaning>
          <Meaning label={STAGE_PROPS.folder} note={STAGE_PROPS.folderNote}>
            {folderName(doc.folder_id)}
          </Meaning>
          <Meaning label={STAGE_PROPS.tags}>
            {doc.tags.length > 0 ? (
              <span className={styles.chipRow}>
                {doc.tags.map((tag) => (
                  <span className={styles.chip} key={tag.tag_id}>
                    {tag.label}
                  </span>
                ))}
              </span>
            ) : (
              STAGE_PROPS.tagsEmpty
            )}
          </Meaning>
          <Meaning
            label={STAGE_PROPS.device}
            note={custody ? STAGE_PROPS.deviceNote : undefined}
          >
            {custody?.label ?? STAGE_PROPS.deviceUnknown}
          </Meaning>
        </dl>
        <p className={styles.factsHead}>{STAGE_PROPS.facts}</p>
        <dl className={styles.facts}>
          {facts.map(([key, value]) => (
            <div className={styles.fact} key={key}>
              <dt className={styles.factKey}>{key}</dt>
              <dd className={styles.factValue}>{value}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.origin}>{STAGE_PROPS.origin}</p>
      </div>
    </aside>
  );
}
