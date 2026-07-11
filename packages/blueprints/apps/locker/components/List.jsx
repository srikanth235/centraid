// `<section class="v-list">` — the search box + filtered/sorted row list for
// the current nav. The React port of app.js's `LockerList` Lit component;
// the search input is a controlled input driven by `search` (app.jsx calls
// `render()` synchronously on every keystroke, same as any other state
// change here — see logic.js's `applySearchInput` for the debounced fetch
// that runs behind it).
import { catOf, monoOf, subOf, warnColor } from '../format.js';
import { Icon } from './Shared.jsx';

function ListRow({ item, selectedId, onSelect }) {
  const wc = warnColor(item);
  return (
    <button
      type="button"
      className="v-item"
      aria-current={String(selectedId === item.item_id)}
      onClick={() => onSelect(item.item_id)}
    >
      <span className="v-itile" style={{ background: catOf(item.type).color }}>
        {monoOf(item)}
      </span>
      <span className="v-imain">
        <span className="v-ititle">
          {item.title}
          {item.favorite ? (
            <span className="v-star">
              <Icon name="starFill" size={12} fill="currentColor" stroke="none" />
            </span>
          ) : null}
          {wc ? <span className="v-warn-dot" style={{ background: wc }} /> : null}
        </span>
        <span className="v-isub">{subOf(item) || '—'}</span>
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
}) {
  return (
    <section className="v-list">
      <div className="v-list-top">
        <div className="v-list-head">
          <button type="button" className="v-hamburger" aria-label="Menu" onClick={onOpenSide}>
            <Icon name="menu" sw={1.75} />
          </button>
          <span className="v-list-title">{listTitle}</span>
          <span className="v-list-count">{pool.length}</span>
        </div>
        <div className="v-search">
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
      <div className="v-items">
        {pool.length === 0 ? (
          <div className="v-list-empty">
            <div className="ic">
              <Icon name={search.trim() ? 'search' : 'lock'} sw={1.6} size={20} />
            </div>
            <div className="v-list-empty-title">{search.trim() ? 'No matches' : 'Nothing here'}</div>
            <div className="v-list-empty-sub">
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
