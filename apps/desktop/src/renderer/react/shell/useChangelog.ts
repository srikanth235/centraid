import { useCallback, useEffect, useState } from 'react';
import type { CentraidChangelogResult } from '../../centraid-api.js';

export type ChangelogState =
  | { status: 'loading' }
  | { status: 'ready'; result: CentraidChangelogResult }
  | { status: 'error'; message: string };

/**
 * Fetch the "What's new" changelog (GitHub release notes, fetched + cached in
 * main). Loads on mount and exposes a `reload` for the modal's retry button.
 * The bridge method is optional (test harnesses mock a partial API) — its
 * absence surfaces as an error state, not a crash.
 */
export function useChangelog(): { state: ChangelogState; reload: () => void } {
  const [state, setState] = useState<ChangelogState>({ status: 'loading' });

  const load = useCallback((alive: () => boolean) => {
    setState({ status: 'loading' });
    const get = window.CentraidApi.getChangelog;
    if (!get) {
      setState({ status: 'error', message: 'Changelog is unavailable in this build.' });
      return;
    }
    get()
      .then((result: CentraidChangelogResult) => {
        if (alive()) setState({ status: 'ready', result });
      })
      .catch((err: unknown) => {
        if (alive())
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load changelog.',
          });
      });
  }, []);

  useEffect(() => {
    let alive = true;
    load(() => alive);
    return () => {
      alive = false;
    };
  }, [load]);

  const reload = useCallback(() => load(() => true), [load]);
  return { state, reload };
}
