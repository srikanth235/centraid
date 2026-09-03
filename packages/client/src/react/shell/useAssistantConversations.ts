import { ASSISTANT_APP_ID, listConversations } from "../../gateway-client.js";
import { useCachedQuery } from "./queryCache.js";

export interface AssistantConversationsController {
  conversations: CentraidConversationSummary[];
  refresh: () => Promise<void>;
  mutate: (
    apply: (
      rows: CentraidConversationSummary[]
    ) => CentraidConversationSummary[],
    commit: () => Promise<unknown>
  ) => Promise<void>;
}

const CONVERSATIONS_KEY = "assistant:conversations";
const NO_CONVERSATIONS: CentraidConversationSummary[] = [];

async function loadAssistantConversations(): Promise<
  CentraidConversationSummary[]
> {
  try {
    return await listConversations(ASSISTANT_APP_ID);
  } catch {
    return [];
  }
}

export function useAssistantConversations(): AssistantConversationsController {
  const { state, refresh, mutate } = useCachedQuery(
    CONVERSATIONS_KEY,
    loadAssistantConversations
  );
  return {
    conversations: state.status === "ready" ? state.data : NO_CONVERSATIONS,
    refresh,
    mutate,
  };
}
