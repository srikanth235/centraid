// The Tally chrome as JSX (issue #505 inline path). One-for-one with the static
// body markup index.html serves — the sidebar (brand, "Add an expense",
// smart-nav / groups / friends slots with their section headers, the consent
// trust row), the topbar (hamburger, active heading + avatar, search, settle
// button, theme button, [data-ask-mount]), the consent/notice banners and the
// scroll host — but expressed as a React tree so app-inline.tsx renders one tree
// instead of five imperative roots. Classes come from Chrome.module.css (scoped
// chrome) + the global kit-* vocabulary (kit.css, loaded once by the route host).
import type { KeyboardEvent, ReactNode } from './react-core.min.js';
import styles from './Chrome.module.css';

export interface ChromeAvatar {
  bg: string;
  text: string;
}

export interface ChromeProps {
  narrow: boolean;
  sideOpen: boolean;
  title: string;
  sub: string;
  avatar: ChromeAvatar | null;
  showSettle: boolean;
  consent: { message: string } | null;
  onOpenSide: () => void;
  onCloseSide: () => void;
  onAddExpense: () => void;
  onNewGroup: () => void;
  onAddFriend: () => void;
  onSettle: () => void;
  onSearchInput: () => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  themeButtonRef: (el: HTMLButtonElement | null) => void;
  smartNav: ReactNode;
  groupsNav: ReactNode;
  friendsNav: ReactNode;
  content: ReactNode;
  modal: ReactNode;
}

const brandGlyph = (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 7h16M4 12h16M4 17h10" />
    <circle cx="18" cy="17" r="3" />
  </svg>
);

const plusGlyph = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const smallPlusGlyph = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : '',
    props.sideOpen ? styles.sideOpen : '',
    // Global classes the reused Dashboard.module.css `:global(.tally.is-narrow)`
    // rules key on — the module-scoped .isNarrow above can't be seen from
    // another module, so mirror the served app's static #root classes here.
    'tally',
    props.narrow ? 'is-narrow' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass}>
      <aside className={styles.side} aria-label="Tally navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {brandGlyph}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className={styles.brandName}>Tally</div>
            <div className={styles.brandTag}>split, settled</div>
          </div>
          <button
            type="button"
            className={styles.sideClose}
            aria-label="Close menu"
            onClick={props.onCloseSide}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <button type="button" className={styles.add} onClick={props.onAddExpense}>
          {plusGlyph}
          Add an expense
        </button>

        <nav className={styles.nav} aria-label="Views">
          {props.smartNav}
        </nav>

        <div className={styles.seclabel}>
          <span>Groups</span>
          <button type="button" aria-label="New group" onClick={props.onNewGroup}>
            {smallPlusGlyph}
          </button>
        </div>
        <div className={styles.nav}>{props.groupsNav}</div>

        <div className={styles.seclabel}>
          <span>Friends</span>
          <button type="button" aria-label="Add friend" onClick={props.onAddFriend}>
            {smallPlusGlyph}
          </button>
        </div>
        <div className={styles.nav}>{props.friendsNav}</div>

        <div className={styles.sideFoot}>
          <div className={styles.consent}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
              <path d="m9.5 12 2 2 3.5-3.5" />
            </svg>
            <span>Every write is consent-checked &amp; receipted</span>
          </div>
        </div>
      </aside>

      <div className={styles.scrim} onClick={props.onCloseSide} />

      <main className={styles.main}>
        <div className={styles.topbar}>
          <button
            type="button"
            className={styles.hamburger}
            aria-label="Open menu"
            onClick={props.onOpenSide}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className={styles.head}>
            {props.avatar ? (
              <span className={styles.headAv} style={{ background: props.avatar.bg }}>
                {props.avatar.text}
              </span>
            ) : null}
            <div style={{ minWidth: 0 }}>
              <div className={styles.title}>{props.title}</div>
              <div className={styles.sub}>{props.sub}</div>
            </div>
          </div>
          <div className={styles.tools}>
            <div className={styles.search}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              {/* id is load-bearing: logic.ts's applySearch/clearSearch read
                  and clear this input via getElementById('searchInput'). */}
              <input
                id="searchInput"
                type="search"
                placeholder="Search expenses"
                aria-label="Search expenses by description"
                autoComplete="off"
                onInput={props.onSearchInput}
                onKeyDown={props.onSearchKeyDown}
              />
            </div>
            {props.showSettle ? (
              <button type="button" className="kit-btn" onClick={props.onSettle}>
                Settle up
              </button>
            ) : null}
            <button
              ref={props.themeButtonRef}
              type="button"
              className={styles.iconbtn}
              aria-label="Toggle light/dark"
            />
            <div className={styles.askMount} data-ask-mount />
          </div>
        </div>

        {props.consent ? (
          <div className={styles.banner}>
            <strong>No vault access yet.</strong> <span>{props.consent.message}</span>
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts (notice / readFailed) — rendered once,
            never reconciled, so those DOM writes are never clobbered. */}
        <div
          id="noticeBanner"
          className={`${styles.banner} ${styles.notice}`}
          role="status"
          aria-live="polite"
          hidden
        />

        <div className={styles.scroll}>
          <div className={styles.wrap}>{props.content}</div>
        </div>
      </main>

      {props.modal}
    </div>
  );
}
