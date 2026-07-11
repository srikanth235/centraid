// The Details drawer's tag editor (issue #352 phase 4): add/remove chips
// over core.tag_entity/untag_entity (an owner "Labels" concept scheme,
// packages/vault/src/commands/tags.ts) — additive and idempotent, so
// retyping an existing label just no-ops rather than erroring. Mirrors the
// photos app's Lightbox.jsx tag editor (its `lightbox-tags` block) almost
// verbatim, adapted to docs' own class names.
import { useState } from '../react-core.min.js';

export function Tags({ doc, onAddTag, onRemoveTag }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const tags = doc.tags ?? [];
  const trashed = doc.trashed;

  return (
    <div className="d-tags-row">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className="kit-chip d-tag-chip"
          aria-label={`Remove tag ${tag}`}
          disabled={trashed}
          onClick={() => onRemoveTag(doc, tag)}
        >
          {tag} ×
        </button>
      ))}
      {trashed ? null : adding ? (
        <input
          type="text"
          className="kit-input bare d-tag-input"
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
        <button type="button" className="kit-chip quiet d-tag-add" onClick={() => setAdding(true)}>
          ＋ Tag
        </button>
      )}
    </div>
  );
}
