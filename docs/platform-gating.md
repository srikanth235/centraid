# Platform gating

Decision matrix for UI/runtime branches across desktop (Electron), web PWA, and mobile (Expo). Issue #504 batch 1.

**Mechanical vs judgment:** judgment-only today (no lint). Prefer **platform file splits** for large divergences instead of long `if (isWeb)` ladders.

## Signals

| Signal | Meaning | Typical source |
| --- | --- | --- |
| `isWeb` | Browser / PWA shell | `typeof window` + no Electron bridge |
| `isNative` | Expo / React Native | `Platform.OS` / Expo constants |
| Electron bridge | Desktop main capabilities | `window.centraid` / preload IPC |
| Compact form-factor | Narrow layout, not a trust boundary | CSS / shell layout, not auth |

## Prefer

| Divergence size | Pattern |
| --- | --- |
| One-liner presentation | `isWeb ? a : b` next to the call site |
| Screen-sized | `Foo.web.tsx` / `Foo.native.tsx` / desktop-only module |
| Capability missing | Capability wall from handshake (C1) — not a silent no-op |

## Do not

- Treat compact layout as a security boundary.
- Re-implement gateway auth differently per platform; all clients use the same wire + token/session model.
- Branch business logic on user-agent strings.

## Related

- [protocol.md](protocol.md) — C1 capability detection
- [ARCHITECTURE.md](../ARCHITECTURE.md) — client layout
