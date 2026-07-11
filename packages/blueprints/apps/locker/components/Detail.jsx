// `<section class="v-detail">` — back button + (watchtower | item | empty)
// content. The React port of app.js's `LockerDetail` Lit component. The
// item-view internals (field descriptors/rows, including the real-TOTP tick)
// live in ItemFields.jsx to keep this file under the size cap.
import { catOf, monoOf, subOf } from '../format.js';
import { ItemPane } from './ItemFields.jsx';
import { Icon } from './Shared.jsx';

function EmptyPane() {
  return (
    <div className="v-empty-detail">
      <div className="ic">
        <Icon name="lock" sw={1.6} size={28} />
      </div>
      <div style={{ font: 'var(--t-strong)', color: 'var(--ink-2)' }}>Select an item</div>
      <div style={{ font: 'var(--t-small)', marginTop: '4px' }}>
        Pick something from the list to see its details.
      </div>
    </div>
  );
}

function WatchItemRow({ item, onSelect }) {
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
    <button type="button" className="v-wt-item" onClick={() => onSelect(item.item_id)}>
      <span
        className="v-itile"
        style={{
          width: '32px',
          height: '32px',
          fontSize: '13px',
          background: catOf(item.type).color,
        }}
      >
        {monoOf(item)}
      </span>
      <span className="v-imain">
        <span className="v-ititle">{item.title}</span>
        <span className="v-isub">{subOf(item) || '—'}</span>
      </span>
      <span className="v-wt-badge" style={{ background: badge.bg, color: badge.c }}>
        {badge.t}
      </span>
    </button>
  );
}

function WatchtowerPane({ watch, onSelect }) {
  return (
    <div className="v-detail-inner">
      <div className="v-dhead">
        <span className="v-dtile" style={{ background: 'var(--accd)' }}>
          <Icon name="shield" sw={1.8} size={26} stroke="#fff" />
        </span>
        <div>
          <div className="v-dtitle">Watchtower</div>
          <div className="v-dsub">Security review of your locker</div>
        </div>
      </div>

      <div className="v-wt-stats">
        <div className="v-wt-stat">
          <div className="n" style={{ color: 'var(--danger)' }}>
            {watch.compromised}
          </div>
          <div className="k">Compromised</div>
        </div>
        <div className="v-wt-stat">
          <div className="n" style={{ color: 'var(--warn)' }}>
            {watch.weak}
          </div>
          <div className="k">Weak passwords</div>
        </div>
        <div className="v-wt-stat">
          <div className="n" style={{ color: 'var(--warn)' }}>
            {watch.reused}
          </div>
          <div className="k">Reused passwords</div>
        </div>
      </div>

      <div className="v-dlabel">Needs attention</div>
      <div className="v-fields">
        {watch.items.length === 0 ? (
          <div className="v-list-empty" style={{ padding: '26px' }}>
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
}) {
  return (
    <section className="v-detail">
      <button type="button" className="v-back" onClick={onBack}>
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
