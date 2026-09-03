import { useCallback, useEffect, useState } from "react";

import { getGatewayHealth } from "../../gateway-client.js";
import type { GatewayHealthDTO } from "../screens/SettingsDiagnosticsScreen.js";
import { startVisibilityTicker } from "./routes/visibility-ticker.js";

const POLL_MS = 15_000;

export function useGatewayHealth(): {
  health: GatewayHealthDTO | null;
  refresh: () => void;
} {
  const [health, setHealth] = useState<GatewayHealthDTO | null>(null);
  const load = useCallback(() => {
    void getGatewayHealth()
      .then((h) => setHealth(h))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const stop = startVisibilityTicker(load, POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      stop();
      window.removeEventListener("focus", load);
    };
  }, [load]);
  return { health, refresh: load };
}
