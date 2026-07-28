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

const LOADING: AsyncState<never> = { status: 'loading' };

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

export function useAsyncData<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  // The settled result is stamped with the deps it was fetched for; a deps
  // change therefore reads as `loading` during render, without an effect having
  // to push a synchronous `setState({status:'loading'})` first.
  const [settled, setSettled] = useState<{
    deps: readonly unknown[];
    state: AsyncState<T>;
  } | null>(null);
  // `deps` is a caller-provided array by contract — re-fetch when it changes.
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setSettled({ deps, state: { status: 'ready', data } });
      })
      .catch((err: unknown) => {
        if (alive) {
          setSettled({
            deps,
            state: {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });
    return () => {
      alive = false;
    };
  }, deps);
  return settled !== null && sameDeps(settled.deps, deps) ? settled.state : LOADING;
}
