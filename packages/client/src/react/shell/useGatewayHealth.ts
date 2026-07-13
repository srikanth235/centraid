import { useCallback, useEffect, useState } from 'react';
import { getGatewayHealth } from '../../gateway-client.js';
import type { GatewayHealthDTO } from '../screens/SettingsDiagnosticsScreen.js';

const POLL_MS = 15_000;

/**
 * Component-level gateway health (`GET /centraid/_gateway/health`), polled —
 * no push channel exists for it (unlike the heartbeat monitor). Feeds the
 * Gateway page's reconciled status (Overview orb + Components tab badge);
 * the Components tab itself owns a second, independent load through
 * `SettingsDiagnosticsScreen`'s own `loadHealth` prop, which is fine — this
 * hook only needs the cheap summary, not to be the one true fetch.
 */
export function useGatewayHealth(): { health: GatewayHealthDTO | null; refresh: () => void } {
  const [health, setHealth] = useState<GatewayHealthDTO | null>(null);
  const load = useCallback(() => {
    void getGatewayHealth()
      .then((h) => setHealth(h))
      .catch(() => {
        // Gateway unreachable — the heartbeat monitor already reflects that
        // for the orb; keep the last known component snapshot rather than
        // flapping the Components badge.
      });
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);
  return { health, refresh: load };
}
