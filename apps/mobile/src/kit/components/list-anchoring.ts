import type { FlashListProps } from "@shopify/flash-list";

/** Named so `SeatList` can REQUIRE it: a default would be the inheritance the
 *  invariant below forbids. */
export type ListAnchoring = NonNullable<
  FlashListProps<unknown>["maintainVisibleContentPosition"]
>;

/** Roughly one row: "at the top" has to survive a few pixels of overscroll. */
const TOP_FOLLOW_THRESHOLD_PX = 120;

/**
 * FlashList v2 anchors visible content BY DEFAULT. Every seat here sorts newest
 * first, so a row arriving from another device is inserted at the top — and the
 * anchor holds the reader's rows still by scrolling the new one out of sight
 * above the fold. It is present and drawn, just unreachable without scrolling
 * up; a re-sorted row (a rename) leaves the viewport the same way, which reads
 * as a document that vanished. Follow the top while the reader is at it, and
 * hold position once they have scrolled in, where an unrequested jump is worse.
 */
export const NEWEST_FIRST_ANCHORING: ListAnchoring = {
  autoscrollToTopThreshold: TOP_FOLLOW_THRESHOLD_PX,
};
