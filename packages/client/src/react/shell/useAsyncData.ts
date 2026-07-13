import { useEffect, useState } from 'react';

// The leaf-route data pattern, ported from the vanilla render fns: each screen
// fetches its data over IPC, shows a loading line, then the screen (or an error
// line). React-owned equivalent of `renderInsights`/`renderDiscover`/… — the
// effect runs the fetch, tracks mount so a navigation mid-flight is dropped
// (the vanilla `if (!document.contains(host)) return` guard).

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T };

export function useAsyncData<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  // `deps` is a caller-provided array by contract — re-fetch when it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- (#325) `load` itself is intentionally excluded, see contract above
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    load()
      .then((data) => {
        if (alive) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (alive) {
          setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#325) `load` itself is intentionally excluded, see contract above
  }, deps);
  return state;
}
