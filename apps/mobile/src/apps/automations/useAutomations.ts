import { useCallback, useEffect, useState } from 'react';

import { GatewayError, resolveGatewayBase } from '../../lib/gateway';
import { listAutomations, setAutomationEnabled, type AutomationRow } from '../../lib/automations';

// The screen's load lifecycle, modeled explicitly (no try/catch soup): a
// no-gateway degrade is a first-class calm state, distinct from a transport
// error. `ready` carries the rows the FlatList renders; `toggle` flips a row's
// enabled flag optimistically and reverts on failure so a rejected write never
// leaves the pill lying about the automation's real state.
export type AutomationsState =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'ready'; rows: AutomationRow[] }
  | { kind: 'error'; message: string };

export interface UseAutomations {
  state: AutomationsState;
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** Optimistically flip `enabled`; reverts and rethrows if the gateway rejects. */
  toggle: (ref: string, next: boolean) => Promise<void>;
}

export function useAutomations(): UseAutomations {
  const [state, setState] = useState<AutomationsState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const base = await resolveGatewayBase();
      if (!base) {
        setState({ kind: 'no-gateway' });
        return;
      }
      const rows = await listAutomations();
      setState({ kind: 'ready', rows });
    } catch (err) {
      const message =
        err instanceof GatewayError || err instanceof Error
          ? err.message
          : 'Could not load automations.';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const toggle = useCallback(async (ref: string, next: boolean): Promise<void> => {
    const flip = (value: boolean): void =>
      setState((prev) =>
        prev.kind === 'ready'
          ? {
              kind: 'ready',
              rows: prev.rows.map((row) => (row.ref === ref ? { ...row, enabled: value } : row)),
            }
          : prev,
      );
    flip(next);
    try {
      await setAutomationEnabled(ref, next);
    } catch (err) {
      // Revert the optimistic flip, then rethrow so the card can surface the
      // failure — the row's pill must reflect the automation's true state.
      flip(!next);
      throw err;
    }
  }, []);

  return { state, refreshing, refresh, toggle };
}
