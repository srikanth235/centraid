// `<section class="v-detail">` — back button + (watchtower | item | empty)
// content. The React port of app.js's `LockerDetail` Lit component. The
// item-view internals (field descriptors/rows, including the real-TOTP tick)
// live in ItemFields.tsx to keep this file under the size cap.
import { catOf, monoOf, subOf } from '../format.ts';
import type { LockerDetail as DetailItem, LockerRow, WatchState } from '../types.ts';
import { ItemPane } from './ItemFields.tsx';
import { Icon } from './Shared.tsx';
import styles from './Detail.module.css';
import shared from './shared.module.css';

function EmptyPane() {
  return (
    <div className={styles.emptyDetail}>
      <div className={styles.ic}>
        <Icon name="lock" sw={1.6} size={28} />
      </div>
      <div style={{ font: 'var(--t-strong)', color: 'var(--ink-2)' }}>Select an item</div>
      <div style={{ font: 'var(--t-small)', marginTop: '4px' }}>
        Pick something from the list to see its details.
      </div>
    </div>
  );
}

function WatchItemRow({ item, onSelect }: { item: LockerRow; onSelect: (id: string) => void }) {
  const badge = item.compromised
    ? {
        t: 'Compromised',
        bg: 'color-mix(in oklab, var(--danger) 14%, transparent)',
        c: 'var(--danger)',
      }
    : item.weak
      ? { t: 'Weak', bg: 'color-mix(in oklab, var(--warn) 16%, transparent)', c: 'var(--warn)' }
      : { t: 'Reused', bg: 'color-mix(in oklab, var(--warn) 16%, transparent)', c: 'var(--warn)' };
  return (
    <button type="button" className={styles.wtItem} onClick={() => onSelect(item.item_id)}>
      <span
        className={shared.itile}
        style={{
          width: '32px',
          height: '32px',
          fontSize: '13px',
          background: catOf(item.type).color,
        }}
      >
        {monoOf(item)}
      </span>
      <span className={shared.imain}>
        <span className={shared.ititle}>{item.title}</span>
        <span className={shared.isub}>{subOf(item) || '—'}</span>
      </span>
      <span className={styles.wtBadge} style={{ background: badge.bg, color: badge.c }}>
        {badge.t}
      </span>
    </button>
  );
}

function WatchtowerPane({
  watch,
  onSelect,
}: {
  watch: WatchState;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={shared.detailInner}>
      <div className={shared.dhead}>
        <span className={shared.dtile} style={{ background: 'var(--accd)' }}>
          <Icon name="shield" sw={1.8} size={26} stroke="#fff" />
        </span>
        <div>
          <div className={shared.dtitle}>Watchtower</div>
          <div className={shared.dsub}>Security review of your locker</div>
        </div>
      </div>

      <div className={styles.wtStats}>
        <div className={styles.wtStat}>
          <div className={styles.n} style={{ color: 'var(--danger)' }}>
            {watch.compromised}
          </div>
          <div className={styles.k}>Compromised</div>
        </div>
        <div className={styles.wtStat}>
          <div className={styles.n} style={{ color: 'var(--warn)' }}>
            {watch.weak}
          </div>
          <div className={styles.k}>Weak passwords</div>
        </div>
        <div className={styles.wtStat}>
          <div className={styles.n} style={{ color: 'var(--warn)' }}>
            {watch.reused}
          </div>
          <div className={styles.k}>Reused passwords</div>
        </div>
      </div>

      <div className={shared.dlabel}>Needs attention</div>
      <div className={shared.fields}>
        {watch.items.length === 0 ? (
          <div className={shared.listEmpty} style={{ padding: '26px' }}>
            Your locker looks healthy.
          </div>
        ) : (
          watch.items.map((item) => (
            <WatchItemRow key={item.item_id} item={item} onSelect={onSelect} />
          ))
        )}
      </div>
    </div>
  );
}

export function LockerDetail({
  mode,
  watch,
  detail,
  reveal,
  onBack,
  onSelect,
  onToggleReveal,
  onToggleFav,
  onEdit,
  onTrash,
  onRestore,
  onPurge,
}: {
  mode: 'watch' | 'item' | 'empty';
  watch: WatchState;
  detail: DetailItem | null;
  reveal: Record<string, boolean>;
  onBack: () => void;
  onSelect: (id: string) => void;
  onToggleReveal: (fid: string) => void;
  onToggleFav: (sel: DetailItem) => void;
  onEdit: (sel: DetailItem) => void;
  onTrash: (sel: DetailItem) => void;
  onRestore: (sel: DetailItem) => void;
  onPurge: (sel: DetailItem) => void;
}) {
  return (
    <section className={styles.detail}>
      <button type="button" className={styles.back} onClick={onBack}>
        <Icon name="back" sw={1.9} size={18} /> Back
      </button>
      {mode === 'watch' ? (
        <WatchtowerPane watch={watch} onSelect={onSelect} />
      ) : mode === 'item' ? (
        <ItemPane
          sel={detail}
          reveal={reveal}
          onToggleReveal={onToggleReveal}
          onToggleFav={onToggleFav}
          onEdit={onEdit}
          onTrash={onTrash}
          onRestore={onRestore}
          onPurge={onPurge}
        />
      ) : (
        <EmptyPane />
      )}
    </section>
  );
}
