// What a blueprint app contributes to the FRAME, in the shape every app
// contributes it (Photos v4 handoff §3/§3.1/§16, Docs spec §1.4/§11).
//
// An inline app is a route inside the frame, not a standalone app: the app bar,
// the ONE status line and the compact band are the frame's, and a contribution
// says what they should CARRY and nothing about how they look — an app that
// could restyle the bar would be drawing a second chrome inside the first. This
// module is the SKELETON each app's `frame.tsx` fills in, because two routes in
// one frame contributing through two differently-shaped modules would drift.
import type { CSSProperties, ReactNode } from "react";

import { iconSvg } from "@centraid/design";

import type { InlineBandClaim, InlineFrame } from "../inline-types.ts";
import type { BandDestination } from "./shelves.ts";

/** One write's outcome, as the status line carries it. */
export interface Outcome {
  text: string;
  /** The inline text action — the status line's one slot, used for Undo. */
  undo?: () => void;
  /** Determinate progress with exact counts. Never a spinner. */
  progress?: { done: number; total: number; unit?: string };
}

/** Put an outcome on the frame's ONE status line, or take it back down. */
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

/** The compact band claim. The app names its own destinations and which one is
 *  lit; the frame keeps the home capsule outside the group, enforces the cap,
 *  and ignores the claim on any surface that is not compact. */
export function bandClaim(
  destinations: readonly BandDestination[],
  activeId: string | undefined,
  onSelect: (segment: string) => void,
  onMore: () => void
): InlineBandClaim {
  return { destinations, activeId, onSelect, onMore };
}

/** A count in the words the product uses, pluralised on the shelf's own noun. */
export function countLabel(count: number, unit: string): string {
  const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${count} ${count === 1 ? singular : unit}`;
}

/** What every app bar's state carries beyond its own verbs. */
export interface AppBarBase {
  /** How many things this view is showing, or null where a count would have to
   *  be invented (the Duplicates clusters, an empty Places map). */
  count: number | null;
  /**
   * Is this surface compact? On compact the band already carries a Search
   * destination — a second Search control in the bar would be a second way to
   * the same place. Desktop/PWA has no band, so the bar is the only way in.
   */
  compact: boolean;
  /** Reach the Search shelf; omitted where there is no way to search. */
  onSearch?: () => void;
}

/** The bar's own way to the Search shelf, on POINTER SURFACES ONLY (see
 *  `AppBarBase.compact`). Outlined, never filled: the shelf's own verb stays
 *  the one filled ink element. The glyph is the shared registry's, not a
 *  hand-drawn path, so two apps' search buttons cannot become two marks. */
export function SearchBarButton({
  label,
  onSearch,
}: {
  /** The accessible name — an app names the thing it searches. */
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
