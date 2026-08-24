// TEXT, ON PAPER, ON THE STAGE (Docs spec §6.1's `readBlock`, §1.8's rule).
//
// "The reading view and editor render on paper, capped at a 34em measure —
// text never goes on the near-black stage." (§1.8, verbatim.) Both halves of
// that sentence are kept here: the sheet below is PAPER — `--bg`, `--text`,
// the app's declared reading register, 34em of measure — and the near-black
// around it is the theater the sheet is standing on, exactly as the handoff's
// own `docsStage` stands its ruled page on `#0B0B0B`.
//
// NOT A ROUTE. Opening a text document does not leave the drive for a full
// screen of its own: text would then be the one kind you could not step
// through with the arrows, could not see the properties of without going
// somewhere else, and had to back out of rather than close. The sheet stands
// on the stage instead.
//
// NOT A MARKDOWN RENDERER, deliberately — a heading and a paragraph are the
// two shapes §6.1 names, and half-rendered structure reads worse than none.
import { useEffect, useMemo, useState } from "react";

import { loadBlobText } from "../blob-text.ts";
import { decodeDataUri } from "../format.ts";
import type { DriveDoc } from "../types.ts";

import styles from "./QuickLook.module.css";

type LoadState = "loading" | "ready" | "error";

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

export function QuickLookText({ doc }: { doc: DriveDoc }) {
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

  const title = doc.title || "Untitled";
  const headingId = `docs-read-${doc.document_id}`;
  return (
    <article className={styles.read} aria-labelledby={headingId}>
      <div className={styles.readBody}>
        <h1 className={styles.readHead} id={headingId}>
          {title}
        </h1>
        {loadState === "loading" ? (
          <p className={styles.readStatus}>Loading…</p>
        ) : loadState === "error" ? (
          // A refusal, not a blank page: the bytes are somewhere this surface
          // could not reach, and the member is owed that sentence rather than
          // an empty measure they read as an empty document.
          <p className={styles.readFailed}>
            This document&rsquo;s text could not be fetched.
          </p>
        ) : (
          blocksOf(body).map((block, index) =>
            block.kind === "h" ? (
              <h2 key={`${block.kind}-${index}`} className={styles.readHead}>
                {block.text}
              </h2>
            ) : (
              <p key={`${block.kind}-${index}`} className={styles.readPara}>
                {block.text}
              </p>
            )
          )
        )}
      </div>
    </article>
  );
}
