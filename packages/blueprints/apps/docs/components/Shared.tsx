// Small shared presentational bits used across the Sidebar, Grid, List,
// Details and QuickLook components. Pure functions of props — no app state.
import type { MouseEvent } from '../react-core.min.js';
import { custodyMeta } from '../format.ts';
import { I } from '../icons.ts';
import type { CustodyTone } from '../types.ts';
import styles from './shared.module.css';

// A trusted static SVG string rendered inline, with the exact DOM shape the
// old `el(svg)` produced: no wrapper box in the layout (`display:contents`),
// so flex/gap rules written against the *icon itself* being a flex child
// (e.g. `.navItem { gap: 11px }`) keep behaving identically. `<i>` (not
// `<span>`) so it never collides with `.navItem span:first-of-type`, the one
// rule in Sidebar.module.css that counts sibling spans.
export function Icon({ svg }: { svg: string }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Checkbox({
  cls,
  selected,
  onClick,
  label,
}: {
  cls: string;
  selected: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
    >
      {selected ? <Icon svg={I.check!} /> : null}
    </button>
  );
}

// The three custody tones are compound modifiers on the base dot — keyed off a
// lookup map so the tone never becomes `styles[\`custody-${tone}\`]`.
const CUSTODY_DOT_TONE: Record<CustodyTone, string> = {
  ok: styles.custodyOk!,
  warn: styles.custodyWarn!,
  danger: styles.custodyDanger!,
};

// A compact backup-status dot (issue #352 phase 4, blob/custody.ts) for Grid
// cards and List rows — the full-text chip version lives inline in
// Details.tsx, where there's room for the label. Renders nothing for a
// custody-less row (an inline document, or the standing sweep hasn't run
// yet) rather than claim a state the vault never asserted.
export function CustodyDot({ state }: { state: string | null }) {
  const meta = custodyMeta(state);
  if (!meta) return null;
  return (
    <span
      className={`${styles.custodyDot} ${CUSTODY_DOT_TONE[meta.tone]}`}
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
// text-node + <mark> shape `.snippet mark` styles.
export function Snippet({ snippet }: { snippet: string }) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return (
    <div className={styles.snippet}>
      {parts.map((part, i) => (!part ? null : i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </div>
  );
}
