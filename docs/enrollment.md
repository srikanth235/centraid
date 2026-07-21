# Enrollment checklist (human residual)

Wall-clock work only a human can finish: store and signing program enrollment. **No secrets belong in this repo.** Track completion outside git (password manager / 1Password / maintainer notes). Agents cite this checklist; they do not complete it.

Source: issue [#468](https://github.com/srikanth235/centraid/issues/468) Phase 0 — start before packaging pipelines (I2, I3, J1).

## 1. Apple Developer Program (macOS notarization + iOS)

- [ ] Enroll / renew Apple Developer Program membership (legal entity matches shipping name).
- [ ] Create App IDs for desktop helper needs if any, and for mobile: `dev.centraid.mobile`, share extension `dev.centraid.mobile.share` ([identifiers.md](identifiers.md)).
- [ ] Create distribution certificate + provisioning profiles (or use automatic signing in Xcode/EAS with the correct team).
- [ ] Note notarization credentials path for CI (App Store Connect API key preferred over password): store in **GitHub Actions secrets** / org secrets — never commit.
- [ ] Confirm hardened-runtime and notarization plan for Electron (I2); JIT / unsigned-executable-memory entitlements only if a native addon requires them.

**Blocks:** I2 desktop signing/notarization; mobile TestFlight.

## 2. Azure Trusted Signing (Windows)

- [ ] Create Azure subscription / resource group for Trusted Signing (not a traditional OV/EV file cert).
- [ ] Complete identity validation for the publisher account (lead time).
- [ ] Create certificate profile for Centraid desktop (`dev.centraid.desktop`).
- [ ] Wire CI to Azure Trusted Signing via OIDC or short-lived credentials — **signing key must never exist as a file in CI**.
- [ ] Document secret names in the private runbook only (e.g. `AZURE_TS_*`) — not in this file's values.

**Blocks:** I3 Windows installers and SmartScreen-trustable updates.

## 3. Google Play App Signing (Android)

- [ ] Create Play Console app with application id **`dev.centraid.mobile`** (after J5 rename lands in the tree).
- [ ] Enroll in **Play App Signing** — Google holds the **release** key.
- [ ] Generate and store a recoverable **upload** key; put the keystore + passwords in **GitHub Actions secrets** (J1).
- [ ] Configure internal testing track for beta (replaces a separate Centraid mobile beta channel — D5).
- [ ] Remove any workflow that would sign release builds with the committed **debug** keystore.

**Blocks:** J1 production Android; store submission.

## 4. Cross-cutting

- [ ] GitHub Environments for `release` / `mobile-release` with required reviewer = maintainer (aligns with [release.md](release.md) D1).
- [ ] Confirm secret rotation owners and recovery: upload key recoverable; Apple API keys rotatable; Azure identity recoverable via Azure portal.
- [ ] Do **not** commit: `.p12`, `.jks`, `.mobileprovision`, raw API keys, or notarization passwords.

## After enrollment

Point packaging work (groups I / J) at the secret **names** and document them in the private ops note. Repo docs stay at: "secrets live in GH Actions / store consoles."

## Related

- [decisions.md](decisions.md) — signing identities, J1, J5, D5
- [release.md](release.md) — prepare vs publish
- [identifiers.md](identifiers.md) — bundle ids
