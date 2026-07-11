// Small shared presentational bits used across the Sidebar, Grid, List,
// Details and QuickLook components. Pure functions of props — no app state.
import { custodyMeta } from '../format.js';
import { I } from '../icons.js';

// A trusted static SVG string rendered inline, with the exact DOM shape the
// old `el(svg)` produced: no wrapper box in the layout (`display:contents`),
// so flex/gap rules written against the *icon itself* being a flex child
// (e.g. `.d-nav-item { gap: 11px }`) keep behaving identically. `<i>` (not
// `<span>`) so it never collides with `.d-nav-item span:first-of-type`,
// the one rule in app.css that counts sibling spans.
export function Icon({ svg }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Checkbox({ cls, selected, onClick, label }) {
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={String(selected)}
      aria-label={label}
      onClick={onClick}
    >
      {selected ? <Icon svg={I.check} /> : null}
    </button>
  );
}

// A compact backup-status dot (issue #352 phase 4, blob/custody.ts) for Grid
// cards and List rows — the full-text chip version lives inline in
// Details.jsx, where there's room for the label. Renders nothing for a
// custody-less row (an inline document, or the standing sweep hasn't run
// yet) rather than claim a state the vault never asserted.
export function CustodyDot({ state }) {
  const meta = custodyMeta(state);
  if (!meta) return null;
  return (
    <span
      className={`d-custody-dot custody-${meta.tone}`}
      title={meta.label}
      aria-label={meta.label}
      role="img"
    />
  );
}

// The search-hit snippet: replicated as JSX `<mark>` spans instead of calling
// kit's `snippetInto()` — that helper mutates a container's DOM directly,
// which must never target a React-owned node (this row lives in a React
// root). Plain strings interleaved with `<mark>` reproduce the exact old
// text-node + <mark> shape `.d-snippet mark` styles.
export function Snippet({ snippet }) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return (
    <div className="d-snippet">
      {parts.map((part, i) => (!part ? null : i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </div>
  );
}
