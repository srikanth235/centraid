import { useEffect, useRef, useState } from "react";

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
  /** Keep settled data visible while a deps-change refetch runs, not a
   *  spinner swap (SSE tick doorbells). Off by default. */
  keepPreviousData?: boolean;
}

export function useAsyncData<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = EMPTY_DEPS,
  options: AsyncDataOptions = {}
): AsyncState<T> {
  // Stamped with fetch-time deps; a change reads as loading during render.
  const [settled, setSettled] = useState<{
    deps: readonly unknown[];
    state: AsyncState<T>;
  } | null>(null);
  const loadRef = useRef(load);
  const depsRef = useRef(deps);
  const depsKey = JSON.stringify(deps);

  // Refreshed every commit; fetching keys on the value signature only.
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
