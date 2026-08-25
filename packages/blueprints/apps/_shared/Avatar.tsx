import type { ReactNode } from "react";

// A monogram tile: the identity mark a person, group or party is shown by.
//
// It emits `.kit-avatar` markup, which every rule in
// `@centraid/design/kit.css` styles (#799).
//
// Passing `onClick` makes the tile a real `<button>` carrying `label` rather
// than a click handler bolted onto the decorative span. A handler on a
// decorative, `aria-hidden` span leaves the affordance unreachable by
// keyboard and invisible to a screen reader; `button.kit-avatar` in kit.css
// strips the native button chrome so the two shapes paint identically.
import { identityColor, identityInitials } from "@centraid/design";

export function Avatar({
  name = "",
  size = "2.25rem",
  shape,
  src,
  color,
  initials,
  onClick,
  label,
}: {
  name?: string;
  /** Any CSS length; the monogram's type scales with it. */
  size?: string;
  shape?: string;
  src?: string;
  color?: string;
  initials?: string;
  /** Supply with `label` to render the tile as a real, focusable control. */
  onClick?: () => void;
  label?: string;
}): ReactNode {
  const text = name.trim() || "?";
  const style = {
    background: color || identityColor(text),
    fontSize: `calc(${size} * 0.36)`,
    height: size,
    width: size,
  };
  const body = src ? (
    <img alt="" src={src} />
  ) : (
    initials || identityInitials(text)
  );
  if (onClick && label) {
    return (
      <button
        aria-label={label}
        className="kit-avatar"
        data-shape={shape || undefined}
        onClick={onClick}
        style={style}
        type="button"
      >
        {body}
      </button>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="kit-avatar"
      data-shape={shape || undefined}
      style={style}
    >
      {body}
    </span>
  );
}
