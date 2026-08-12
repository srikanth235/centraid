# Platform gating

Decision matrix for UI/runtime branches across desktop (Electron), web PWA, and mobile (Expo). Issue #504 batch 1.

**Mechanical vs judgment:** judgment-only today (no lint). Prefer **platform file splits** for large divergences instead of long `if (isWeb)` ladders.

## Signals

| Signal | Meaning | Typical source |
| --- | --- | --- |
| `isWeb` | Browser / PWA shell | `typeof window` + no Electron bridge |
| `isWebHost()` | The **synchronous first-paint** answer to "which shell hosts this bundle", for branches that run before any bridge round trip — first run's ticket-only-vs-chooser split (#603). `packages/client/src/react/host-platform.ts`; the marker is `window.CentraidIroh`, which the web host installs and the Electron preload never does. Presentation only — never branch auth or security on it |
| `isNative` | Expo / React Native | `Platform.OS` / Expo constants |
| Electron bridge | Desktop main capabilities | `window.centraid` / preload IPC |
| Compact form-factor | Narrow layout, not a trust boundary | CSS / shell layout, not auth |
| `SEAT` | The bundle's byte-custody role — `origin` (mobile) / `custodian` (desktop) / `viewer` (web/PWA). Orthogonal to compact: a PWA on a phone is compact **and** a viewer; a narrow desktop window is compact **and** the custodian. Never sniffed at runtime — a declared build-time constant. See [blueprint-seats.md](blueprint-seats.md) | `apps/mobile/src/lib/seat.ts` (`SEAT = "origin"`); `packages/client/src/react/host-platform.ts` (`seat()`, resolved from the `isWebHost()` first-paint marker since one bundle serves both custodian and viewer) |

## Prefer

| Divergence size | Pattern |
| --- | --- |
| One-liner presentation | `isWeb ? a : b` next to the call site |
| Screen-sized | `Foo.web.tsx` / `Foo.native.tsx` / desktop-only module |
| Capability missing | Capability wall from handshake (C1) — not a silent no-op |

## One surface word

The system has **one** surface axis — **pointer or touch** — and width is a canvas, not a surface. A narrower stage carries no rules of its own: same margin, same row height, same columns, same controls, only less of them visible. If a surface enum is ever introduced, it is `'desktop' | 'compact' | 'touch'` with **no synonyms** — never a second word like `pwa` for the middle one. Two names for one state is not a naming preference; it is a defect waiting to happen, because the two names get _tested_ differently (`surface === 'compact'` in one place, `surface !== 'desktop'` in another) and then disagree about the same state value.

Resolve the axis **once per render** into a token set and read the object everywhere, rather than re-deciding it at each call site. The measured cost of the alternative is 122 hand-written `touch ? a : b` ternaries: a change to the phone margin becomes 122 places to look, and several controls silently sat at 34px — under the 44px touch floor.

The floor is not advisory. `--target-min` starts at `metrics.controlTouch` (44px) and only a `(pointer: fine)` query lowers it to `metrics.control` (34px), so a surface that has not proven it has a pointer keeps 44.

## Do not

- Treat compact layout as a security boundary.
- Introduce a second word for one surface, or a third surface for a width.
- Re-implement gateway auth differently per platform; all clients use the same wire + token/session model.
- Branch business logic on user-agent strings.

## Related

- [protocol.md](protocol.md) — C1 capability detection
- [ARCHITECTURE.md](../ARCHITECTURE.md) — client layout
