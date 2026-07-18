// `<aside class="v-side">` — nav rail: top shortcuts, categories, tags,
// trash, lock + theme. A pure projection of props; clicks call straight back
// into the callbacks app.tsx wired to logic.ts — the React port of app.js's
// `LockerSidebar` Lit component.
import type { ReactNode } from '../react-core.min.js';
import { CAT_ORDER, CATS } from '../format.ts';
import type { Nav } from '../types.ts';
import { Icon, CatIcon } from './Shared.tsx';
import styles from './Sidebar.module.css';
import shared from './shared.module.css';

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.navItem} aria-current={!!active} onClick={onClick}>
      <span className={styles.ic}>{icon}</span>
      <span className={styles.lbl}>{label}</span>
      <span className={styles.ct}>{count == null || count === 0 ? '' : String(count)}</span>
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
}: {
  counts: { all: number; fav: number; watch: number };
  catCounts: Record<string, number>;
  tags: Array<{ tag: string; count: number }>;
  trashCount: number;
  nav: Nav;
  dark: boolean;
  onNav: (nav: Nav) => void;
  onNewItem: () => void;
  onCloseSide: () => void;
  onLock: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <aside className={styles.side}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>
          <Icon name="lock" sw={1.9} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className={styles.brandName}>Locker</div>
          <div className={styles.brandTag}>everything, locked up</div>
        </div>
        <button type="button" className={styles.sideClose} aria-label="Close" onClick={onCloseSide}>
          <Icon name="close" sw={1.75} />
        </button>
      </div>

      <button type="button" className={styles.newbtn} onClick={onNewItem}>
        <Icon name="plus" sw={2} /> New item
      </button>

      <nav className={styles.nav}>
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

      <div className={styles.seclabel}>Categories</div>
      <nav className={styles.nav}>
        {CAT_ORDER.map((t) => (
          <NavItem
            key={t}
            icon={<CatIcon type={t} />}
            label={CATS[t]!.label}
            count={catCounts[t]}
            active={nav.kind === 'cat' && nav.type === t}
            onClick={() => onNav({ kind: 'cat', type: t })}
          />
        ))}
      </nav>

      <div className={styles.seclabel}>Tags</div>
      <nav className={styles.nav}>
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

      <div className={styles.sideFoot}>
        <button type="button" className={styles.lock} onClick={onLock}>
          <Icon name="lock" sw={1.75} /> Lock
        </button>
        <button type="button" className={shared.iconbtn} aria-label="Theme" onClick={onToggleTheme}>
          <Icon name={dark ? 'sun' : 'moon'} sw={1.75} />
        </button>
      </div>
    </aside>
  );
}
