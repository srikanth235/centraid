import { useCallback, useEffect, useState } from "react";

import type { CentraidChangelogResult } from "../../centraid-api.js";

export type ChangelogState =
  | { status: "loading" }
  | { status: "ready"; result: CentraidChangelogResult }
  | { status: "error"; message: string };

async function loadChangelog(): Promise<ChangelogState> {
  const get = window.CentraidApi.getChangelog;
  if (!get)
    return {
      status: "error",
      message: "Changelog is unavailable in this build.",
    };
  try {
    return { status: "ready", result: await get() };
  } catch (error: unknown) {
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "Failed to load changelog.",
    };
  }
}

const LOADING: ChangelogState = { status: "loading" };

export function useChangelog(): { state: ChangelogState; reload: () => void } {
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
