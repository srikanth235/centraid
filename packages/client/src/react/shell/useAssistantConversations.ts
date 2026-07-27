import { useCallback, useEffect, useState } from 'react';
import { ASSISTANT_APP_ID, listConversations } from '../../gateway-client.js';

export interface AssistantConversationsController {
  conversations: CentraidConversationSummary[];
  /** Re-fetch the list (list endpoint already sorts newest-first). Called
   *  by App.tsx on mount and again whenever AssistantRoute mutates the
   *  vault assistant's conversations (create/first-turn-title/delete/turn
   *  complete) via ShellActions.refreshAssistantThreads. */
  refresh: () => Promise<void>;
}

// The shell sidebar's "Chats" list state — the vault assistant's persisted
// conversations (issue: sidebar-as-conversation-list). Owned by App.tsx so
// it survives AssistantRoute unmounting (navigating away and back shouldn't
// re-fetch), mirroring useShellApps' ownership of the Apps list.
/** The list fetch, with the "a failed list reads as empty" rule applied once
 *  for both entry points (the mount effect and the imperative `refresh`). */
async function loadAssistantConversations(): Promise<CentraidConversationSummary[]> {
  try {
    return await listConversations(ASSISTANT_APP_ID);
  } catch {
    return [];
  }
}

export function useAssistantConversations(): AssistantConversationsController {
  const [conversations, setConversations] = useState<CentraidConversationSummary[]>([]);

  const refresh = useCallback(async () => {
    setConversations(await loadAssistantConversations());
  }, []);

  useEffect(() => {
    let alive = true;
    void loadAssistantConversations().then((next) => {
      if (alive) setConversations(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { conversations, refresh };
}
