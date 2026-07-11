import { getGatewayHealth } from '../../../gateway-client.js';
import type { GatewayHealthDTO } from '../../screens/SettingsDiagnosticsScreen.js';

// Diagnostics data — the gateway's component-level health snapshot
// (`GET /centraid/_gateway/health`). The wire payload already matches the
// screen's DTO shape field for field; this indirection keeps the screen
// import-free of the HTTP client (prop-driven like every settings page).

export async function loadDiagnosticsData(): Promise<GatewayHealthDTO> {
  return getGatewayHealth();
}
