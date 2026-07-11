// `<aside class="v-side">` — nav rail: top shortcuts, categories, tags,
// trash, lock + theme. A pure projection of props; clicks call straight back
// into the callbacks app.jsx wired to logic.js — the React port of app.js's
// `LockerSidebar` Lit component.
import { CAT_ORDER, CATS } from '../format.js';
import { Icon, CatIcon } from './Shared.jsx';

function NavItem({ icon, label, count, active, onClick }) {
  return (
    <button type="button" className="v-nav-item" aria-current={String(!!active)} onClick={onClick}>
      <span className="ic">{icon}</span>
      <span className="lbl">{label}</span>
      <span className="ct">{count == null || count === 0 ? '' : String(count)}</span>
    </button>
  );
}

export function LockerSidebar({
  counts,
  catCounts,
  tags,
  trashCount,
  nav,
  dark,
  onNav,
  onNewItem,
  onCloseSide,
  onLock,
  onToggleTheme,
}) {
  return (
    <aside className="v-side">
      <div className="v-brand">
        <span className="v-brand-mark">
          <Icon name="lock" sw={1.9} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="v-brand-name">Locker</div>
          <div className="v-brand-tag">everything, locked up</div>
        </div>
        <button type="button" className="v-side-close" aria-label="Close" onClick={onCloseSide}>
          <Icon name="close" sw={1.75} />
        </button>
      </div>

      <button type="button" className="v-newbtn" onClick={onNewItem}>
        <Icon name="plus" sw={2} /> New item
      </button>

      <nav className="v-nav">
        <NavItem
          icon={<Icon name="all" />}
          label="All items"
          count={counts.all}
          active={nav.kind === 'all'}
          onClick={() => onNav({ kind: 'all' })}
        />
        <NavItem
          icon={<Icon name="starFill" sw={1.6} />}
          label="Favorites"
          count={counts.fav}
          active={nav.kind === 'fav'}
          onClick={() => onNav({ kind: 'fav' })}
        />
        <NavItem
          icon={<Icon name="shield" />}
          label="Watchtower"
          count={counts.watch}
          active={nav.kind === 'watch'}
          onClick={() => onNav({ kind: 'watch' })}
        />
      </nav>

      <div className="v-seclabel">Categories</div>
      <nav className="v-nav">
        {CAT_ORDER.map((t) => (
          <NavItem
            key={t}
            icon={<CatIcon type={t} />}
            label={CATS[t].label}
            count={catCounts[t]}
            active={nav.kind === 'cat' && nav.type === t}
            onClick={() => onNav({ kind: 'cat', type: t })}
          />
        ))}
      </nav>

      <div className="v-seclabel">Tags</div>
      <nav className="v-nav">
        {tags.map(({ tag, count }) => (
          <NavItem
            key={tag}
            icon={<Icon name="tag" />}
            label={tag}
            count={count}
            active={nav.kind === 'tag' && nav.tag === tag}
            onClick={() => onNav({ kind: 'tag', tag })}
          />
        ))}
        <NavItem
          icon={<Icon name="trash" sw={1.6} />}
          label="Trash"
          count={trashCount}
          active={nav.kind === 'trash'}
          onClick={() => onNav({ kind: 'trash' })}
        />
      </nav>

      <div className="v-side-foot">
        <button type="button" className="v-lock" onClick={onLock}>
          <Icon name="lock" sw={1.75} /> Lock
        </button>
        <button type="button" className="v-iconbtn" aria-label="Theme" onClick={onToggleTheme}>
          <Icon name={dark ? 'sun' : 'moon'} sw={1.75} />
        </button>
      </div>
    </aside>
  );
}
