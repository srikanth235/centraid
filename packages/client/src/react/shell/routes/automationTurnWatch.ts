import {
  readAutomationTurnExpanded,
  streamAutomationTurn,
} from "../../../gateway-client.js";
import type { AutomationTurnStreamEvent } from "../../../gateway-client.js";
import type { TurnStreamEvent } from "../../../turn-stream.js";
import type { AsstMsgDTO, TurnWatchOutcome } from "../../screen-contracts.js";
import {
  automationLiveMessages,
  createAutomationLiveTraceFromItems,
  finishAutomationLiveItem,
  finishAutomationLiveTrace,
  reduceAutomationItemEvent,
  startAutomationLiveItem,
} from "./automationLiveMessages.js";
import {
  automationTurnInboundText,
  automationTurnMessages,
} from "./automationTurnMessages.js";

export async function loadTurnTrace(turnId: string): Promise<AsstMsgDTO[]> {
  const expanded = await readAutomationTurnExpanded({ turnId });
  return expanded.turn
    ? automationTurnMessages(expanded.turn, expanded.items)
    : [];
}

export async function watchTurnMessages(
  turnId: string,
  onMessages: (messages: AsstMsgDTO[]) => void,
  signal: AbortSignal
): Promise<TurnWatchOutcome> {
  const initial = await readAutomationTurnExpanded({ turnId }).catch(() => ({
    turn: null,
    items: [] as CentraidAutomationItem[],
  }));
  if (initial.turn)
    onMessages(automationTurnMessages(initial.turn, initial.items));
  const inbound = automationTurnInboundText(initial.turn, initial.items);
  let live = createAutomationLiveTraceFromItems(inbound, initial.items);
  let ended = false;
  let terminalOk: boolean | undefined;
  const apply = (event: AutomationTurnStreamEvent): void => {
    if (event.type === "item.start") {
      live = startAutomationLiveItem(live, {
        itemId: event.itemId,
        ordinal: event.ordinal,
        kind: event.kind,
        ...(event.name ? { name: event.name } : {}),
        ...(event.callId ? { callId: event.callId } : {}),
      });
      onMessages(automationLiveMessages(live));
    } else if (event.type === "item.delta") {
      live = reduceAutomationItemEvent(live, {
        itemId: event.itemId,
        ordinal: event.ordinal,
        event: event.event as TurnStreamEvent,
      });
      onMessages(automationLiveMessages(live));
    } else if (event.type === "item.end") {
      live = finishAutomationLiveItem(live, event);
      onMessages(automationLiveMessages(live));
    } else if (event.type === "turn.end") {
      ended = true;
      terminalOk = event.ok;
      live = finishAutomationLiveTrace(
        live,
        event.ok ? undefined : event.error
      );
    }
  };
  await streamAutomationTurn(turnId, apply, signal);
  if (signal.aborted) return { settled: false, ok: false };
  const final = await readAutomationTurnExpanded({ turnId });
  if (final.turn) {
    onMessages(automationTurnMessages(final.turn, final.items));
    return { settled: final.turn.endedAt !== undefined, ok: final.turn.ok };
  }
  if (ended) onMessages(automationLiveMessages(live));
  return { settled: ended, ok: terminalOk ?? false };
}
