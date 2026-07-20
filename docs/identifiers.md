# Identifiers (`dev.centraid.*`)

**Decision J5** (issue [#468](https://github.com/srikanth235/centraid/issues/468)): reverse-DNS root is **`dev.centraid`**, not `com.centraid`. We own **centraid.dev**; we do not own a `centraid.com` claim. Nothing is published to stores yet — rename before first submission; permanent afterward.

## Full table

| Surface | Identifier |
| --- | --- |
| Mobile iOS + Android | `dev.centraid.mobile` |
| Mobile debug variant | `dev.centraid.mobile.debug` |
| iOS share extension | `dev.centraid.mobile.share` |
| Desktop (electron-builder `appId`) | `dev.centraid.desktop` |
| Gateway LaunchAgent label (H5) | `dev.centraid.gateway` |
| Automation scheduler labels | `dev.centraid.<appId>.<name>` |
| Deep-link scheme | `centraid://` (debug: `centraid-debug://`) |

## Rationale notes

- Keep **`.mobile`** (not `.app`) so naming pairs with **`.desktop`** and renames stay a prefix substitution across mobile projects, `os-scheduler` labels, and test docs that hardcode package names in `simctl` / `adb`.
- **No hyphen** in share extension id: Android package segments cannot contain hyphens.
- Debug suffix is **`.debug`**, not `.dev` (would read as a TLD typo against `centraid.dev`).
- Default LaunchAgent label already in code: `dev.centraid.gateway` (`packages/gateway/src/cli/service-unit.ts`).

## HSTS / cleartext constraint (J3)

LAN HTTP is legitimate for this product, but:

- Do **not** put cleartext LAN hosts under a `centraid.dev` subdomain — the **`.dev` TLD is HSTS-preloaded**, so browsers and WebViews force HTTPS with no certificate-warning bypass.
- Prefer **IP literals** or **mDNS `.local`** names for cleartext LAN, declared via a narrow allowlist (not app-wide cleartext on release manifests).

## App Links (K14)

Universal Links / Android App Links should use HTTPS on **centraid.dev** (`.well-known/apple-app-site-association`, `assetlinks.json`). Keep `centraid://` as fallback scheme only — another app can hijack a custom scheme; App Links cannot.

## Related

- [decisions.md](decisions.md)
- [enrollment.md](enrollment.md) — store enrollment
- [protocol.md](protocol.md) — capability walls across clients
