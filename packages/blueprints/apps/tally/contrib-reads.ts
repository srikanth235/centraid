import { useEffect, useMemo, useState } from "react";

import { contribSections } from "./contrib-model.ts";
import type { ContribSections, Intent } from "./contrib-model.ts";
import type { Person } from "./types.ts";

export interface ContribReads {
  sections: ContribSections;
  hasApprovals: boolean;
  canDecide: boolean;
}

export function useContribReads(args: {
  me: string | null;
  meName: string;
  friends: readonly Person[];
  matchedAt: string | null;
}): ContribReads {
  const [intents, setIntents] = useState<Intent[]>([]);
  const { me, meName, friends, matchedAt } = args;

  useEffect(() => {
    let live = true;
    void (async () => {
      let rows: Intent[] = [];
      try {
        rows = ((await window.centraid.commonsIntents?.()) ??
          []) as unknown as Intent[];
      } catch {
        rows = [];
      }
      if (live) setIntents(rows);
    })();
    return () => {
      live = false;
    };
  }, [matchedAt]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    if (me) map.set(me, meName);
    for (const person of friends) map.set(person.party_id, person.name);
    return map;
  }, [me, meName, friends]);

  const client = window.centraid;
  const hasApprovals = typeof client.openApprovals === "function";
  const canDecide = typeof client.decideCommonsIntent === "function";

  const sections = useMemo(
    () =>
      contribSections({
        intents,
        me,
        names,
        doors: {
          cancel: typeof client.cancelCommonsIntent === "function",
          retry: typeof client.retryPendingWrite === "function",
          discard: typeof client.discardPendingWrite === "function",
          approvals: typeof client.openApprovals === "function",
          decide: typeof client.decideCommonsIntent === "function",
        },
      }),
    [client, intents, me, names]
  );

  return { sections, hasApprovals, canDecide };
}
