# Centraid Assist Google/Cloudflare release gates

This is an evidence checklist, not a declaration that external configuration
exists. Every checkbox needs a dated console/API artifact or reviewer link
before Assist is enabled in production. Never paste IDs, secrets, authorization
codes, tokens, or user email addresses into the evidence.

## Frozen public identity

- Consent-screen application name: **Centraid Assist**
- Homepage: `https://centraid.dev/`
- Privacy policy: `https://centraid.dev/docs/privacy/`
- Terms: `https://centraid.dev/docs/terms/`
- Support/security contact: `srikanth@crowdshakti.com`
- OAuth callback: **only**
  `https://oauth.centraid.dev/callback`
- PWA finish route: `https://app.centraid.dev/oauth/finish`
- Desktop finish scheme: `centraid://oauth/finish`

The homepage, consent screen, verification submission, and demonstration video
must use the same name and describe the same Google data use. `centraid.dev`
ownership must be verified by a project owner/editor through Search Console.

## Production Google project (standard tier)

- [ ] A dedicated production GCP project exists; development/testing uses a
      different project.
- [ ] OAuth audience is **External**.
- [ ] Publishing status is **In production**, not Testing.
- [ ] Brand verification is approved for `centraid.dev`.
- [ ] Exactly one production OAuth client exists for Assist, type **Web
      application**.
- [ ] Its authorized redirect URI list contains exactly
      `https://oauth.centraid.dev/callback`.
- [ ] Calendar API and People API are enabled.
- [ ] Requested/verified standard scopes match the UI:
      `calendar.readonly`, `contacts.readonly`.
- [ ] Verification demonstration covers the complete consent and user-facing
      capability flow.
- [ ] Evidence reviewer/date: `________________`.

Do not call standard Assist generally available before these boxes pass.
Published-but-unverified sensitive scopes show warning UI and have a hard
100-user app-wide cap; that posture is private beta only.

## Restricted tier gate

- [ ] Gmail API and Drive API are enabled.
- [ ] Google restricted-scope verification covers exactly the enabled scopes:
      `gmail.readonly`, `gmail.send`, `drive.readonly`.
- [ ] The required CASA assessment is current and the renewal owner/date are
      recorded.
- [ ] The privacy policy and demonstration disclose every enabled restricted
      capability.
- [ ] `drive.file` was evaluated and rejected/selected per the actual product
      behavior; the decision is recorded.
- [ ] Evidence reviewer/date: `________________`.

Only after this gate passes may an audited release set both the gateway
`CENTRAID_ASSIST_RESTRICTED_SCOPES=true` flag and the Worker's
`RESTRICTED_SCOPES_ENABLED=true` variable. The Worker also compares Google's
returned scope set with the gateway's exact allowlisted request before
returning any token. An unverified 100-user beta must be labelled beta and must
not set either GA flag.

## Cloudflare edge gate

- [ ] `oauth.centraid.dev` is the Worker's only public route; `workers.dev` and
      preview URLs are disabled.
- [ ] TLS is Full (strict), Always Use HTTPS is enabled, minimum TLS is 1.2+,
      and HSTS matches the Worker response.
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
      `CALLBACK_RECEIPT_SECRET` exist as Worker secrets; values were never
      committed.
- [ ] No KV, D1, Durable Object, R2, cache, queue, or per-user analytics store
      is bound.
- [ ] The `/start` browser-binding cookie is signed, HttpOnly, SameSite=Lax,
      ten-minute-only, and contains no code, token, identity, or connection
      record.
- [ ] Zone WAF managed rules and Bot Fight Mode are enabled.
- [ ] Zone rate-limiting rules cover POST `/exchange` and `/refresh` per IP.
      Start at 10 exchange attempts/5 minutes/IP and 30 refresh attempts/5
      minutes/IP, then tune from legitimate aggregate metrics. The Worker
      binding remains the second layer (20/IP/minute, 200/location/minute).
- [ ] Known abusive networks are blocked/challenged at the zone based on
      incident evidence, not a permanent broad denylist.
- [ ] Workers Logs, invocation logs, and automatic traces are disabled.
      Analytics Engine contains only route/outcome/status/count. Any zone
      Logpush dataset omits or redacts query strings, request bodies, and
      headers that could contain code/state/binding/receipt/token material.
- [ ] Aggregate alerting covers: `/exchange` failure ratio, `/refresh` failure
      ratio, 429 volume, Worker 5xx, and a sudden request-volume increase.
- [ ] At least two alert recipients and an on-call owner are recorded.
- [ ] `EXCHANGE_ENABLED=false` was tested in a non-production environment.
- [ ] Evidence reviewer/date: `________________`.

Cloudflare's Workers rate-limit `global` key is enforced per Cloudflare
location, not as a mathematically global fleet counter. Zone rules and alerts
are therefore mandatory; the binding alone is not the full abuse defense.

## Manual acceptance matrix

Record build SHA, date, gateway identity (non-secret label), client version,
result, and evidence link.

| Path | Required result | Evidence |
| --- | --- | --- |
| Desktop + remote gateway with no public DNS | Deep link completes; manual return link also completes; connection active | |
| PWA + remote gateway with no public DNS | Same-tab resume; paired Iroh transport re-dials; connection active | |
| Desktop + embedded local gateway | Assist regression passes; connection active | |
| Browser-reachable gateway + BYO | Existing callback and direct refresh still pass | |
| Assist refresh | Worker `/refresh`; rotated token sealed before use | |
| Revoked grant | Connection becomes `needs-auth`; Reconnect with Centraid Assist is shown | |

The test is invalid if the gateway callback is publicly exposed for the first
two rows. Inspect browser history, desktop logs, gateway logs, Worker logs, and
Cloudflare bindings to confirm no token appeared in a URL/page/deep link and no
cloud token/connection store exists.
