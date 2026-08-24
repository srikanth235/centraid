// Small shared presentational bits used across the Sidebar, Grid, List,
// Details and QuickLook components. Pure functions of props — no app state.
import type { MouseEvent, ReactNode } from "react";

import { custodyRowMark } from "../format.ts";
import { ACTION_ICONS, I } from "../icons.ts";
import type { CustodyTone } from "../types.ts";
import { OFFLINE_BANNER, OFFLINE_BANNER_ACTION } from "../view-copy.ts";

import styles from "./shared.module.css";

// A trusted static SVG string rendered inline, with the exact DOM shape the
// old `el(svg)` produced: no wrapper box in the layout (`display:contents`),
// so flex/gap rules written against the *icon itself* being a flex child
// (e.g. `.navItem { gap: 11px }`) keep behaving identically. `<i>` (not
// `<span>`) so it never collides with `.navItem span:first-of-type`, the one
// rule in Sidebar.module.css that counts sibling spans.
// `aria-hidden` on the wrapper, not on the SVG: `iconSvg()` (packages/design)
// emits a bare `<svg>` with no `aria-hidden` of its own, so without this every
// glyph in the app is an unnamed graphic sitting inside a control — some
// screen readers narrate it as a second, empty stop next to the control's own
// name, and a control whose ONLY content is a glyph computes no name at all
// from its contents. `display: contents` removes the <i> from the box tree but
// not from the accessibility tree, so the attribute still hides the subtree.
export function Icon({ svg }: { svg: string }) {
  return (
    <i
      aria-hidden="true"
      style={{ display: "contents" }}
      // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * A `kit-btn` that wears its verb's glyph.
 *
 * ONE COMPONENT, so a verb cannot pick up a different shape in a different
 * region — the mark comes from `ACTION_ICONS` by name, and the name is the
 * verb. Buttons that are NOT verbs (Done, a tab, a segment) do not use this
 * and take no glyph: a mark beside every word is the same as a mark beside
 * none, because nothing stands out.
 *
 * `tone` maps onto the kit's own classes rather than inventing a palette:
 * `primary` is the view's one fill, `quiet` has no outline, `danger` takes the
 * destructive ink. Anything a caller needs on top of that (an `aria-pressed`,
 * a `download`) rides in `extra`.
 */
export function ActionBtn({
  icon,
  label,
  tone = "",
  className = "",
  href,
  onClick,
  extra,
}: {
  icon: keyof typeof ACTION_ICONS;
  label: ReactNode;
  /** Extra kit classes: `primary`, `quiet`, `destructive danger`. */
  tone?: string;
  /** The caller's own layout class, where a region pins width or order. */
  className?: string;
  /** Present makes it an anchor — a real link keeps the browser's own save
   *  behaviour and its context menu. */
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  extra?: Record<string, unknown>;
}) {
  const cls = `kit-btn ${tone} ${styles.actBtn} ${className}`.replace(
    /\s+/gu,
    " "
  );
  const inner = (
    <>
      <Icon svg={ACTION_ICONS[icon]} />
      <span>{label}</span>
    </>
  );
  return href === undefined ? (
    <button type="button" className={cls} onClick={onClick} {...extra}>
      {inner}
    </button>
  ) : (
    <a className={cls} href={href} onClick={onClick} {...extra}>
      {inner}
    </a>
  );
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

// A compact backup-status dot (#352 phase 4, blob/custody.ts) for Grid
// cards and List rows — the full-text chip version lives inline in
// Details.tsx, where there's room for the label. Renders nothing for a
// custody-less row (an inline document, or the standing sweep hasn't run
// yet) rather than claim a state the vault never asserted, AND nothing for
// the two steady states (`replicated`/`remote-only`) — this is the per-row
// altitude, so it marks the EXCEPTION only (docs/blueprint-seats.md "Byte
// custody vocabulary"). `custodyRowMark`, not `custodyMeta`.
export function CustodyDot({ state }: { state: string | null }) {
  const meta = custodyRowMark(state);
  if (!meta) return null;
  return (
    // The label is real text (visually hidden) rather than an `aria-label` on a
    // `role="img"` wrapper — same announcement, no faked role.
    <span
      className={`${styles.custodyDot} ${CUSTODY_DOT_TONE[meta.tone]}`}
      title={meta.label}
    >
      <span className="kit-sr-only">{meta.label}</span>
    </span>
  );
}

// The search-hit snippet: replicated as JSX `<mark>` spans instead of calling
// kit's `snippetInto()` — that helper mutates a container's DOM directly,
// which must never target a React-owned node (this row lives in a React
// root). Plain strings interleaved with `<mark>` reproduce the exact old
// text-node + <mark> shape `.snippet mark` styles.
export function Snippet({ snippet }: { snippet: string }) {
  const parts = String(snippet ?? "").split(/[⟦⟧]/u);
  return (
    <div className={styles.snippet}>
      {parts.map((part, i) =>
        part ? i % 2 === 1 ? <mark key={i}>{part}</mark> : part : null
      )}
    </div>
  );
}

// §11's offline banner — ONE paragraph, ONE action, drawn above every route
// body (app-root.tsx) because it changes what all of them can promise: counts
// read from this device, documents that cannot be opened, search unavailable.
export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <output className={styles.offline}>
      <p className={styles.offlineText}>{OFFLINE_BANNER}</p>
      <ActionBtn icon="retry" label={OFFLINE_BANNER_ACTION} onClick={onRetry} />
    </output>
  );
}
