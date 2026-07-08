import { Fragment, useEffect, useReducer, useRef, useState, type JSX } from 'react';
import type { PaletteBridgeProps, PaletteRowDTO } from '../bridge.js';

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
      className="cd-palette-row"
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
          className="cd-palette-row-tile"
          style={{
            background: row.tile.background,
            boxShadow: row.tile.boxShadow,
            color: row.tile.glyphColor,
          }}
          // eslint-disable-next-line react/no-danger -- icon markup comes from the trusted vanilla Icon set
          dangerouslySetInnerHTML={{ __html: row.iconHtml }}
        />
      ) : (
        <span
          className="cd-palette-row-icon"
          data-accent={row.accent ? 'true' : undefined}
          // eslint-disable-next-line react/no-danger -- icon markup comes from the trusted vanilla Icon set
          dangerouslySetInnerHTML={{ __html: row.iconHtml }}
        />
      )}
      <div className="cd-palette-row-text">
        <div className="cd-palette-row-label">{row.label}</div>
        {row.sub ? <div className="cd-palette-row-sub">{row.sub}</div> : null}
      </div>
      {row.kbd ? (
        <span className="cd-palette-row-kbd">{row.kbd}</span>
      ) : row.meta ? (
        <span className="cd-palette-row-meta">{row.meta}</span>
      ) : null}
    </button>
  );
}

/**
 * Command palette (⌘K), ported to React (issue #325, Phase 3). React owns the
 * overlay, the search field, and up/down + Enter keyboard navigation; the
 * vanilla side supplies `buildGroups(query)` (data + per-row `run` closures)
 * and `onClose`. Emits the same `cd-palette-*` classes.
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

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
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
      className="cd-palette-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="cd-palette" role="dialog" aria-label="Command palette">
        <div className="cd-palette-inputrow">
          <span className="cd-palette-search-icon" aria-hidden="true">
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
            className="cd-palette-input"
            type="text"
            autoComplete="off"
            placeholder="Search apps, chats, templates — or describe a new one…"
            value={query}
            onChange={(e) => {
              setActive(0);
              setQuery(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="cd-palette-esc">esc</span>
        </div>
        <div className="cd-palette-results">
          {groups.map((g) => (
            <Fragment key={g.group}>
              <div className="cd-palette-group">{g.group}</div>
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
        <div className="cd-palette-footer">
          <span className="cd-palette-kbd">↑↓</span>
          <span>navigate</span>
          <span className="cd-palette-kbd">↵</span>
          <span>open</span>
          <span className="cd-palette-kbd">⌘↵</span>
          <span>open in new window</span>
          <span className="cd-palette-footer-sp" />
          <span className="cd-palette-kbd">esc</span>
          <span>close</span>
        </div>
      </div>
    </div>
  );
}
