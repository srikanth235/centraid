# Identifiers (`dev.centraid.*`)

**Decision J5** (issue [#468](https://github.com/srikanth235/centraid/issues/468)): reverse-DNS root is **`dev.centraid`**, not `com.centraid`. We own **centraid.dev**; we do not own a `centraid.com` claim. Nothing is published to stores yet — rename before first submission; permanent afterward.

## Full table

| Surface | Identifier |
| --- | --- |
| Mobile iOS + Android (decided) | `dev.centraid.mobile` |
| Mobile debug variant (decided) | `dev.centraid.mobile.debug` |
| iOS share extension (decided) | `dev.centraid.mobile.share` |
| Desktop | **Reserved, unused.** `dev.centraid.desktop` is held for the deferred desktop shell ([R-1029-1](decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)) and nothing ships under it. |
| Gateway LaunchAgent label (H5) | `dev.centraid.gateway` ([`deploy/launchd/dev.centraid.gateway.plist`](../deploy/launchd/dev.centraid.gateway.plist)) |
| Automation scheduler labels | `dev.centraid.<appId>.<name>` |
| Deep-link scheme | `centraid://` (debug: `centraid-debug://`) |

## Rationale notes

- Keep **`.mobile`** (not `.app`) so naming pairs with **`.desktop`** and renames stay a prefix substitution across mobile projects, `os-scheduler` labels, and test docs that hardcode package names in `simctl` / `adb`.
- **No hyphen** in share extension id: Android package segments cannot contain hyphens.
- Debug suffix is **`.debug`**, not `.dev` (would read as a TLD typo against `centraid.dev`).
- The LaunchAgent label is `dev.centraid.gateway` (`DEFAULT_LAUNCHD_LABEL` in [`crates/centraid/src/cmd/units.rs`](../crates/centraid/src/cmd/units.rs), which `centraid gateway install` writes).
- The native projects do not carry the mobile ids yet: [`mobile/androidApp/build.gradle.kts`](../mobile/androidApp/build.gradle.kts) sets `applicationId = "dev.centraid"`, and [`mobile/iosApp/project.yml`](../mobile/iosApp/project.yml) sets `bundleIdPrefix: dev.centraid` on the `Centraid` target. Renaming before first store submission is the J5 rule.

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
