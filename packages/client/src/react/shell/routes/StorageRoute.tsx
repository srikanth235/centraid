import type { JSX } from "react";

import EmptyBlock from "../../ui/EmptyBlock.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";

export default function StorageRoute(): JSX.Element {
  const { navigate } = useShellActions();
  return (
    <PageScroll>
      <EmptyBlock
        title="Storage moved into System"
        body="Capacity, disk use, and backups now live together in System."
        action={{
          label: "Open System",
          onClick: () => navigate({ kind: "gateway" }),
        }}
      />
    </PageScroll>
  );
}
