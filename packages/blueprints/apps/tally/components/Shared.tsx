// Small shared presentational bits used across the sidebar/modals. Pure
// functions of props — no app state. Same role as tasks/notes'
// components/Shared.tsx.
import { useState } from 'react';
import type { FC, ReactNode } from 'react';
import shared from './shared.module.css';

// The kit's native custom elements (`<kit-avatar>`, `<kit-skeleton>`, defined
// in kit/elements.js). TSX has no intrinsic-element type for them, so we render
// them through values typed as components — at runtime each IS the host tag
// string, so `jsx('kit-avatar', props)` emits the exact same DOM the JSX
// original did (React sets the props as attributes on the custom element). The
// cast is the one place the host tag becomes typed (pilot addendum 4).
export const KitAvatar = 'kit-avatar' as unknown as FC<{
  name?: string;
  size?: string;
  color?: string;
  initials?: string;
}>;
export const KitSkeleton = 'kit-skeleton' as unknown as FC<{ rows?: number }>;

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.ts for the glyph strings.
export function Icon({ svg }: { svg: string }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

// A view is still loading: routed through the template itself, matching the
// old `skeletonTpl()` — the genuine `<kit-skeleton>` custom element, rendered
// as ordinary JSX (see photos/app.tsx for the same convention).
export function ExplistSkeleton({ rows }: { rows: number }) {
  return (
    <div className={shared.explist}>
      <KitSkeleton rows={rows} />
    </div>
  );
}

// The backdrop closes on its own click; the modal card itself must stop that
// click from bubbling back here (each modal wraps its card with its own
// stopPropagation handler), matching the old imperative wiring 1:1.
export function ModalBackdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="kit-modal-back" onClick={onClose}>
      {children}
    </div>
  );
}

// Confirm-to-act delete button: first click arms (label swap, auto-disarm
// after `timeout`), second click confirms. kit.ts's `armConfirm` mutates a
// button's textContent directly, which a React-owned node must never take —
// React apps use a local, remount-reset armed flag instead (see
// notes/components/Toolbar.tsx's DeleteButton for the icon-only analogue);
// this is the text-label version tally's delete buttons need.
export function ArmedButton({
  className,
  label,
  armedLabel = 'Sure?',
  disabled,
  onConfirm,
}: {
  className: string;
  label: string;
  armedLabel?: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? armedLabel : label}
    </button>
  );
}
