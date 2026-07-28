import { useCallback, useEffect, useState } from 'react';

import { listAutomations, setAutomationEnabled, type AutomationRow } from '../../lib/automations';
import { GatewayError, resolveGatewayBase } from '../../lib/gateway';

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

// The loader lives outside the hook: it closes over nothing but the (stable)
// state setter, so it needs no `useCallback` identity dance, it is testable on
// its own, and the mount effect below is plainly an async kick-off rather than
// something that could set state during the effect body.
async function loadAutomations(setState: (next: AutomationsState) => void): Promise<void> {
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
}

export function useAutomations(): UseAutomations {
  const [state, setState] = useState<AutomationsState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadAutomations(setState);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadAutomations(setState);
    setRefreshing(false);
  }, []);

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
