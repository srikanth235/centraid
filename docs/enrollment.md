# Enrollment checklist (human residual)

Wall-clock work only a human can finish: store and signing program enrollment. **No secrets belong in this repo.** Track completion outside git (password manager / 1Password / maintainer notes). Agents cite this checklist; they do not complete it.

Source: issue [#468](https://github.com/srikanth235/centraid/issues/468) Phase 0 + issue [#501](https://github.com/srikanth235/centraid/issues/501) pipeline close-out.

Probe without printing values: `bun run release:verify-secrets`.

## 1. Apple Developer Program (macOS notarization + iOS)

- [ ] Enroll / renew Apple Developer Program membership (legal entity matches shipping name).
- [ ] Create App IDs for desktop helper needs if any, and for mobile: `dev.centraid.mobile`, share extension `dev.centraid.mobile.share` ([identifiers.md](identifiers.md)).
- [ ] Create distribution certificate + provisioning profiles (or use automatic signing in Xcode/EAS with the correct team).
- [ ] Note notarization credentials path for CI (App Store Connect API key preferred over password): store in **GitHub Actions secrets** / org secrets — never commit.
- [ ] Confirm hardened-runtime and notarization plan for Electron (I2); JIT / unsigned-executable-memory entitlements only if a native addon requires them.

**GitHub Actions secret names (desktop):**

| Name | Purpose |
| --- | --- |
| `APPLE_API_KEY` | App Store Connect API key (`.p8` contents or path per electron-builder) |
| `APPLE_API_KEY_ID` | Key id |
| `APPLE_API_ISSUER` | Issuer id |

**Blocks:** I2 desktop signing/notarization; mobile TestFlight.

## 2. Azure Trusted Signing (Windows)

- [ ] Create Azure subscription / resource group for Trusted Signing (not a traditional OV/EV file cert).
- [ ] Complete identity validation for the publisher account (lead time).
- [ ] Create certificate profile for Centraid desktop (`dev.centraid.desktop`).
- [ ] Wire CI to Azure Trusted Signing via OIDC or short-lived credentials — **signing key must never exist as a file in CI**.

**GitHub Actions secret names (desktop Windows):**

| Name | Purpose |
| --- | --- |
| `AZURE_TENANT_ID` | Tenant |
| `AZURE_CLIENT_ID` | App registration |
| `AZURE_CLIENT_SECRET` | Client secret (prefer OIDC later) |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account |
| `AZURE_CERT_PROFILE` | Certificate profile name |

**Blocks:** I3 Windows installers and SmartScreen-trustable updates.

## 3. Google Play App Signing (Android)

- [ ] Create Play Console app with application id **`dev.centraid.mobile`**.
- [ ] Enroll in **Play App Signing** — Google holds the **release** key.
- [ ] Generate and store a recoverable **upload** key; put the keystore + passwords in **GitHub Actions secrets** (J1).
- [ ] Configure internal testing track for beta (replaces a separate Centraid mobile beta channel — D5).
- [ ] Store lanes must set `CENTRAID_REQUIRE_RELEASE_SIGNING=1` (or provide `CENTRAID_UPLOAD_*`) so release never uses the committed **debug** keystore.

**GitHub Actions / env secret names (Android upload key — J1):**

| Name | Purpose |
| --- | --- |
| `CENTRAID_UPLOAD_STORE_FILE` | Path to upload keystore file in the job |
| `CENTRAID_UPLOAD_STORE_PASSWORD` | Keystore password |
| `CENTRAID_UPLOAD_KEY_ALIAS` | Key alias |
| `CENTRAID_UPLOAD_KEY_PASSWORD` | Key password |

**Blocks:** J1 production Android; store submission.

## 4. Expo / EAS (mobile build + submit)

- [ ] Create Expo account + EAS project for `apps/mobile`.
- [ ] Set `EAS_PROJECT_ID` (replaces `placeholder-centraid-mobile` in updates URL when ready).
- [ ] Store `EXPO_TOKEN` in GitHub Actions for `release-mobile.yml`.
- [ ] Fill `ascAppId` placeholders in `apps/mobile/eas.json` after App Store Connect app exists.
- [ ] **Do not** add routine `eas update` to CI (J7 — dormant hotfix lane only).

| Name | Purpose |
| --- | --- |
| `EXPO_TOKEN` | EAS CI auth |
| `EAS_PROJECT_ID` | Expo project id for updates URL + EAS |

## 5. Cloudflare (public web PWA)

- [ ] Bind **`app.centraid.dev`** to the `centraid-web` worker/assets project (`apps/web/wrangler.json`).
- [ ] Store deploy credentials if using GHA wrangler (optional if CF Git integration is used instead).

| Name | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Account |

Marketing + docs remain the apex `centraid` worker (`wrangler.json` → `./dist/site`).

## 6. Cross-cutting

- [ ] GitHub Environments **`release`** / **`mobile-release`** with required reviewer = maintainer (aligns with [release.md](release.md) D1). Workflows already reference these environment names.
- [ ] Confirm secret rotation owners and recovery: upload key recoverable; Apple API keys rotatable; Azure identity recoverable via Azure portal.
- [ ] Do **not** commit: `.p12`, `.jks`, `.mobileprovision`, raw API keys, or notarization passwords.

## After enrollment

Point packaging work at the secret **names** above. Repo docs stay at: "secrets live in GH Actions / store consoles." First signed desktop tag attaches installers to the GitHub Release; until then tag builds stay workflow artifacts + prerelease note.

## Related

- [decisions.md](decisions.md) — signing identities, J1, J5, D5, J7
- [release.md](release.md) — prepare vs publish
- [identifiers.md](identifiers.md) — bundle ids
