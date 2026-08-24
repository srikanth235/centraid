import { Store } from "../store.js";

// Which vault each conversation belongs to (#599, Decision 14).
//
// A conversation reads and writes exactly ONE vault for its whole life: the
// assistant answers from a single set of shapes, and a thread that silently
// changed which household member's data it could see would be a privacy bug,
// not a convenience. The choice is made once, when the conversation is created,
// and repeated on every later turn and transcript load as an explicit
// `x-centraid-vault` header.
//
// The mapping is CLIENT-SIDE. The conversation row itself already lives in the
// vault it was created in, so the gateway needs no second copy of this fact —
// but the client has to remember which vault to address before it can fetch the
// row at all. A device that has never seen a conversation simply has no entry
// and falls back to the internal default scope, which is exactly how every
// conversation created before this issue behaves.

const KEY = "assistant.conversationScopes.v1";

type ScopeMap = Record<string, string>;

function read(): ScopeMap {
  return Store.get<ScopeMap>(KEY, {});
}

/** The vault a conversation was created in, or `undefined` if this device
 *  never recorded one (an older thread, or one started elsewhere). */
export function conversationScope(
  conversationId: string | undefined
): string | undefined {
  if (!conversationId) return undefined;
  return read()[conversationId];
}

/** Record a fresh conversation's vault. Called once, at creation. */
export function rememberConversationScope(
  conversationId: string,
  scopeId: string
): void {
  Store.set<ScopeMap>(KEY, { ...read(), [conversationId]: scopeId });
}

/** The whole map — the sidebar reads it to label rows that live somewhere
 *  other than the member's own vault. */
export function conversationScopes(): ScopeMap {
  return read();
}
