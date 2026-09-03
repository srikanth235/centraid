import type { RecordedTurnReplay } from "../conversation/history.js";
import type { TurnStreamEvent } from "../conversation/runner.js";

export function buildReplayEvents(
  recorded: RecordedTurnReplay
): TurnStreamEvent[] {
  if (!recorded.ok) {
    return [{ type: "error", message: recorded.error ?? "This turn failed." }];
  }
  const text = recorded.finalText ?? "";
  const events: TurnStreamEvent[] = [{ type: "assistant.start" }];
  if (text.length > 0) events.push({ type: "assistant.delta", delta: text });
  if (recorded.usage) {
    events.push({
      type: "usage",
      ...(recorded.usage.model === undefined
        ? {}
        : { model: recorded.usage.model }),
      ...(recorded.usage.effort === undefined
        ? {}
        : { effort: recorded.usage.effort }),
      ...(recorded.usage.inputTokens === undefined
        ? {}
        : { inputTokens: recorded.usage.inputTokens }),
      ...(recorded.usage.outputTokens === undefined
        ? {}
        : { outputTokens: recorded.usage.outputTokens }),
    });
  }
  events.push({ type: "final", text });
  return events;
}
