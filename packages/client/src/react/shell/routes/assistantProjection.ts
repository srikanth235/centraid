// Transcript model → screen DTOs, with identity (issue #659).
//
// `AssistantRoute` keeps its message model in a ref and MUTATES it in place as
// a turn streams — text is appended, tool rows are spliced in ahead of the
// answer bubble they belong to, a regenerate truncates the tail. That makes
// both of the obvious shortcuts wrong: an array index is not an identity (a
// splice renumbers everything after it, remounting rows that do imperative DOM
// work on mount), and object identity is not a version (the object changes
// without being replaced).
//
// So the projector owns two things the codec cannot:
//
//  1. A per-message id, assigned on first sight and held in a WeakMap, so a row
//     keeps its React key for its whole life no matter what is inserted above
//     it. The map is weak, so ids die with the messages.
//  2. Reference stability. Every push re-derives the DTOs; where the derived
//     value is EQUAL to the previous one, the previous object is handed back
//     instead. `React.memo` on the row then has something to compare, and the
//     whole array is returned unchanged when nothing moved at all.
//
// Equality is compared, not signed: a hand-written signature that forgets a
// field renders stale forever. The compare stays cheap because the expensive
// field — the rendered answer HTML — is itself memoized upstream and so
// compares by reference in one step.

import type { AsstMsgDTO } from "../../screen-contracts.js";
import { structuralEqual } from "../structuralEqual.js";
import { msgToDTO } from "./assistantTranscript.js";
import type { AsstMsg } from "./assistantTranscript.js";

export interface TranscriptProjection {
  /**
   * Project the live model into screen DTOs. `lastAnswerIndex` is the message
   * that may offer Regenerate (`-1` for none), exactly as `msgToDTO` expects.
   */
  project: (msgs: readonly AsstMsg[], lastAnswerIndex: number) => AsstMsgDTO[];
}

/**
 * The same reference-stability rule for projections that ALREADY carry
 * identity: the automation live trace derives `msgId` from the ledger item id,
 * so rows can be matched by key instead of by source object. Rebuilt rows that
 * are equal to their predecessor are replaced by it, and an array in which
 * every row was reused is returned as the same array.
 *
 * Without this, `automationLiveMessages` handed a brand-new object graph to
 * `Message` on every streamed event and the memoized row could never hit.
 */
export function createKeyedMessageProjection(): (
  messages: AsstMsgDTO[]
) => AsstMsgDTO[] {
  let byId = new Map<string, AsstMsgDTO>();
  let lastResult: AsstMsgDTO[] = [];
  return (messages) => {
    const next = new Map<string, AsstMsgDTO>();
    const stabilized = messages.map((message, index) => {
      const id = message.msgId ?? `${message.kind}:${index}`;
      const prior = byId.get(id);
      const kept = prior && structuralEqual(prior, message) ? prior : message;
      next.set(id, kept);
      return kept;
    });
    byId = next;
    const unchanged =
      stabilized.length === lastResult.length &&
      stabilized.every((dto, index) => dto === lastResult[index]);
    if (unchanged) return lastResult;
    lastResult = stabilized;
    return stabilized;
  };
}

export function createTranscriptProjection(): TranscriptProjection {
  const ids = new WeakMap<AsstMsg, string>();
  const previous = new WeakMap<AsstMsg, AsstMsgDTO>();
  let nextId = 0;
  let lastResult: AsstMsgDTO[] = [];

  const idFor = (msg: AsstMsg): string => {
    const existing = ids.get(msg);
    if (existing !== undefined) return existing;
    const assigned = `m${nextId++}`;
    ids.set(msg, assigned);
    return assigned;
  };

  return {
    project: (msgs, lastAnswerIndex) => {
      const next = msgs.map((msg, index) => {
        const derived: AsstMsgDTO = {
          ...msgToDTO(msg, index === lastAnswerIndex),
          msgId: idFor(msg),
        };
        const prior = previous.get(msg);
        if (prior && structuralEqual(prior, derived)) return prior;
        previous.set(msg, derived);
        return derived;
      });
      const unchanged =
        next.length === lastResult.length &&
        next.every((dto, index) => dto === lastResult[index]);
      if (unchanged) return lastResult;
      lastResult = next;
      return next;
    },
  };
}
