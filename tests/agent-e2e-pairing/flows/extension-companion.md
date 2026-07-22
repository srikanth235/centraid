# Extension Companion acceptance

This flow runs the issue #462 acceptance journey through the shipped MV3 bundle, not a mocked transport. It boots a factory-fresh gateway, installs the real Locker blueprint and grants, saves a real sealed login, mints a one-time pairing ticket, and loads `apps/extension/dist` into a fresh Chromium profile.

The browser worker redeems the ticket through `centraid/gw-pair/1` using the checked-in iroh WASM binding. A local HTTPS-equivalent development origin (`http://localhost`, the normative exception) hosts a top-frame login form. The flow clicks the Companion suggestion, measures cold and warm fill, and asserts username, password, and derived TOTP. It then reads the gateway's owner review feed to prove the origin-bearing reveal receipt exists, revokes the extension's endpoint through the real admin CLI, and proves the next fill attempt is refused and local pairing state is purged.

Run under a display because Chromium extensions do not run in normal headless mode:

```sh
bunx playwright install chromium
xvfb-run --auto-servernum node tests/agent-e2e-pairing/flows/extension-companion.mjs
```

This flow uses the same gateway/pairing harness as the other ceremony tests. It needs internet egress to the production n0 relay because browser iroh cannot take the native loopback UDP path.
