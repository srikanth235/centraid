import type { JSX } from "react";

import PageScroll from "../PageScroll.js";
import AtlasRoute from "./AtlasRoute.js";
import HouseholdRoute from "./HouseholdRoute.js";

/**
 * Vault answers one custody question with live contents, copies and sharing.
 * The legacy `atlas` and `household` routes still resolve independently for
 * persisted pins and deep links; this route composes the same operational
 * readers without duplicating their gateway wires.
 */
export default function VaultRoute(): JSX.Element {
  return (
    <PageScroll>
      <AtlasRoute embedded />
      <HouseholdRoute embedded />
    </PageScroll>
  );
}
