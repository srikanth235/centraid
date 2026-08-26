// WAITING'S OWN READ: the durable intent overlay, whole.
//
// `ledger-reads.ts` already asks the same door a narrower question — how many
// of this member's writes are queued, and is one parked — because that is all
// a notice needs. Waiting needs each intent's actor, command, status and
// reason, which is a different question, so it is asked separately rather than
// by widening the spine's read and making every route carry it.
//
// WHICH DOORS EXIST IS DATA, not an assumption. `window.centraid` is the
// SHELL'S client and the hosts differ: the served harness has no approval
// inbox, an older host has no `cancelCommonsIntent`. A verb whose door is
// absent is not drawn at all, so the roster is read here and handed to
// `contrib-model.ts` as input.
import { useEffect, useMemo, useState } from "react";

import { contribSections } from "./contrib-model.ts";
import type { ContribSections, Intent } from "./contrib-model.ts";
import type { Person } from "./types.ts";

export interface ContribReads {
  sections: ContribSections;
  /** Does this host hold an approval inbox at all? */
  hasApprovals: boolean;
}

export function useContribReads(args: {
  me: string | null;
  /** The owner's own name, as every other row spells it. */
  meName: string;
  friends: readonly Person[];
  /** When the room last matched the vault — the moment to re-ask. */
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
        // A HOST THAT HOLDS NO OVERLAY simply has nothing to declare; an empty
        // list is the truth for it, not a swallowed failure.
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
        },
      }),
    [client, intents, me, names]
  );

  return { sections, hasApprovals };
}
