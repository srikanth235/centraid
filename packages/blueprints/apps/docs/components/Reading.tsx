// The reading view (Docs spec §6.1, `readBlock`) — screen `read`.
//
// "The reading view (`read`) and editor (`editor`) render on paper, capped at
// a 34em measure — text never goes on the near-black stage." (§1.8, verbatim.)
// That one sentence is why this is a ROUTE and not a lightbox: the stage is
// for the kinds Docs renders as media, and a document you are reading is not
// one of them. Quick Look stays the interim viewer for those kinds until the
// stage lands; opening a text document lands here instead.
//
// WHAT IS NOT DRAWN, AND WHY. §6.1 puts a machine-written summary above the
// prose and three capability-fed rows below it. All four capabilities are off
// (capabilities.ts), and there is no consent record to read — so the summary
// box is absent (it would be a box with nothing in it, or worse, something
// invented) and the panel §6.1 specifies for exactly this case stands in its
// place, once, at the top.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { loadBlobText } from "../blob-text.ts";
import { capabilityOn } from "../capabilities.ts";
import { READ_OFF, THIS_DOCUMENT } from "../document-copy.ts";
import { decodeDataUri, fmtBytes, fmtFull, typeMeta } from "../format.ts";
import type { DriveDoc } from "../types.ts";

import styles from "./Reading.module.css";

type LoadState = "loading" | "ready" | "error";

/** One block of the document's own prose. Deliberately NOT a markdown
 *  renderer: a heading and a paragraph are the two shapes §6.1 names, and
 *  half-rendered structure reads worse than none. */
interface Block {
  kind: "h" | "p";
  text: string;
}

function blocksOf(body: string): Block[] {
  return body
    .split(/\n{2,}/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const heading = /^#{1,6}\s+(?<text>.+)$/u.exec(
        chunk.split("\n")[0] ?? ""
      );
      return heading?.groups?.["text"]
        ? { kind: "h" as const, text: heading.groups["text"] }
        : { kind: "p" as const, text: chunk.replace(/\n/gu, " ") };
    });
}

export function Reading({
  doc,
  folderName,
  onEdit,
  onOpenVersions,
  onOpenDetails,
  onClose,
}: {
  doc: DriveDoc;
  folderName: (id: string | null | undefined) => string;
  /** Absent where the vault would refuse the write anyway (a non-text kind). */
  onEdit?: () => void;
  onOpenVersions: () => void;
  onOpenDetails: () => void;
  onClose: () => void;
}): ReactNode {
  // The inline `data:` branch is synchronous, so it is decoded during the
  // first render; the effect below owns only the async blob-door read. Same
  // split (and same CSP reason) as the editor's.
  const inline = useMemo<{ state: LoadState; text: string } | null>(() => {
    const uri = doc.content_uri;
    if (typeof uri !== "string" || !uri.startsWith("data:")) return null;
    const text = decodeDataUri(uri);
    return text == null
      ? { state: "error", text: "" }
      : { state: "ready", text };
  }, [doc.content_uri]);
  const [body, setBody] = useState(inline?.text ?? "");
  const [loadState, setLoadState] = useState<LoadState>(
    inline?.state ?? "loading"
  );

  useEffect(() => {
    if (inline) return undefined;
    let cancelled = false;
    loadBlobText(doc.content_uri ?? "")
      .then((text) => {
        if (cancelled) return;
        setBody(text);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [inline, doc.content_uri]);

  const kind = typeMeta(doc.media_type);
  const title = displayText(doc.title || "Untitled");
  const where = displayText(folderName(doc.folder_id));
  const blocks = blocksOf(body);

  return (
    <article className={styles.paper} aria-label={title}>
      <div className={styles.top}>
        <button
          type="button"
          className={`kit-plain-btn ${styles.back}`}
          onClick={onClose}
        >
          ← Back to the drive
        </button>
      </div>

      {/* §6.1's own panel for the state this app is actually in. It precedes
          the reading block, once, and names all three capabilities rather than
          repeating itself beside each thing they would have produced. */}
      {capabilityOn("read") ? null : (
        <section className={styles.off} aria-label={READ_OFF.title}>
          <p className={styles.offEyebrow}>{READ_OFF.eyebrow}</p>
          <h2 className={styles.offTitle}>{READ_OFF.title}</h2>
          <p className={styles.offBody}>{READ_OFF.body}</p>
        </section>
      )}

      <p className={styles.kind}>
        {kind.name} · {fmtBytes(doc.byte_size)}
      </p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.byline}>
        Added {fmtFull(doc.created_at)}
        {doc.updated_at ? ` · edited ${fmtFull(doc.updated_at)}` : ""}
        {doc.folder_id ? ` · in ${where}` : ""}
      </p>

      {loadState === "loading" ? (
        <p className={styles.status}>Loading…</p>
      ) : loadState === "error" ? (
        // A refusal, not a blank page: the bytes are somewhere this surface
        // could not reach, and the member is owed that sentence rather than an
        // empty measure they read as an empty document.
        <p className={styles.failed}>
          This document&rsquo;s text could not be fetched.
        </p>
      ) : (
        blocks.map((block, index) =>
          block.kind === "h" ? (
            <h2 key={`${block.kind}-${index}`} className={styles.heading}>
              {block.text}
            </h2>
          ) : (
            <p key={`${block.kind}-${index}`} className={styles.para}>
              {block.text}
            </p>
          )
        )
      )}

      <h2 className={styles.sectionHead}>{THIS_DOCUMENT.head}</h2>
      <div className={styles.rows}>
        {onEdit ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.rowLabel}>
                {THIS_DOCUMENT.edit.label}
              </span>
              <span className={styles.rowSub}>{THIS_DOCUMENT.edit.sub}</span>
            </div>
            <button type="button" className="kit-btn" onClick={onEdit}>
              {THIS_DOCUMENT.edit.action}
            </button>
          </div>
        ) : null}
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowLabel}>
              {THIS_DOCUMENT.versions.label}
            </span>
            <span className={styles.rowSub}>{THIS_DOCUMENT.versions.sub}</span>
          </div>
          <button type="button" className="kit-btn" onClick={onOpenVersions}>
            {THIS_DOCUMENT.versions.action}
          </button>
        </div>
        {/* The names row states the capability's state and stops. There is no
            "Open" here: it would land on a People link this app has not been
            allowed to look for, and an empty destination is not an answer. */}
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowLabel}>{THIS_DOCUMENT.names.label}</span>
            <span className={styles.rowSub} data-net="true">
              {THIS_DOCUMENT.names.subOff}
            </span>
            <span className={styles.rowNote}>{THIS_DOCUMENT.names.note}</span>
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowLabel}>
              {THIS_DOCUMENT.details.label}
            </span>
            <span className={styles.rowSub}>{THIS_DOCUMENT.details.sub}</span>
          </div>
          <button type="button" className="kit-btn" onClick={onOpenDetails}>
            {THIS_DOCUMENT.details.action}
          </button>
        </div>
      </div>
    </article>
  );
}
