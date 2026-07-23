# Centraid Assist OAuth recovery

Use this runbook for abuse, Worker outage, or secret rotation. Do not copy
request URLs, bodies, authorization codes, receipts, refresh tokens, Google
client secrets, or user identifiers into tickets or logs.

## Abuse or failure-ratio incident

1. Set the Worker variable `EXCHANGE_ENABLED=false` and deploy
   `apps/oauth-worker`. This disables both `/exchange` and `/refresh`;
   `/callback` remains a code-only finish path.
2. Confirm `/exchange` and `/refresh` return `503 {"error":"assist_disabled"}`
   without contacting Google.
3. Review only aggregate Analytics Engine counters: route, outcome, status,
   count. Keep Workers Logs, invocation logs, and automatic traces disabled.
4. Tighten Cloudflare zone rate-limit rules for `/exchange` and `/refresh`.
   Apply targeted ASN/bot blocks only when aggregate edge evidence supports
   them. Keep WAF managed rules and Bot Fight Mode enabled.
5. Check the alert that fired, Cloudflare status, and Google's OAuth/project
   quota/abuse notices. Never test by replaying a captured production code.
6. If a credential may be compromised, rotate as below before re-enabling.
7. Re-enable with `EXCHANGE_ENABLED=true`, deploy, then watch success/failure
   ratios and 429s for at least one refresh interval.
8. Record timestamps, configuration changes, and aggregate counts in the
   private incident record.

Impact while disabled: new Assist connects cannot exchange and existing Assist
refreshes retry once, then skip that fire without losing the existing
connection. An actual Google `invalid_grant` changes the connection to
`needs-auth`. BYO remains independent.

## Rotate the Google client secret

1. Keep the old Google secret active initially.
2. Create a replacement secret for the same Web client in Google Cloud.
3. From `apps/oauth-worker`, update the Cloudflare secret:

   ```sh
   bun run secret:put:google-client
   ```

4. Deploy with `bun run deploy`.
5. Prove a fresh test-project exchange and an existing refresh through the
   Worker. Inspect only status/aggregate counters.
6. Revoke/delete the old Google secret.
7. Repeat the smoke after revocation.

The secret must never be added to `.dev.vars`, gateway environment, GitHub
logs, or repository files.

## Rotate the callback-receipt HMAC key

Receipt TTL is two minutes. Rotation invalidates in-flight callbacks but never
stored tokens.

1. Temporarily disable exchange/refresh if rotation is incident-driven.
2. Update the secret:

   ```sh
   bun run secret:put:receipt
   ```

3. Deploy and wait at least two minutes before treating old finish links as
   conclusively expired.
4. Start a new ceremony and verify `/start` browser binding → callback →
   receipt → exchange.
5. Re-enable exchange/refresh if disabled.

Users whose two-minute handoff crossed the rotation boundary simply start
Connect again. Do not introduce a KV-backed dual-key receipt store.

## Worker outage

1. Check Cloudflare service status, route/DNS/TLS health, deployment status,
   and aggregate Worker 5xx.
2. Do not move token exchange into the client or gateway and do not expose the
   Google client secret as a workaround.
3. Leave BYO available. Tell Assist users that existing imported vault data
   remains local; new connects and refresh-dependent sync runs wait.
4. After recovery, verify `/callback`, one test-project `/exchange`, and one
   test-project `/refresh`, then watch aggregate failure ratios.

## Revoke the Assist client

For a confirmed shared-client compromise:

1. Disable exchange/refresh.
2. Revoke/delete the Google OAuth client in Cloud Console.
3. Remove or disable the `oauth.centraid.dev` Worker route.
4. Remove production Assist coordinates from gateway deployment
   configuration. Clients then advertise BYO only.
5. Rotate both Worker secrets before creating a replacement client.
6. Re-run every gate in
   [the release checklist](../release/oauth-assist-google.md).
