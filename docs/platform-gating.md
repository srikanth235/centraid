# Platform gating

Decision matrix for UI/runtime branches across desktop (Electron), web PWA, and mobile (Expo). Issue #504 batch 1.

**Mechanical vs judgment:** host/capability branching remains judgment-led; the shared visual grammar is mechanically enforced as described below. Prefer **platform file splits** for large divergences instead of long `if (isWeb)` ladders.

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

The system has **one** surface axis — **pointer or touch** — and width is a canvas, not a surface. A narrower stage carries no typography, target, or margin rules of its own: width changes measure and column count only. If a surface enum is introduced, it is `'pointer' | 'touch'`; `desktop`, `compact`, `mobile`, and `pwa` are host/form-factor facts, not design-system modes. Two names for one state is not a naming preference; it is a defect waiting to happen because each synonym eventually gets tested differently.

Resolve the axis **once per render** into a token set and read the object everywhere, rather than re-deciding it at each call site. The measured cost of the alternative is 122 hand-written `touch ? a : b` ternaries: a change to the phone margin becomes 122 places to look, and several controls silently sat at 34px — under the 44px touch floor.

The floor is not advisory. The generated sheet starts with the touch contract — 44px target, 18px page margin, touch type values — and one `(pointer: fine)` query lowers the target to 34px, raises the page margin to 32px, and installs the pointer type values. Desktop and PWA both consume that sheet from `packages/client`; Expo consumes the typed touch lowering from the same registry.

## Design enforcement parity

There is one registry and two syntax-specific consumer gates. Desktop and PWA are not separate design implementations: Electron renders the shared React shell in `packages/client`, and the PWA renders that same shell plus its one host stylesheet at `apps/web/src/web.css`. Both sit inside the CSS gate's scan roots. Expo consumes the native lowering because React Native cannot consume CSS, but it is held to the same zero-literal rule.

| Shared invariant | Desktop + PWA enforcement | Expo enforcement |
| --- | --- | --- |
| Colour comes from a semantic role | `lint:design-tokens` rejects raw CSS hex | `lint:mobile-design` rejects literal style/JSX hex and rgb(a) |
| Type comes from the semantic ramp | rejects literal family, size, off-ramp weight, and retired axes | rejects literal family/weight and numeric size/leading; consumers use `t(role)` (or the shared platform-code family for code) |
| Radius comes from the shared scale | rejects literal, derived, arbitrary-variable, and fallback radii | rejects numeric radius properties; consumers use `radii.role` |
| Registry and lowering agree | design package contract and emitted-CSS tests | native contract plus direct-adapter tests |
| Minimum type and target floors hold | `lint:type-floor`; emitted pointer target is 34px | `lint:type-floor`; typed touch target is 44px |
| Platform-only lowering stays honest | pointer media query and gallery computed-style checks | `lint:hairline` and `lint:logical-insets` check native pixel/direction semantics |

Run `bun run lint:design-consumers` for the common parity check. `check:push` keeps its CSS and native halves as separate gates only so they run in parallel; neither has an allowance ledger. Emitters and native adapters may contain renderer mechanics because they own the lowering boundary. Product consumers may not contain literal design decisions.

## Do not

- Treat compact layout as a security boundary.
- Introduce a second word for one surface, or a third surface for a width.
- Re-implement gateway auth differently per platform; all clients use the same wire + token/session model.
- Branch business logic on user-agent strings.

## Related

- [protocol.md](protocol.md) — C1 capability detection
- [ARCHITECTURE.md](../ARCHITECTURE.md) — client layout
- [design-machinery.md](design-machinery.md) — design inventory and ownership
