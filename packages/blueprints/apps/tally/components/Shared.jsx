// Small shared presentational bits used across the sidebar/modals. Pure
// functions of props — no app state. Same role as tasks/notes'
// components/Shared.jsx.
import { useState } from '../react-core.min.js';

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.js for the glyph strings.
export function Icon({ svg }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

// A view is still loading: routed through the template itself, matching the
// old `skeletonTpl()` — the genuine `<kit-skeleton>` custom element, rendered
// as ordinary JSX (see photos/app.jsx for the same convention).
export function ExplistSkeleton({ rows }) {
  return (
    <div className="s-explist">
      <kit-skeleton rows={rows}></kit-skeleton>
    </div>
  );
}

// The backdrop closes on its own click; the modal card itself must stop that
// click from bubbling back here (each modal wraps its card with its own
// stopPropagation handler), matching the old imperative wiring 1:1.
export function ModalBackdrop({ onClose, children }) {
  return (
    <div className="kit-modal-back" onClick={onClose}>
      {children}
    </div>
  );
}

// Confirm-to-act delete button: first click arms (label swap, auto-disarm
// after `timeout`), second click confirms. kit.js's `armConfirm` mutates a
// button's textContent directly, which a React-owned node must never take —
// React apps use a local, remount-reset armed flag instead (see
// notes/components/Toolbar.jsx's DeleteButton for the icon-only analogue);
// this is the text-label version tally's delete buttons need.
export function ArmedButton({ className, label, armedLabel = 'Sure?', disabled, onConfirm }) {
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
