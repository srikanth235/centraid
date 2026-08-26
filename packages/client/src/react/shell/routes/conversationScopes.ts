import { Store } from "../store.js";

// Conversation→vault mapping is fixed at creation for life (#599); never remap.

const KEY = "assistant.conversationScopes.v1";

type ScopeMap = Record<string, string>;

function read(): ScopeMap {
  return Store.get<ScopeMap>(KEY, {});
}

export function conversationScope(
  conversationId: string | undefined
): string | undefined {
  if (!conversationId) return undefined;
  return read()[conversationId];
}

export function rememberConversationScope(
  conversationId: string,
  scopeId: string
): void {
  Store.set<ScopeMap>(KEY, { ...read(), [conversationId]: scopeId });
}

export function conversationScopes(): ScopeMap {
  return read();
}
