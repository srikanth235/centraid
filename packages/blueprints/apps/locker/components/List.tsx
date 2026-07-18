// `<section class="v-list">` — the search box + filtered/sorted row list for
// the current nav. The React port of app.js's `LockerList` Lit component;
// the search input is a controlled input driven by `search` (app.tsx calls
// `render()` synchronously on every keystroke, same as any other state
// change here — see logic.ts's `applySearchInput` for the debounced fetch
// that runs behind it).
import { catOf, monoOf, subOf, warnColor } from '../format.ts';
import type { LockerRow } from '../types.ts';
import { Icon } from './Shared.tsx';
import styles from './List.module.css';
import shared from './shared.module.css';

function ListRow({
  item,
  selectedId,
  onSelect,
}: {
  item: LockerRow;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const wc = warnColor(item);
  return (
    <button
      type="button"
      className={styles.item}
      aria-current={selectedId === item.item_id}
      onClick={() => onSelect(item.item_id)}
    >
      <span className={shared.itile} style={{ background: catOf(item.type).color }}>
        {monoOf(item)}
      </span>
      <span className={shared.imain}>
        <span className={shared.ititle}>
          {item.title}
          {item.favorite ? (
            <span className={styles.star}>
              <Icon name="starFill" size={12} fill="currentColor" stroke="none" />
            </span>
          ) : null}
          {wc ? <span className={styles.warnDot} style={{ background: wc }} /> : null}
        </span>
        <span className={shared.isub}>{subOf(item) || '—'}</span>
      </span>
    </button>
  );
}

export function LockerList({
  pool,
  listTitle,
  allCount,
  search,
  selectedId,
  onOpenSide,
  onSelect,
  onSearchInput,
  onClearSearch,
}: {
  pool: LockerRow[];
  listTitle: string;
  allCount: number;
  search: string;
  selectedId: string | null;
  onOpenSide: () => void;
  onSelect: (id: string) => void;
  onSearchInput: (value: string) => void;
  onClearSearch: () => void;
}) {
  return (
    <section className={styles.list}>
      <div className={styles.listTop}>
        <div className={styles.listHead}>
          <button type="button" className={styles.hamburger} aria-label="Menu" onClick={onOpenSide}>
            <Icon name="menu" sw={1.75} />
          </button>
          <span className={styles.listTitle}>{listTitle}</span>
          <span className={styles.listCount}>{pool.length}</span>
        </div>
        <div className={styles.search}>
          <Icon name="search" sw={1.75} size={15} />
          <input
            type="search"
            placeholder={`Search ${allCount} items`}
            autoComplete="off"
            value={search}
            onChange={(e) => onSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.preventDefault();
                onClearSearch();
              }
            }}
          />
        </div>
      </div>
      <div className={styles.items}>
        {pool.length === 0 ? (
          <div className={shared.listEmpty}>
            <div className={shared.ic}>
              <Icon name={search.trim() ? 'search' : 'lock'} sw={1.6} size={20} />
            </div>
            <div className={shared.listEmptyTitle}>
              {search.trim() ? 'No matches' : 'Nothing here'}
            </div>
            <div className={shared.listEmptySub}>
              {search.trim()
                ? 'Try a different search term.'
                : 'Add a login, card, or note to get started.'}
            </div>
          </div>
        ) : (
          pool.map((item) => (
            <ListRow key={item.item_id} item={item} selectedId={selectedId} onSelect={onSelect} />
          ))
        )}
      </div>
    </section>
  );
}
