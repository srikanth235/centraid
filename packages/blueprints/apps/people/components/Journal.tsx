// Journal view (#journalView container, mounted whenever nav.kind ===
// 'journal'). A self-contained, stateful leaf (its own useState for mood +
// in-progress draft) — the component instance is never unmounted while the
// owner navigates elsewhere (app.tsx only re-renders this root when the
// journal nav is active, leaving stale content hidden otherwise, same as the
// old Lit version's module-level `journalDraft`/`journalMood` vars), so a
// mood pick or partial line survives a trip to another view and back.
import { useRef, useState } from 'react';
import { fmtJournalDate, hashInt, PALETTE } from '../format.ts';
import type { JournalItem } from '../types.ts';
import { KitAvatar } from './Shared.tsx';
import styles from './Journal.module.css';
import shared from './shared.module.css';

const MOODS = ['😔', '😐', '🙂', '😄'];

function JournalEntry({
  j,
  onOpenDetails,
}: {
  j: JournalItem;
  onOpenDetails: (id: string) => void;
}) {
  if (j.kind === 'auto') {
    const color = j.avatar_color || PALETTE[hashInt(j.name) % PALETTE.length]!;
    return (
      <div className={styles.entry}>
        <KitAvatar
          style={{ cursor: 'pointer' }}
          name={j.name}
          size="40px"
          color={color}
          onClick={() => j.party_id && onOpenDetails(j.party_id)}
        ></KitAvatar>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.dt}>
            {fmtJournalDate(j.date)} · {j.touch}
          </div>
          <p>{j.text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.entry}>
      <span className={styles.em}>{j.mood}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={styles.dt}>{fmtJournalDate(j.date)}</div>
        <p>{j.text}</p>
      </div>
    </div>
  );
}

export function Journal({
  entries,
  onSubmit,
  onOpenDetails,
}: {
  entries: JournalItem[];
  onSubmit: (mood: string, text: string) => Promise<boolean>;
  onOpenDetails: (id: string) => void;
}) {
  const [mood, setMood] = useState('🙂');
  const [draft, setDraft] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await onSubmit(mood, text);
    if (!ok) return;
    setDraft('');
    textRef.current?.focus();
  };

  return (
    <div className={shared.jWrap}>
      <div className={styles.compose}>
        <div style={{ font: 'var(--t-strong)', fontSize: '14px' }}>How was today?</div>
        <div className={styles.moodrow}>
          {MOODS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={styles.mood}
              aria-pressed={mood === emoji}
              onClick={() => setMood(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        <textarea
          ref={textRef}
          className={styles.text}
          rows={2}
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
