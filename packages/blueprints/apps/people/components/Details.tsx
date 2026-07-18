// The profile drawer shell (#detailsRoot root) — a dumb projection: `person`
// is the freshly-read PERSON (or null while the shell shows), `adders` is a
// snapshot of which "+ add" affordances are open. Every write flows out
// through the `on*` callback props into app.tsx's `drawerAct`/`toggleStar`/
// `logInteraction`; this component never calls the vault itself. Body
// sections live in DetailSections.tsx (kept separate to stay under the
// file-size cap); the "+ add" mini-forms live in AddRows.tsx.
import { I } from '../icons.ts';
import type { DetailPerson } from '../types.ts';
import { Icon, KitAvatar } from './Shared.tsx';
import { Sections } from './DetailSections.tsx';
import styles from './Details.module.css';
import shared from './shared.module.css';

export interface DrawerCallbacks {
  onMessage: () => void;
  onCall: () => void;
  onToggleStar: () => void;
  onToggleAdder: (key: string) => void;
  onAddRelationship: (fields: Record<string, unknown>) => Promise<boolean>;
  onAddDate: (fields: Record<string, unknown>) => Promise<boolean>;
  onToggleReminder: (dateId: string) => void;
  onAddTask: (fields: Record<string, unknown>) => Promise<boolean>;
  onToggleTask: (taskId: string) => void;
  onAddNote: (fields: Record<string, unknown>) => Promise<boolean>;
  onAddGift: (fields: Record<string, unknown>) => Promise<boolean>;
  onToggleGift: (giftId: string) => void;
  onAddDebt: (fields: Record<string, unknown>) => Promise<boolean>;
  onSettleDebt: (debtId: string) => void;
}

export function Details({
  person,
  nameGuess,
  color,
  adders,
  onClose,
  onMove,
  ...callbacks
}: {
  person: DetailPerson | null;
  nameGuess: string;
  color: string;
  adders: Record<string, boolean>;
  onClose: () => void;
  onMove: (anchor: HTMLElement) => void;
} & DrawerCallbacks) {
  const dp = person;
  return (
    <>
      <div className={styles.detailsBackdrop} onClick={onClose}></div>
      <aside className={styles.details} role="dialog" aria-modal="true" aria-label="Profile">
        <div className={styles.detailsHead}>
          <span className={styles.lbl}>Profile</span>
          <button type="button" className={styles.detailsX} aria-label="Close" onClick={onClose}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className={styles.detailsBody}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span
              style={{
                display: 'inline-flex',
                borderRadius: '999px',
                boxShadow: `0 8px 22px -6px color-mix(in oklab, ${color} 60%, transparent)`,
              }}
            >
              <KitAvatar name={nameGuess} size="72px" color={color}></KitAvatar>
            </span>
          </div>
          <div className={styles.detailName}>{nameGuess}</div>
          <div className={styles.detailExt}>{dp?.role || ''}</div>
          {dp ? <Sections dp={dp} color={color} adders={adders} {...callbacks} /> : null}
        </div>
        <div className={styles.detailsFoot}>
          {dp ? (
            <button
              type="button"
              className={`kit-btn ${shared.detailBtn}`}
              onClick={(e) => onMove(e.currentTarget)}
            >
              Move to list
            </button>
          ) : null}
        </div>
      </aside>
    </>
  );
}
