// A horizontal proportion bar — password strength in Locker, and any other
// "how much of this" reading. Determinate only: the grammar has no
// indeterminate bar, because a local-first product always knows the ratio.
//
// It emits `.kit-bar` markup, which `@centraid/design/kit.css` already styles
// (#799).
import type { ReactNode } from "react";

export function Meter({
  ratio = 0,
  tone,
}: {
  /** Clamped to 0…1 — a caller's out-of-range reading never overdraws. */
  ratio?: number;
  /** `danger`/`warn`/`ok` are the tinted fills; anything else reads neutral. */
  tone?: string;
}): ReactNode {
  const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
  return (
    <span aria-hidden="true" className="kit-bar">
      <span
        className="kit-bar-fill"
        data-tone={tone || undefined}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
