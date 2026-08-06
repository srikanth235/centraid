// The share-target pointer, RESOLVED (issue #712, A3/A5).
//
// `share-target.ts` owns the record and the two refusal sentences. This hook
// owns the question every sharing control actually asks: *can this device
// share right now, and if not, which of the three honest answers is it?*
//
//   1. THERE IS SOMEWHERE — the pointer names a vault this device has mounted.
//      The control fires.
//   2. THE POINTER IS UNSET, BUT THERE ARE CANDIDATES. This is NOT a refusal.
//      It is the first-share moment (A3): the control stays live and opens a
//      picker at the point of intent, which then writes the pointer and
//      proceeds. A disabled control pointing the member at Settings would be
//      making them go and configure something to do a thing they just asked
//      for.
//   3. THERE IS GENUINELY NOWHERE — no writable non-personal vault is mounted,
//      or the chosen one is not open here. Then, and only then, the control is
//      disabled and carries the sentence, verbatim from `share-target.ts` so
//      the phone and the web cannot drift on what the refusal says.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useReplica } from "../replica/ReplicaProvider";
import {
  hydrateShareTarget,
  shareDestinationReason,
  writeShareTarget,
} from "./share-target";

export interface ShareTargetCandidate {
  vaultId: string;
  label: string;
}

export interface ShareTargetState {
  /** False until the durable pointer has been read; nothing is refused yet. */
  hydrated: boolean;
  /** The chosen vault, when it resolves to one this device has mounted. */
  target?: ShareTargetCandidate;
  /**
   * Writable, non-personal, mounted vaults — the same audience
   * `AudiencePlacementSheet` offers per item and `ShareTargetSection` offers as
   * a default. `personal === false` is the durable founding marker (#711 H); a
   * scope an older gateway left unmarked reads as the member's own and is
   * excluded, because sharing into your own vault is not sharing.
   */
  candidates: ShareTargetCandidate[];
  /**
   * Non-null when there is nowhere to share to AT ALL. Deliberately null while
   * the pointer is merely unset but candidates exist — that is the picker's
   * moment, not a refusal.
   */
  reason: string | null;
  /** Persist a choice and adopt it immediately. */
  choose: (vaultId: string) => void;
}

export function useShareTarget(): ShareTargetState {
  const { scopes } = useReplica();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void hydrateShareTarget().then((record) => {
      setTargetId(record.vaultId);
      setHydrated(true);
    });
  }, []);

  const candidates = useMemo<ShareTargetCandidate[]>(
    () =>
      (scopes ?? [])
        .filter((scope) => scope.personal === false && scope.role !== "read")
        .map((scope) => ({ vaultId: scope.vaultId, label: scope.label })),
    [scopes]
  );

  const choose = useCallback((vaultId: string): void => {
    setTargetId(vaultId);
    writeShareTarget({ vaultId });
  }, []);

  const target = candidates.find((candidate) => candidate.vaultId === targetId);
  // `null` pointer → `undefined` here: "never chosen" is the argument
  // `shareDestinationReason` distinguishes, and it is the branch the picker
  // answers rather than the branch that refuses.
  const stated = shareDestinationReason(scopes ?? [], targetId ?? undefined);
  const reason =
    !hydrated || target
      ? null
      : targetId === null && candidates.length > 0
        ? null
        : stated;

  return {
    hydrated,
    ...(target ? { target } : {}),
    candidates,
    reason,
    choose,
  };
}
