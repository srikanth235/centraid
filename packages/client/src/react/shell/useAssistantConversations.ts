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
export function useAssistantConversations(): AssistantConversationsController {
  const [conversations, setConversations] = useState<CentraidConversationSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      setConversations(await listConversations(ASSISTANT_APP_ID));
    } catch {
      setConversations([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { conversations, refresh };
}
