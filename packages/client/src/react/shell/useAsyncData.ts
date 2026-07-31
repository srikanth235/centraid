import { useEffect, useRef, useState } from "react";

// The leaf-route data pattern, ported from the vanilla render fns: each screen
// fetches its data over IPC, shows a loading line, then the screen (or an error
// line). React-owned equivalent of `renderInsights`/`renderDiscover`/… — the
// effect runs the fetch, tracks mount so a navigation mid-flight is dropped
// (the vanilla `if (!document.contains(host)) return` guard).

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

const LOADING: AsyncState<never> = { status: "loading" };
const EMPTY_DEPS: readonly unknown[] = [];

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

export interface AsyncDataOptions {
  /**
   * Keep the last settled data on screen while a deps change refetches,
   * instead of reporting `loading`. Routes whose deps double as a refresh
   * doorbell (Inbox: SSE bumps a tick) need this — reporting `loading` swaps
   * the whole screen for a spinner, UNMOUNTING it and discarding whatever the
   * owner was in the middle of. Off by default: a route whose deps change
   * means "show something else" still wants its loading line.
   */
  keepPreviousData?: boolean;
}

export function useAsyncData<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = EMPTY_DEPS,
  options: AsyncDataOptions = {}
): AsyncState<T> {
  // The settled result is stamped with the deps it was fetched for; a deps
  // change therefore reads as `loading` during render, without an effect having
  // to push a synchronous `setState({status:'loading'})` first.
  const [settled, setSettled] = useState<{
    deps: readonly unknown[];
    state: AsyncState<T>;
  } | null>(null);
  const loadRef = useRef(load);
  const depsRef = useRef(deps);
  const depsKey = JSON.stringify(deps);

  // Refresh the values after every commit. The fetching effect only depends on
  // the stable, value-based dependency signature, so inline loader callbacks
  // do not refetch merely because rendering allocated a new function.
  useEffect(() => {
    loadRef.current = load;
    depsRef.current = deps;
  });

  useEffect(() => {
    const requestedDeps = depsRef.current;
    let alive = true;
    loadRef
      .current()
      .then((data) => {
        if (alive)
          setSettled({ deps: requestedDeps, state: { status: "ready", data } });
      })
      .catch((error: unknown) => {
        if (alive) {
          setSettled({
            deps: requestedDeps,
            state: {
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [depsKey]);

  if (settled === null) return LOADING;
  if (sameDeps(settled.deps, deps)) return settled.state;
  return options.keepPreviousData && settled.state.status === "ready"
    ? settled.state
    : LOADING;
}
