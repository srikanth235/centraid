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
