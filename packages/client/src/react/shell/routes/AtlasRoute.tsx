import type { JSX } from "react";

import {
  getGatewayBackupStatus,
  vaultAtlasGraph,
  vaultAtlasPulse,
  vaultAtlasStats,
} from "../../../gateway-client.js";
import AtlasScreen from "../../screens/AtlasScreen.js";
import type { AtlasReport } from "../../screens/AtlasScreen.js";
import PageScroll from "../PageScroll.js";

async function lastBackupAt(): Promise<string | null> {
  const status = await getGatewayBackupStatus();
  const stamps = status.vaults
    .map((v) => v.lastBackupAt)
    .filter((at): at is string => typeof at === "string");
  return stamps.length === 0 ? null : (stamps.sort().at(-1) ?? null);
}

export interface AtlasRouteProps {
  embedded?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onReport?: (report: AtlasReport) => void;
}

export default function AtlasRoute({
  embedded = false,
  collapsed,
  onToggle,
  onReport,
}: AtlasRouteProps = {}): JSX.Element {
  const screen = (
    <AtlasScreen
      loadGraph={vaultAtlasGraph}
      loadLastBackupAt={lastBackupAt}
      loadPulse={vaultAtlasPulse}
      loadStats={vaultAtlasStats}
      {...(embedded ? { embedded: true as const } : {})}
      {...(collapsed === undefined ? {} : { collapsed })}
      {...(onToggle ? { onToggle } : {})}
      {...(onReport ? { onReport } : {})}
    />
  );
  return embedded ? screen : <PageScroll>{screen}</PageScroll>;
}
