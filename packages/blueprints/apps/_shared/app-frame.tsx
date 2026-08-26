// What a blueprint app contributes to the FRAME. Do not restyle the bar.
import type { CSSProperties, ReactNode } from "react";

import { iconSvg } from "@centraid/design";

import type { InlineBandClaim, InlineFrame } from "../inline-types.ts";
import type { BandDestination } from "./shelves.ts";

export interface Outcome {
  text: string;
  undo?: () => void;
  /** Determinate progress with exact counts. Never a spinner. */
  progress?: { done: number; total: number; unit?: string };
}

export function publishOutcome(
  frame: InlineFrame,
  outcome: Outcome | null
): void {
  if (outcome === null || outcome.text === "") {
    frame.clearStatus();
    return;
  }
  frame.setStatus(outcome.text, {
    ...(outcome.undo ? { action: { label: "Undo", run: outcome.undo } } : {}),
    ...(outcome.progress ? { progress: outcome.progress } : {}),
  });
}

export function bandClaim(
  destinations: readonly BandDestination[],
  activeId: string | undefined,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return { destinations, activeId, onSelect, onMore };
}

export function countLabel(count: number, unit: string): string {
  const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${count} ${count === 1 ? singular : unit}`;
}

export interface AppBarBase {
  /** Null where a count would have to be invented. */
  count: number | null;
  /**
   * Compact: the band already carries Search — a second Search in the bar
   * would be a second way to the same place.
   */
  compact: boolean;
  onSearch?: () => void;
}

/** Bar's Search on pointer surfaces only (`AppBarBase.compact`). Outlined, never filled. */
export function SearchBarButton({
  label,
  onSearch,
}: {
  label: string;
  onSearch: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="kit-icon-btn"
      aria-label={label}
      style={
        {
          "--icon-button-size": "34px",
          border: "1px solid var(--line-strong)",
          borderRadius: "7px",
        } as CSSProperties
      }
      onClick={onSearch}
    >
      <i
        aria-hidden="true"
        style={{ display: "inline-flex" }}
        // oxlint-disable-next-line react/no-danger -- registry output is the reviewed shared icon lowering.
        dangerouslySetInnerHTML={{
          __html: iconSvg("Search", { size: 16, strokeWidth: 1.75 }),
        }}
      />
    </button>
  );
}
