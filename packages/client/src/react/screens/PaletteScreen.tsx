import { Fragment, useEffect, useReducer, useRef, useState, type JSX } from 'react';
import type { PaletteBridgeProps, PaletteRowDTO } from '../screen-contracts.js';
import styles from './PaletteScreen.module.css';

function Row({
  row,
  activeIsThis,
  onRun,
}: {
  row: PaletteRowDTO;
  activeIsThis: boolean;
  onRun: () => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeIsThis) {
      // Optional-call: jsdom (tests) doesn't implement scrollIntoView.
      ref.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIsThis]);
  return (
    <button
      ref={ref}
      type="button"
      className={styles.row}
      data-variant={row.variant}
      data-active={String(activeIsThis)}
      onMouseDown={(e) => {
        // Keep focus in the input; run on click.
        e.preventDefault();
      }}
      onClick={onRun}
    >
      {row.variant === 'app' && row.tile ? (
        <div
          className={styles.rowTile}
          style={{
            background: row.tile.background,
            boxShadow: row.tile.boxShadow,
            color: row.tile.glyphColor,
          }}
          // eslint-disable-next-line react/no-danger -- (#325) icon markup comes from the trusted vanilla Icon set
          dangerouslySetInnerHTML={{ __html: row.iconHtml }}
        />
      ) : (
        <span
          className={styles.rowIcon}
          data-accent={row.accent ? 'true' : undefined}
          // eslint-disable-next-line react/no-danger -- (#325) icon markup comes from the trusted vanilla Icon set
          dangerouslySetInnerHTML={{ __html: row.iconHtml }}
        />
      )}
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{row.label}</div>
        {row.sub ? <div className={styles.rowSub}>{row.sub}</div> : null}
      </div>
      {row.kbd ? (
        <span className={styles.rowKbd}>{row.kbd}</span>
      ) : row.meta ? (
        <span className={styles.rowMeta}>{row.meta}</span>
      ) : null}
    </button>
  );
}

/**
 * Command palette (⌘K), ported to React (issue #325, Phase 3). React owns the
 * overlay, the search field, and up/down + Enter keyboard navigation; the
 * vanilla side supplies `buildGroups(query)` (data + per-row `run` closures)
 * and `onClose`. Styles are co-located in `PaletteScreen.module.css` (scoped
 * CSS Modules — issue #325 Phase 4).
 */
export default function PaletteScreen({
  buildGroups,
  onClose,
  onReady,
}: PaletteBridgeProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    onReady?.(refresh);
  }, [onReady]);

  // Computed inline (not memoized) so an async `refresh()` re-runs buildGroups.
  const groups = buildGroups(query.trim());
  const rows = groups.flatMap((g) => g.items);

  // Keep the active index in range as results shrink.
  const clampedActive = active >= rows.length ? Math.max(0, rows.length - 1) : active;

  const run = (row: PaletteRowDTO | undefined): void => {
    row?.run();
  };

  // Escape must close the dialog no matter where focus sits — the input's
  // onKeyDown below only fires while the input has focus, and a click on the
  // results whitespace or the footer hint bar moves focus off it, stranding
  // the palette open (backdrop click aside).
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Escape is handled by the document-level listener above (it also
    // covers the input-focused case — keydown bubbles to document).
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(rows[clampedActive]);
    }
  };

  let rowIndex = -1;
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={styles.root} role="dialog" aria-label="Command palette">
        <div className={styles.inputrow}>
          <span className={styles.searchIcon} aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            autoComplete="off"
            placeholder="Search apps and conversations…"
            value={query}
            onChange={(e) => {
              setActive(0);
              setQuery(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
          <span className={styles.esc}>esc</span>
        </div>
        <div className={styles.results}>
          {groups.map((g) => (
            <Fragment key={g.group}>
              <div className={styles.group}>{g.group}</div>
              {g.items.map((item) => {
                rowIndex += 1;
                const thisIndex = rowIndex;
                return (
                  <Row
                    key={`${g.group}:${item.label}:${thisIndex}`}
                    row={item}
                    activeIsThis={thisIndex === clampedActive}
                    onRun={() => run(item)}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
        <div className={styles.footer}>
          <span className={styles.kbd}>↑↓</span>
          <span>navigate</span>
          <span className={styles.kbd}>↵</span>
          <span>open</span>
          <span className={styles.kbd}>⌘↵</span>
          <span>open in new window</span>
          <span className={styles.footerSp} />
          <span className={styles.kbd}>esc</span>
          <span>close</span>
        </div>
      </div>
    </div>
  );
}
