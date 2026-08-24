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

// The Data route (#441 Part B, revamped for v9 in #765). Thin: it hands
// the census/pulse/graph readers to the screen, which owns the five states, the
// block list, and the two frame slots (`routeVitals` count line + status-line
// health). The screen's title and its one verb come from `opsBar.ts`, so
// PageScroll wraps it headless.

/** The most recent backup across every mounted vault, or `null` when backup is
 *  not configured / the read failed. One clause of the status line, and the
 *  page says nothing about backups rather than guessing when it is absent. */
async function lastBackupAt(): Promise<string | null> {
  const status = await getGatewayBackupStatus();
  const stamps = status.vaults
    .map((v) => v.lastBackupAt)
    .filter((at): at is string => typeof at === "string");
  return stamps.length === 0 ? null : (stamps.sort().at(-1) ?? null);
}

export interface AtlasRouteProps {
  /** Drawn as the "What it holds" section of the merged Vault surface. */
  embedded?: boolean;
  /** Embedded only — the section's disclosure and its report upward. */
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
