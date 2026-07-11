// Journal view (#journalView container, mounted whenever nav.kind ===
// 'journal'). A self-contained, stateful leaf (its own useState for mood +
// in-progress draft) — the component instance is never unmounted while the
// owner navigates elsewhere (app.jsx only re-renders this root when the
// journal nav is active, leaving stale content hidden otherwise, same as the
// old Lit version's module-level `journalDraft`/`journalMood` vars), so a
// mood pick or partial line survives a trip to another view and back.
import { useRef, useState } from '../react-core.min.js';
import { fmtJournalDate, hashInt, PALETTE } from '../format.js';

const MOODS = ['😔', '😐', '🙂', '😄'];

function JournalEntry({ j, onOpenDetails }) {
  if (j.kind === 'auto') {
    const color = j.avatar_color || PALETTE[hashInt(j.name) % PALETTE.length];
    return (
      <div className="j-entry">
        <kit-avatar
          style={{ cursor: 'pointer' }}
          name={j.name}
          size="40px"
          color={color}
          onClick={() => j.party_id && onOpenDetails(j.party_id)}
        ></kit-avatar>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="dt">
            {fmtJournalDate(j.date)} · {j.touch}
          </div>
          <p>{j.text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="j-entry">
      <span className="em">{j.mood}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="dt">{fmtJournalDate(j.date)}</div>
        <p>{j.text}</p>
      </div>
    </div>
  );
}

export function Journal({ entries, onSubmit, onOpenDetails }) {
  const [mood, setMood] = useState('🙂');
  const [draft, setDraft] = useState('');
  const textRef = useRef(null);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await onSubmit(mood, text);
    if (!ok) return;
    setDraft('');
    textRef.current?.focus();
  };

  return (
    <div className="j-wrap">
      <div className="j-compose">
        <div style={{ font: 'var(--t-strong)', fontSize: '14px' }}>How was today?</div>
        <div className="j-moodrow">
          {MOODS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="j-mood"
              aria-pressed={String(mood === emoji)}
              onClick={() => setMood(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        <textarea
          ref={textRef}
          className="j-text"
          rows="2"
          placeholder="Write a line…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        ></textarea>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button
            type="button"
            className="kit-btn primary"
            disabled={!draft.trim()}
            onClick={submit}
          >
            Add entry
          </button>
        </div>
      </div>
      <div style={{ marginTop: '8px' }}>
        {entries.length === 0 ? (
          <p style={{ font: 'var(--t-small)', color: 'var(--ink-3)', padding: '16px 0' }}>
            No entries yet — start with a line above.
          </p>
        ) : (
          entries.map((j, i) => <JournalEntry key={i} j={j} onOpenDetails={onOpenDetails} />)
        )}
      </div>
    </div>
  );
}
