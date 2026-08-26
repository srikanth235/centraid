// Transcript projector (#659): WeakMap ids + reference-stable DTOs. Compare, do not sign.

import type { AsstMsgDTO } from "../../screen-contracts.js";
import { structuralEqual } from "../structuralEqual.js";
import { msgToDTO } from "./assistantTranscript.js";
import type { AsstMsg } from "./assistantTranscript.js";

export interface TranscriptProjection {
  project: (msgs: readonly AsstMsg[], lastAnswerIndex: number) => AsstMsgDTO[];
}

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
