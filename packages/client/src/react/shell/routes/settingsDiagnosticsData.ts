import { getGatewayHealth } from "../../../gateway-client.js";
import type { GatewayHealthDTO } from "../../screens/SettingsDiagnosticsScreen.js";
import { openGatewayRegistry } from "../gatewayRegistry.js";
import type { GatewayRow } from "../gatewayRegistry.js";

// Diagnostics data — the gateway's component-level health snapshot
// (`GET /centraid/_gateway/health`). The wire payload already matches the
// screen's DTO shape field for field; this indirection keeps the screen
// import-free of the HTTP client (prop-driven like every settings page).
// Consumed by the Gateway page's Components tab and by useGatewayHealth's
// poll — no longer Settings-only despite the filename.

export async function loadDiagnosticsData(): Promise<GatewayHealthDTO> {
  return getGatewayHealth();
}

/**
 * The Connections section's rows (issue #665) — every host this device is
 * registered against, with its transport, reachability, and vault list.
 *
 * Same registry the sidebar switcher reads, so one probe cache serves the
 * renderer session: opening Diagnostics right after the switcher paints from
 * what the switcher already learned. Resolves with the rows to paint now and
 * calls `onUpdate` again as each per-host probe settles.
 */
export async function loadConnectionRows(
  onUpdate: (rows: GatewayRow[]) => void
): Promise<GatewayRow[]> {
  const settings = await window.CentraidApi.getSettings?.().catch(
    () => undefined
  );
  return openGatewayRegistry(settings?.activeGatewayId ?? "", onUpdate);
}
