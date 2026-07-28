import { useCallback, useEffect, useState } from "react";

import type { CentraidChangelogResult } from "../../centraid-api.js";

export type ChangelogState =
  | { status: "loading" }
  | { status: "ready"; result: CentraidChangelogResult }
  | { status: "error"; message: string };

/**
 * Fetch the "What's new" changelog (GitHub release notes, fetched + cached in
 * main). Loads on mount and exposes a `reload` for the modal's retry button.
 * The bridge method is optional (test harnesses mock a partial API) — its
 * absence surfaces as an error state, not a crash.
 */
/** One fetch attempt, resolved to the settled state it should produce (a
 *  missing bridge method resolves to the error state rather than throwing). */
async function loadChangelog(): Promise<ChangelogState> {
  const get = window.CentraidApi.getChangelog;
  if (!get)
    return {
      status: "error",
      message: "Changelog is unavailable in this build.",
    };
  try {
    return { status: "ready", result: await get() };
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to load changelog.",
    };
  }
}

const LOADING: ChangelogState = { status: "loading" };

export function useChangelog(): { state: ChangelogState; reload: () => void } {
  // `attempt` is the retry counter; the settled state is stamped with the
  // attempt that produced it, so a reload reads as `loading` during render
  // rather than through a synchronous setState in the effect body.
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    attempt: number;
    state: ChangelogState;
  } | null>(null);
  const state =
    settled !== null && settled.attempt === attempt ? settled.state : LOADING;

  useEffect(() => {
    let alive = true;
    void loadChangelog().then((next) => {
      if (alive) setSettled({ attempt, state: next });
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
