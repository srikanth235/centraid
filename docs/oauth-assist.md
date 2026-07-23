# Centraid Assist OAuth

Centraid Assist is the default Google connection path for desktop and the PWA.
It works when the paired gateway has no public DNS name: the browser carries a
short-lived authorization code back to the initiating client, and that client
delivers it over its existing authenticated gateway transport.

## Privacy promise

Assist is ceremony-only. OAuth tokens are stored only, sealed, on the user's
gateway. Tokens never enter a browser URL, page, fragment, deep link, browser
storage, Cloudflare KV/D1, or a Centraid connection service. Google's token
response passes through Worker process memory only on its server-to-server
return to the gateway. Assist deliberately does not request `openid`, `email`,
or `profile`, so the ceremony Worker does not learn the connecting identity.

The public [privacy policy](https://centraid.dev/docs/privacy/) describes the
Google data lifecycle. The repository threat model is in
[SECURITY.md](../SECURITY.md#centraid-assist-oauth-model-b-code-courier).

## What the user chooses

The Connect screen requests only the capabilities selected at that moment.

| Tier | Scopes | Release posture |
| --- | --- | --- |
| Standard Assist | `calendar.readonly`, `contacts.readonly` | Sensitive-scope verification; no CASA |
| Restricted Assist | `gmail.readonly`, `gmail.send`, `drive.readonly` | Disabled until restricted-scope verification and CASA evidence are recorded |

Centraid does not request every Google scope up front. Restricted options remain
disabled unless the gateway host is explicitly started with
`CENTRAID_ASSIST_RESTRICTED_SCOPES=true`. That flag is a release assertion, not
a verification bypass.

## Assist versus Advanced (BYO)

- **Connect with Centraid** uses the shared, confidential Web client at
  `oauth.centraid.dev`. The gateway stores state, the PKCE verifier, and tokens;
  the Worker stores nothing.
- **Use my own OAuth app (Advanced)** keeps the existing BYO path for
  air-gapped installs, custom branding, and operator-controlled clients. BYO
  requires the consenting browser to reach the gateway callback. A remote
  gateway reachable only through pairing/ticket/relay does not satisfy that
  requirement unless the operator supplies its own public callback topology.

Assist does not proxy Gmail, Calendar, Contacts, or Drive API traffic. After
authorization, the gateway contacts those APIs directly through the existing
host-pinned broker.

## Ceremony and refresh

1. The owner selects Google capabilities.
2. The authenticated gateway creates an Assist connection and mints random,
   single-use state plus an S256 PKCE verifier. Both live only in its in-memory
   ceremony map for ten minutes. The ceremony is also bound to the initiating
   client session and enrolled device identity where available.
3. The client opens a Worker `/start#…` page carrying a one-ceremony random
   browser binding. The page scrubs its fragment before I/O, sets a signed
   HttpOnly binding cookie, and then opens Google's fixed authorization URL.
   The Google URL does not contain the binding, so sharing only that URL cannot
   plant another account into the initiating connection.
4. Google redirects only to `https://oauth.centraid.dev/callback`. The
   stateless Worker requires the signed browser binding, creates a two-minute
   HMAC receipt over the exact code/state/binding tuple, and returns
   code/state/receipt to either the fixed PWA finish route or fixed desktop
   deep link. The cookie contains no code, token, identity, or connection row
   and expires after ten minutes.
5. The initiating client immediately removes the PWA fragment or validates the
   desktop link, then delivers the handoff to the gateway. Nothing is persisted.
6. The gateway validates the live state and client/device binding, consumes it,
   and sends the code, receipt, PKCE verifier, and its original browser binding
   to the Worker's `/exchange`. The Worker verifies the receipt against that
   tuple, attaches its Google client secret, and returns only allowlisted token
   fields after Google's granted scope set exactly matches the gateway's
   Worker-allowlisted request. The gateway seals them before the connection
   becomes active.
7. Assist refreshes go gateway → Worker `/refresh` → Google. BYO refreshes
   remain gateway → provider. Both preserve single-flight, rotate-before-use,
   retry, and `invalid_grant` → `needs-auth` behavior.

A copied handoff cannot redeem against another gateway because that gateway has
neither the pending state, verifier, nor browser binding. A copied link from
another client/device also cannot burn the owner's valid state. The callback
receipt is a recent bound-callback admission proof, not an assertion that
Google authenticated the callback HTTP request; Google validates the code at
the token endpoint.

## Reconnect and fallback

Normal access-token refresh is silent. The UI asks for **Reconnect with
Centraid Assist** only when a refresh token is absent or Google refuses the
grant. Reconnect reuses the connection's pinned principal as `login_hint` after
the connector has observed that account.

Desktop first tries `centraid://oauth/finish#…`. If OS protocol registration
does not reopen the app, the finish page exposes the same code-only return link
for manual paste in the connector detail. After the initial polling window, the
UI remains in **Still waiting…** rather than claiming failure. PWA uses a
same-tab `https://app.centraid.dev/oauth/finish#…` resume so a lost
`window.opener` is irrelevant.

## Host configuration

Assist is absent from gateway capabilities unless both public coordinates are
configured. The Worker origin is fail-closed to the production origin below or
the exact `http://127.0.0.1:8787` development origin; an arbitrary HTTPS URL is
rejected before any refresh token can be posted:

```text
CENTRAID_ASSIST_OAUTH_WORKER_URL=https://oauth.centraid.dev
CENTRAID_ASSIST_GOOGLE_CLIENT_ID=<public Web OAuth client id>
CENTRAID_ASSIST_RESTRICTED_SCOPES=false
```

The Google client secret and callback-receipt secret must never be configured
on a gateway or shipped in desktop/PWA assets. They are Worker secrets only.
The Worker independently keeps `RESTRICTED_SCOPES_ENABLED=false` and refuses
to return a token unless Google's response carries the exact standard scope
set the gateway requested. Both restricted flags require a reviewed release
after verification evidence exists.

For local development, copy `apps/oauth-worker/.dev.vars.example` to
`.dev.vars`, use a separate Google **Testing** project/client, and register the
exact loopback callback shown there. Point the gateway at the loopback Worker.
Never reuse production credentials for local development.

## Release evidence

Assist must remain unavailable in a production build until the checklist in
[Google/Cloudflare release gates](release/oauth-assist-google.md) has real
operator evidence. Restricted scopes must remain disabled until the additional
restricted-scope/CASA gate passes. Incident and rotation steps are in the
[Assist recovery runbook](recovery/oauth-assist.md).
