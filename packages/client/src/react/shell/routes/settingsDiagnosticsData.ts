import { getGatewayHealth } from '../../../gateway-client.js';
import type { GatewayHealthDTO } from '../../screens/SettingsDiagnosticsScreen.js';

// Diagnostics data — the gateway's component-level health snapshot
// (`GET /centraid/_gateway/health`). The wire payload already matches the
// screen's DTO shape field for field; this indirection keeps the screen
// import-free of the HTTP client (prop-driven like every settings page).
// Consumed by the Gateway page's Components tab and by useGatewayHealth's
// poll — no longer Settings-only despite the filename.

export async function loadDiagnosticsData(): Promise<GatewayHealthDTO> {
  return getGatewayHealth();
}
