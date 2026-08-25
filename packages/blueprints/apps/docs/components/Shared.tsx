import type { MouseEvent, ReactNode } from "react";

import { custodyRowMark } from "../format.ts";
import { ACTION_ICONS, I } from "../icons.ts";
import type { CustodyTone } from "../types.ts";
import { OFFLINE_BANNER, OFFLINE_BANNER_ACTION } from "../view-copy.ts";

import styles from "./shared.module.css";

// `display:contents` keeps the icon itself the flex child; `<i>` not `<span>`,
// which Sidebar's `span:first-of-type` would catch; `aria-hidden` here because
// `iconSvg()` emits none and `display:contents` still leaves it announced.
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

/** One component, so a verb keeps one glyph everywhere; non-verbs take none. */
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
  tone?: string;
  className?: string;
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

const CUSTODY_DOT_TONE: Record<CustodyTone, string> = {
  ok: styles.custodyOk!,
  warn: styles.custodyWarn!,
  danger: styles.custodyDanger!,
};

// Per-row altitude: the EXCEPTION only, never a custody-less row or a steady
// state (docs/blueprint-seats.md). Hence `custodyRowMark`, not `custodyMeta`.
export function CustodyDot({ state }: { state: string | null }) {
  const meta = custodyRowMark(state);
  if (!meta) return null;
  return (
    // Real text, not a faked `role="img"`.
    <span
      className={`${styles.custodyDot} ${CUSTODY_DOT_TONE[meta.tone]}`}
      title={meta.label}
    >
      <span className="kit-sr-only">{meta.label}</span>
    </span>
  );
}

// Never kit's `snippetInto()`: it mutates DOM a React root owns.
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

export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <output className={styles.offline}>
      <p className={styles.offlineText}>{OFFLINE_BANNER}</p>
      <ActionBtn icon="retry" label={OFFLINE_BANNER_ACTION} onClick={onRetry} />
    </output>
  );
}
