# Client keying invariants

Which UI/query state is keyed on which durable axis. Issue #504 batch 1.

**Mechanical vs judgment:** judgment-only; casual re-keying of React Query / IndexedDB keys is a review blocker.

## Allowed key axes

| Axis | Owns | Examples |
| --- | --- | --- |
| **Directory / vault path** | On-disk vault identity | Vault open path, desktop gateway id + vault id |
| **Workspace / profile** | Multi-gateway profile selection | Active gateway pointer in settings |
| **Active vault pointer** | Ambient shell context and untargeted requests | Sidebar vault switcher, sidebar identity |
| **Gateway instance** | Live process | `instanceId` from `/centraid/_gateway/info` |
| **Conversation id** | Ledger scope | Conversation list + turn pages |
| **App id + vault** | Which app, over which vault's grants | App session, replica scope |
| **Scope SET** | Which scopes an inline app is mounted over | `InlineAppRoute` mount key (issue #599) |
| **Conversation → vault** | Which vault a conversation addresses, for life | `conversationScopes.ts` (issue #599) |

## Rules

1. **Do not re-key casually.** Changing a cache key shape without migration orphans user state.
2. Directory- or vault-path-backed state must not be keyed only on display name.
3. Gateway-owned live streams key on conversation/turn ids from the wire, not local ephemeral UUIDs invented client-side for the same entity.
4. When unsure, prefer coarser keys (vault + surface) over fine keys that churn every navigation.
5. **A multi-scope mount keys on the whole scope SET, not the focused scope** (issue #599). An inline app can be mounted over several scopes at once — the owner's own and any scopes they control. The mount owns one `window.centraid` built from that exact set, so the set is a real key axis: `appId : attempt : <sorted scope ids>`. Derive it with `scopeSetKey` so ordering never churns the key, and never key such a mount on "the active vault" — that pointer moving is not a reason to re-mount, while a scope joining or leaving the set is.

6. **A conversation is pinned to one vault, and the client records which** (issue #599). The row itself lives in the vault it was created in, so the client must name that vault before it can fetch the row at all: the choice is recorded once at creation (`rememberConversationScope`) and replayed as an explicit `x-centraid-vault` on every later turn, load, status poll and mutation. `undefined` — an older thread, or one started on another device — falls back to the internal default-scope pointer, which is exactly how every conversation behaved before the picker existed. Never re-derive a conversation's vault from "the vault the shell is pointing at now".

7. **The active vault pointer is visible context, not identity** (issues #608, #665). The sidebar vault switcher may update `setActiveVault` (and `setActiveGateway` with it, when the picked vault is hosted by another gateway), and the identity row must render the scope named by that pointer rather than `scopes[0]`. Explicitly targeted operations and pinned conversations do not follow it; only ambient requests and surfaces with no stronger key do.

8. **A replica scope's lifetime is keyed on the page state, not on a clock** ([#922](https://github.com/srikanth235/centraid/issues/922) C6). `replicaScopeDisposition(page, refs)` in `packages/client/src/replica/shell-session.ts` is the whole rule: a scope a screen still holds is never closed under it (`hold`); an unheld scope on a `visible` page keeps a 30-second warm grace (`warm`), so leaving an app and coming back pays no second worker + WASM + OPFS open; an unheld scope on a `hidden` or `frozen` page closes at once (`close`), because the browser freezes a hidden page precisely when it wants its memory back. Do not add a second timer beside this, and do not key a scope's survival on the active-vault pointer — that pointer moving is not a reason to close a handle.

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [glossary.md](glossary.md)
