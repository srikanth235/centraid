# Enrollment checklist (human residual)

Wall-clock work only a human can finish: store and signing program enrollment. **No secrets belong in this repo.** Track completion outside git (password manager / 1Password / maintainer notes). Agents cite this checklist; they do not complete it.

Source: issue [#468](https://github.com/srikanth235/centraid/issues/468) Phase 0 + issue [#501](https://github.com/srikanth235/centraid/issues/501) pipeline close-out.

Probe without printing values: `bun run release:verify-secrets`.

## 1. Apple Developer Program (macOS notarization + iOS)

- [ ] Enroll / renew Apple Developer Program membership (legal entity matches shipping name).
- [ ] Create App IDs for desktop helper needs if any, and for mobile: `dev.centraid.mobile`, share extension `dev.centraid.mobile.share` ([identifiers.md](identifiers.md)).
- [ ] Create distribution certificate + provisioning profiles (or use automatic signing in Xcode with the correct team).
- [ ] Note notarization credentials path for CI (App Store Connect API key preferred over password): store in **GitHub Actions secrets** / org secrets — never commit.
- [ ] Confirm hardened-runtime and notarization plan for Electron (I2); JIT / unsigned-executable-memory entitlements only if a native addon requires them.

**GitHub Actions secret names (desktop):**

| Name | Purpose |
| --- | --- |
| `APPLE_API_KEY` | App Store Connect API key (`.p8` contents or path per electron-builder) |
| `APPLE_API_KEY_ID` | Key id |
| `APPLE_API_ISSUER` | Issuer id |

**GitHub Actions secret names (mobile iOS, `lane-release-mobile.yml`):** `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_PRIVATE_KEY`. Without them the lane builds for the simulator only.

**Blocks:** I2 desktop signing/notarization; mobile TestFlight.

## 2. Azure Trusted Signing (Windows)

- [ ] Create Azure subscription / resource group for Trusted Signing (not a traditional OV/EV file cert).
- [ ] Complete identity validation for the publisher account (lead time).
- [ ] Create certificate profile for Centraid desktop (`dev.centraid.desktop`).
- [ ] Wire CI to Azure Trusted Signing via OIDC or short-lived credentials — **signing key must never exist as a file in CI**.

**GitHub Actions secret names (desktop Windows):**

| Name                         | Purpose                           |
| ---------------------------- | --------------------------------- |
| `AZURE_TENANT_ID`            | Tenant                            |
| `AZURE_CLIENT_ID`            | App registration                  |
| `AZURE_CLIENT_SECRET`        | Client secret (prefer OIDC later) |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account           |
| `AZURE_CERT_PROFILE`         | Certificate profile name          |

**Blocks:** I3 Windows installers and SmartScreen-trustable updates.

## 3. Google Play App Signing (Android)

- [ ] Create Play Console app with application id **`dev.centraid.mobile`**.
- [ ] Enroll in **Play App Signing** — Google holds the **release** key.
- [ ] Generate and store a recoverable **upload** key; put the keystore + passwords in **GitHub Actions secrets** (J1).
- [ ] Configure internal testing track for beta (replaces a separate Centraid mobile beta channel — D5).

**GitHub Actions secret names (Android, `lane-release-mobile.yml` — J1):**

| Name                        | Purpose                        |
| --------------------------- | ------------------------------ |
| `ANDROID_KEYSTORE_BASE64`   | Upload keystore, base64        |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password              |
| `ANDROID_KEY_ALIAS`         | Key alias                      |
| `PLAY_SERVICE_ACCOUNT_JSON` | Play internal-track submission |

Without the keystore the lane runs `assembleDebug` only and reports it.

**Blocks:** J1 production Android; store submission.

## 4. Cloudflare (public site)

The public marketing and docs site is the apex `centraid` Workers static-assets project ([`wrangler.json`](../wrangler.json)). **This is the only Cloudflare surface the product has**: the Centraid Assist OAuth Worker and its `oauth-production` environment were deleted with the hosted tier ([#1029](https://github.com/srikanth235/centraid/issues/1029)).

| Name                    | Purpose         |
| ----------------------- | --------------- |
| `CLOUDFLARE_API_TOKEN`  | Wrangler deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Account         |

## 5. Cross-cutting

- [ ] GitHub Environments **`release`** / **`mobile-release`** with required reviewer = maintainer (aligns with [release.md](release.md) D1). Workflows already reference these environment names.
- [ ] Confirm secret rotation owners and recovery: upload key recoverable; Apple API keys rotatable; Azure identity recoverable via Azure portal.
- [ ] Do **not** commit: `.p12`, `.jks`, `.mobileprovision`, raw API keys, or notarization passwords.

## 6. Device enrollment

A phone pairs with a gateway — the member's laptop, a VPS, a NAS — by scanning the QR the gateway prints: `centraid-gateway serve --data-dir <dir>` prints one while nothing has paired, and `centraid-gateway pair --data-dir <dir>` beside a running `serve` prints a fresh one. The phone's **Pair with your laptop** screen (the band's More sheet), or **Add a gateway** on the Backup screen, takes the payload scanned or pasted ([R-1047-E12](decisions.md#the-24-words-on-the-phone-1047-e1)); it dials the payload's addresses, refuses a certificate whose BLAKE3 is not the payload's pin, pairs with the one-use secret and records the gateway — its addresses, certificate, token and writer epoch — in the ledger `<stem>.backup.db` beside the vault. The member compares the **safety number** the phone shows with the `safety` line `serve` prints once the pairing lands ([D-9](decisions.md#the-owners-rulings-of-2026-09-29-1047)). A phone may pair with more than one gateway, each with its own QR ([R-1080-8](decisions.md#backups-from-first-principles-1080)). There is no member or owner flag and no desktop or headless seat: v0 enrols phones only. The protocol is [gateway.md](gateway.md#pairing); the operational runbook is [recovery/pairing.md](recovery/pairing.md).

Two operational facts worth knowing before restarting a gateway:

- **A pairing secret survives a restart until it is used or its day runs out.** The gateway keeps only its hash, in `state.db`; `centraid-gateway pairings` counts how many are waiting, spent or expired, and a spent or expired one is replaced by printing another with `pair`, never revived.
- **The gateway's identity survives it too**, as `tls.key`, `tls.crt` and `gateway.id` in its data directory ([gateway.md](gateway.md#the-certificate)). Losing them mints a new identity at the next `serve`, and every paired phone must pair again.

## 7. The member's 24 words (on the phone)

Not a human checklist item, and listed here because it is the other half of enrolling a phone: the words are what a vault's keys derive from, and pairing a gateway above is useless to a phone that holds none. Nothing about them is done on a laptop or in a console.

- **Making the first vault mints them.** The phone's core mints 24 BIP39 words from the OS CSPRNG, the phone shows them once on a capture-shielded screen and asks three back, and only then stores the seed and founds the vault, keyed at index 0 ([R-1047-E1](decisions.md#the-24-words-on-the-phone-1047-e1)). Later vaults take the next index from the same seed with no new words (R-1047-E2).
- **The seed is kept by the platform, the words by the phone and the member.** The seed goes to the synchronised keychain (iCloud Keychain, Android Block Store), or to this phone only where the platform will not take it (R-1047-E6). The words are also kept in this phone's device-only store, so **Show my 24 words** in the band's More sheet can show them again behind the phone's owner check (R-1047-E10); they never sync. The member's written words are the only way back when neither the seed nor the phone survives — [recovery/backup-restore.md](recovery/backup-restore.md).
- **A new phone is restored, not re-minted.** Restore from the words — or from the synchronised seed, with no words typed (R-1047-E9) — brings each vault back at its own index with a device secret the restore mints (R-1047-E3); a phone that lost only its seed is re-keyed from Locker's "Enter your 24 words" (R-1047-E5).
- **Pairing with a gateway** is the phone's **Pair with your laptop** screen, or **Add a gateway** on the Backup screen, over the payload `centraid-gateway pair` prints, pasted or scanned (iOS reads the QR with AVFoundation; Android with CameraX and ZXing, asking for the camera at the tap — R-1047-E14): the certificate is checked against the payload's pin, the one-use secret pairs the vault, and the pairing's 60-digit safety number is shown to compare with the `safety` line `serve` prints once the pairing lands (D-9, superseding R-1047-E12's grouped endpoint). A vault open without its words is offered **Enter your 24 words** (D-11). A gateway that answered and refused says so (R-1047-E13). Each vault lives in its own directory with its own backup ledger and spool (R-1047-E8).
- **The device secret is the core's.** It is minted at pair or restore, handed to the shell once, kept in the device-only store and passed at every keyed open (R-1047-E4).

## After enrollment

Point packaging work at the secret **names** above. Repo docs stay at: "secrets live in GH Actions / store consoles." First signed desktop tag attaches installers to the GitHub Release; until then tag builds stay workflow artifacts + prerelease note.

## Related

- [decisions.md](decisions.md) — signing identities, J1, J5, D5, J7
- [release.md](release.md) — prepare vs publish
- [identifiers.md](identifiers.md) — bundle ids
