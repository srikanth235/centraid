import type { ReactNode } from "react";

export function Meter({
  ratio = 0,
  tone,
}: {
  ratio?: number;
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
