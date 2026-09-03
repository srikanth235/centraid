import type { ReactNode } from "react";

import { STAGE_PROPS } from "../document-copy.ts";
import { custodyMeta, fmtBytes, fmtFull, typeMeta } from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./QuickLook.module.css";

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
  onClose: () => void;
  onRename?: () => void;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const custody = custodyMeta(doc.custody_state);

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
