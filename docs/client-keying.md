# Client keying invariants

Which UI/query state is keyed on which durable axis. Issue #504 batch 1.

**Mechanical vs judgment:** judgment-only; casual re-keying of React Query / IndexedDB keys is a review blocker.

## Allowed key axes

| Axis | Owns | Examples |
| --- | --- | --- |
| **Directory / vault path** | On-disk vault identity | Vault open path, desktop gateway id + vault id |
| **Workspace / profile** | Multi-gateway profile selection | Active gateway pointer in settings |
| **Gateway instance** | Live process | `instanceId` from `/centraid/_gateway/info` |
| **Conversation id** | Ledger scope | Conversation list + turn pages |
| **App id + vault** | Generated app / grants | App session, replica scope |

## Rules

1. **Do not re-key casually.** Changing a cache key shape without migration orphans user state.
2. Directory- or vault-path-backed state must not be keyed only on display name.
3. Gateway-owned live streams key on conversation/turn ids from the wire, not local ephemeral UUIDs invented client-side for the same entity.
4. When unsure, prefer coarser keys (vault + surface) over fine keys that churn every navigation.

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [glossary.md](glossary.md)
