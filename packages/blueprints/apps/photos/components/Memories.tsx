// The memories strip (main Photos view only, per the build prompt — never in
// search/select). Pure view; `memories` is already the fully-derived list
// (see buildMemories() in app.tsx) of `{ key, title, sub, coverUri, onOpen }`.
import type { MemoryCard } from '../types.ts';
import styles from './Memories.module.css';
import shared from './shared.module.css';

export function MemoriesStrip({ memories }: { memories: MemoryCard[] }) {
  if (memories.length === 0) return null;
  return (
    <div className={styles.memories}>
      <div className={shared.sectionLabel}>Memories</div>
      <div className={styles.memoriesStrip}>
        {memories.map((m) => (
          <button
            key={m.key}
            type="button"
            className={styles.memoryCard}
            style={m.coverUri ? { backgroundImage: `url(${m.coverUri})` } : undefined}
            onClick={m.onOpen}
          >
            <span className={styles.memoryScrim} />
            <span className={styles.memoryText}>
              <span className={styles.memoryTitle}>{m.title}</span>
              <span className={styles.memorySub}>{m.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
