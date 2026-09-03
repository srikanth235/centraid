import { getGatewayHealth } from "../../../gateway-client.js";
import type { GatewayHealthDTO } from "../../screens/SettingsDiagnosticsScreen.js";
import { openGatewayRegistry } from "../gatewayRegistry.js";
import type { GatewayRow } from "../gatewayRegistry.js";

export async function loadDiagnosticsData(): Promise<GatewayHealthDTO> {
  return getGatewayHealth();
}

export async function loadConnectionRows(
  onUpdate: (rows: GatewayRow[]) => void
): Promise<GatewayRow[]> {
  const settings = await window.CentraidApi.getSettings?.().catch(
    () => undefined
  );
  return openGatewayRegistry(settings?.activeGatewayId ?? "", onUpdate);
}
