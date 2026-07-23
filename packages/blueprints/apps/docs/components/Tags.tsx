// The Details drawer's tag editor (issue #352 phase 4): add/remove chips
// over core.tag_item/untag_item (the shared "Tags" concept scheme,
// packages/vault/src/commands/tags.ts) — additive and idempotent, so
// retyping an existing label just no-ops rather than erroring. Mirrors the
// photos app's Lightbox tag editor almost verbatim, adapted to docs' own
// class names.
import { useState } from 'react';
import type { DriveDoc } from '../types.ts';
import styles from './Tags.module.css';
import shared from './shared.module.css';

export function Tags({
  doc,
  onAddTag,
  onRemoveTag,
}: {
  doc: DriveDoc;
  onAddTag: (doc: DriveDoc, label: string) => void;
  onRemoveTag: (doc: DriveDoc, tagId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const tags = doc.tags ?? [];
  const trashed = doc.trashed;

  return (
    <div className={styles.tagsRow}>
      {tags.map((tag) => (
        <button
          key={tag.tag_id}
          type="button"
          className={`kit-chip ${shared.tagChip}`}
          aria-label={`Remove tag ${tag.label}`}
          disabled={trashed}
          onClick={() => onRemoveTag(doc, tag.tag_id)}
        >
          {tag.label} ×
        </button>
      ))}
      {trashed ? null : adding ? (
        <input
          type="text"
          className={`kit-input bare ${styles.tagInput}`}
          placeholder="Tag name"
          aria-label="Add tag"
          value={text}
          autoFocus
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAdding(false);
              setText('');
              return;
            }
            if (e.key !== 'Enter') return;
            const label = e.currentTarget.value.trim();
            setAdding(false);
            setText('');
            if (label) onAddTag(doc, label);
          }}
          onBlur={() => {
            const label = text.trim();
            setAdding(false);
            setText('');
            if (label) onAddTag(doc, label);
          }}
        />
      ) : (
        <button type="button" className="kit-chip quiet" onClick={() => setAdding(true)}>
          ＋ Tag
        </button>
      )}
    </div>
  );
}
