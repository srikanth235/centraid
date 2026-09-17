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

The public marketing and docs site is the apex `centraid` Workers static-assets project ([`wrangler.json`](../wrangler.json)).

| Name                    | Purpose         |
| ----------------------- | --------------- |
| `CLOUDFLARE_API_TOKEN`  | Wrangler deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Account         |

### Centraid Assist OAuth edge

- [ ] Bind **`oauth.centraid.dev`** as the only custom route for the OAuth worker; disable `workers.dev` and preview URLs.
- [ ] Create protected GitHub Environment **`oauth-production`** with the maintainer as required reviewer.
- [ ] Set repository variable `OAUTH_WORKER_DEPLOY_ENABLED=true` only after [the Google/Cloudflare evidence gates](release/oauth-assist-google.md) pass.
- [ ] Store `GOOGLE_CLIENT_SECRET` and `CALLBACK_RECEIPT_SECRET` with Cloudflare Worker Secrets, not GitHub or the gateway. The public `GOOGLE_CLIENT_ID` is a Worker variable and gateway coordinate.
- [ ] Establish two alert recipients and a rotation owner; exercise the [Assist recovery runbook](recovery/oauth-assist.md).

## 5. Cross-cutting

- [ ] GitHub Environments **`release`** / **`mobile-release`** with required reviewer = maintainer (aligns with [release.md](release.md) D1). Workflows already reference these environment names.
- [ ] Confirm secret rotation owners and recovery: upload key recoverable; Apple API keys rotatable; Azure identity recoverable via Azure portal.
- [ ] Do **not** commit: `.p12`, `.jks`, `.mobileprovision`, raw API keys, or notarization passwords.

## 6. Device enrollment

A device pairs by redeeming a one-time ticket the gateway prints: `centraid gateway --data-dir <dir> --print-qr [N]` on the gateway host, then a scan on the phone or `centraid seat pair <ticket>` on a desktop or headless seat. There is no member or owner flag on pairing; a ticket enrols a device of the vault's owner. The redeeming device supplies its own display name. See [recovery/pairing.md](recovery/pairing.md) for the operational runbook.

**Where the gateway keeps an enrolment** (#1025, [D-1025-S7-80](decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). `centraid gateway` stores it in the vault's own `access_device` rows and their private `access_device_secret` sibling — the same rows the `DevicesList` read renders and the `devices.revoke` admin command deletes (the `centraid devices` verbs that send them exit 3 in this build). It is therefore durable across a restart, and revoking a device in the member's list is the same act as refusing it at the transport door: the gateway looks a proved iroh EndpointId up by `access_device_secret.public_key`, and a revoked device has no such row. **Unknown and revoked are one refusal**, deliberately.

Two operational consequences worth knowing before restarting a gateway:

- **An unredeemed pairing code does not survive the restart.** Tickets are held in the running process; mint another with `centraid gateway --print-qr`.
- **The gateway's own endpoint identity does survive it**, as `gateway.endpoint.key` in `<data-dir>/keys` ([D-1025-S7-81](decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). That directory is the one export, backup and copy gestures do not move — a copied vault does not carry the authority to answer as its gateway — so restoring a gateway onto a new machine means moving `keys/` deliberately, or re-pairing every device.

A gateway started with **no `--data-dir`** has no vault, keeps its enrolments in memory, and says so at start. Nothing it enrols outlives the process.

## After enrollment

Point packaging work at the secret **names** above. Repo docs stay at: "secrets live in GH Actions / store consoles." First signed desktop tag attaches installers to the GitHub Release; until then tag builds stay workflow artifacts + prerelease note.

## Related

- [decisions.md](decisions.md) — signing identities, J1, J5, D5, J7
- [release.md](release.md) — prepare vs publish
- [identifiers.md](identifiers.md) — bundle ids
