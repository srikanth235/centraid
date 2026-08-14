import { useState } from "react";

import { scopeAttr } from "../../_shared/scope-kit.ts";
import { displayText, safeBackgroundImage } from "../../_shared/untrusted.ts";
// The memories strip (main Photos view only, per the build prompt — never in
// search/select). Pure view; `memories` is already the fully-derived list
// (see buildMemories() in app.tsx) of `{ key, title, sub, coverUri, onOpen }`.
import type { MemoryCard } from "../types.ts";

import styles from "./Memories.module.css";
import shared from "./shared.module.css";

export function MemoriesStrip({ memories }: { memories: MemoryCard[] }) {
  const [expanded, setExpanded] = useState(false);
  if (memories.length === 0) return null;
  const visibleMemories = expanded ? memories : memories.slice(0, 3);
  return (
    <div className={styles.memories}>
      <div className={styles.memoriesHeader}>
        <div className={`${shared.sectionLabel} ${styles.memoriesLabel}`}>
          Memories
        </div>
        <button
          type="button"
          className={styles.allMemories}
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          All memories →
        </button>
      </div>
      <div className={styles.memoriesStrip}>
        {visibleMemories.map((m) => {
          const handleOpen = m.onOpen;
          const cover = safeBackgroundImage(m.coverUri);
          const title = displayText(m.title);
          return (
            <button
              key={m.key}
              type="button"
              className={styles.memoryCard}
              /* The cover is one real asset's bytes, and a memory can be built
                 from a shared audience's photo — so the card names the scope its
                 background-image must be fetched in (issue #599). */
              data-scope={scopeAttr(m.coverScopeId)}
              /* A composite control (cover + title + subtitle), so this is a
                 custom accessible NAME, not a duplicate of visible text — the
                 same case DESIGN.md's "aria-label is a replacement" rule and
                 lint-aria-labels' allowlist both carve out for rich cards. */
              aria-label={`Open ${title}`}
              onClick={handleOpen}
            >
              <span
                className={styles.memoryCover}
                style={cover ? { backgroundImage: cover } : undefined}
              />
              <span className={styles.memoryText}>
                <span className={styles.memoryTitle}>{title}</span>
                <span className={styles.memorySub}>{displayText(m.sub)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
