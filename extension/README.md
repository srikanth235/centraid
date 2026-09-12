# `extension/` — the Centraid browser Companion

MV3, native messaging, **no network and no WASM**. Part of the v1 platform ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane F); `apps/extension/` is the pinned v0 oracle and is not edited.

## What changed from v0

v0's Companion runs a **WASM iroh endpoint in the service worker** and dials the gateway itself (`apps/extension/src/transport.ts`, and `'wasm-unsafe-eval'` in its CSP). This one talks to the Centraid app **on this machine** through `chrome.runtime.connectNative("dev.centraid.host")` — which is `centraid native-host`, the same binary the desktop spawns as its seat.

Three consequences, each a reduction:

| v0 | here |
| --- | --- |
| `host_permissions: http://*/*, https://*/*` | **no host permissions at all** — there is nothing for it to reach |
| `'wasm-unsafe-eval'` in the extension CSP | `script-src 'self'` |
| a long-lived endpoint holding a connection | **one native port per request** |

That last one matters: a native port holds a _process_. A background page that kept one open would keep `centraid native-host` — and through it a capability token — alive for the life of the browser, and MV3 evicts the worker anyway, so a long-lived port is a lifetime nobody controls.

## What was carried, and why

The **retry classification**, from `apps/extension/src/transport-core.ts`:

- a **revoked device is never retried**, whatever the verb or the attempt;
- a **non-idempotent verb** retries only a _clear connect failure_, because a request that reached the app and then failed may have been taken.

Neither rule is about the transport, so neither changed. The 401 sentence was carried too and re-pointed: there is no HTTP status on a native port, so the same member sentence now answers the host's `no-capability` refusal.

## How the host is authorised

The browser launches the host, so it runs as the member — it does **not** become privileged by being launched by Chrome. It connects to the seat socket as any other local client and passes the same peer-uid check, presenting a **per-turn capability token** the shell minted (`CENTRAID_SEAT_TOKEN`). Tokens are single-use and expire; see `desktop/README.md` for the socket contract.

## Setting it up

```sh
# Write the host manifest for a browser, with its extension-id allowlist.
cargo run -p centraid -- native-host install \
  --browser chrome --extension-id <32-char id> --out /tmp/dev.centraid.host.json
```

It **never copies the manifest into a browser's directory**: a file that appeared under a browser's configuration because something was unpacked is a capability nobody chose to grant (the same rule `centraid gateway install` follows). The verb prints the directory to copy it to, per platform. An empty allowlist is refused: a host any extension may drive is a host that can read this vault.

## Proving the wire

```sh
cargo build -p centraid
node extension/scripts/native-round-trip.mjs
```

Speaks the browser's own framing — `u32` in the **host's** byte order, then UTF-8 JSON, which is _not_ the product's `u32BE` — and round-trips a `ping`. The same round trip is asserted from Rust in `crates/centraid/tests/no_listener.rs`, so this script is the human-readable half rather than the only proof.

```sh
bun run --cwd extension test        # the pure layer
bun run --cwd extension typecheck
```

## Owner hand-offs

- **Store enrolment** for Chrome Web Store and AMO, and the extension ids that go in each browser's allowlist. Until an id is enrolled there is nothing to put in a manifest, and a manifest with a placeholder id is a manifest that silently does not work.
- **Where the host manifest is stored, per browser and per platform.** The verb prints the directories; which one an installer writes to (and whether the desktop installer should offer to) is a product decision, not this lane's.
- **The read surface.** The host answers `ping` and refuses everything else with a reason today. Relaying a Locker read or a page capture to the seat socket lands with the Companion's own screens.
