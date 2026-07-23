// Small shared presentational bits used across Sidebar/Grid/List/Details/
// Journal/Activity. Pure functions of props — no app state.
import type { CSSProperties, FC, MouseEvent, ReactNode } from 'react';

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.ts for the glyph strings.
export function Icon({ svg }: { svg: string }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Checkbox({
  cls,
  selected,
  onClick,
  label,
  checkSvg,
}: {
  cls: string;
  selected: boolean;
  onClick: () => void;
  label: string;
  checkSvg: string;
}) {
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
    >
      {selected ? <Icon svg={checkSvg} /> : null}
    </button>
  );
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans — the
// React analogue of kit.ts's `snippetInto()`, which mutates a container's DOM
// directly and must never target a React-owned node.
export function Snippet({ snippet, className }: { snippet?: string | null; className?: string }) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return (
    <div className={className}>
      {parts.map((part, i) => (!part ? null : i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </div>
  );
}

// `<kit-avatar>` is a native custom element (kit/elements.js): a monogram tile
// that reads name/size/color as attributes. TSX has no intrinsic-element type
// for it, so we render it through a value typed as a component — at runtime
// this IS the string 'kit-avatar', so the emitted DOM is identical to the JSX
// original (React sets name/size/color as attributes on the custom element).
export const KitAvatar = 'kit-avatar' as unknown as FC<{
  name?: string;
  size?: string;
  color?: string;
  style?: CSSProperties;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  children?: ReactNode;
}>;
