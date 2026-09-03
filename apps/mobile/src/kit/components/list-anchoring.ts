import type { FlashListProps } from "@shopify/flash-list";

type Anchoring = NonNullable<
  FlashListProps<unknown>["maintainVisibleContentPosition"]
>;

const TOP_FOLLOW_THRESHOLD_PX = 120;

export const NEWEST_FIRST_ANCHORING: Anchoring = {
  autoscrollToTopThreshold: TOP_FOLLOW_THRESHOLD_PX,
};
