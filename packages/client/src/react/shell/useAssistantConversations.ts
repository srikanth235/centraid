import { ASSISTANT_APP_ID, listConversations } from "../../gateway-client.js";
import { useCachedQuery } from "./queryCache.js";

export interface AssistantConversationsController {
  conversations: CentraidConversationSummary[];
  /** Re-fetch the list (list endpoint already sorts newest-first). Called
   *  by App.tsx on mount and again whenever AssistantRoute mutates the
   *  vault assistant's conversations (create/first-turn-title/delete/turn
   *  complete) via ShellActions.refreshAssistantThreads. */
  refresh: () => Promise<void>;
  /**
   * Rename / pin / archive, applied to the sidebar row before the wire call
   * (issue #659). Awaiting the PATCH and refetching the whole list would make
   * a rename cost a round trip to appear and a pin rebuild the sidebar. A
   * rejected commit restores the list exactly and rethrows.
   */
  mutate: (
    apply: (
      rows: CentraidConversationSummary[]
    ) => CentraidConversationSummary[],
    commit: () => Promise<unknown>
  ) => Promise<void>;
}

// The shell sidebar's "Chats" list state — the vault assistant's persisted
// conversations (issue: sidebar-as-conversation-list). Held in the shell's
// shared query cache so it survives AssistantRoute unmounting (navigating away
// and back shouldn't re-fetch) and so a vault switch drops it wholesale.
const CONVERSATIONS_KEY = "assistant:conversations";
const NO_CONVERSATIONS: CentraidConversationSummary[] = [];

/** The list fetch, with the "a failed list reads as empty" rule applied once. */
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
