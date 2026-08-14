import type { JSX } from "react";

import EmptyBlock from "../../ui/EmptyBlock.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";

/**
 * Stable interstitial for old Storage links. Storage no longer owns a
 * launcher destination, but a persisted route must explain the move and give
 * the member one explicit way forward instead of silently changing pages.
 */
export default function StorageRoute(): JSX.Element {
  const { navigate } = useShellActions();
  return (
    <PageScroll>
      <EmptyBlock
        title="Storage moved into System"
        body="Capacity, disk use, and backups now live together in System. This link still works so saved places and older notifications never dead-end."
        action={{
          label: "Open System",
          onClick: () => navigate({ kind: "gateway" }),
        }}
      />
    </PageScroll>
  );
}
