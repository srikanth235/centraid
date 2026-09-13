# `extension/` — the Centraid browser Companion

MV3, native messaging, **no network and no WASM**. Part of the v1 platform ([#1020](https://github.com/srikanth235/centraid/issues/1020): skeleton in wave 3 lane F, finished in wave 4 lane extension); `apps/extension/` is the pinned v0 oracle and is not edited.

## What changed from v0

v0's Companion runs a **WASM iroh endpoint in the service worker** and dials the gateway (`apps/extension/src/transport.ts`, and `'wasm-unsafe-eval'` in its CSP). This one talks to the Centraid app **on this machine** through `chrome.runtime.connectNative("dev.centraid.host")` — which is `centraid native-host`, the same binary the desktop spawns as its seat.

| v0 | here |
| --- | --- |
| `host_permissions: http://*/*, https://*/*` | **no host permissions at all** — there is nothing for it to reach |
| `'wasm-unsafe-eval'` in the extension CSP | `script-src 'self'` |
| `tldts` + the Public Suffix List bundled, to decide registrable domains | **no third-party code at all**; the policy runs on the seat |
| a fill served by the gateway, which held `K` | a fill served by the **seat**, which unwraps `K` behind the member's unlock |

`src/bundle.test.ts` asserts the first three structurally, over the sources _and_ over the built tree: no `WebAssembly`, no `iroh`, no `fetch`/`XMLHttpRequest`/ `WebSocket`, no `indexedDB`, and no `crypto.subtle` key operation. `digest` and `getRandomValues` are allowed and named — the first hashes a screenshot so the host's handle can be checked, the second is v0's own password generator.

## The eighteen methods

`contracts/extension/methods.json` is generated from v0's own two files by `contracts/tools/export-extension-methods.ts` and is the closed table on **three** sides: the native host compiles it in (`crates/centraid/src/cmd/native_host/methods.rs`, asserted against its enum), `src/methods.ts` re-exports the generated `src/methods-table.ts`, and `scripts/lint.mjs` checks every `type: "…"` this tree can send against it. A name that is not one of the eighteen is refused with a typed frame naming it, never answered with an empty value.

> **Eighteen, not seventeen.** Census §E2 calls this "the 17 companion methods" and then lists eighteen names; `handleCompanionRequest` has eighteen `case` arms. The generator asserts the count.

## The fill, and where the credential lives

```
the page        a trusted click on the picker the content script drew
the extension   locker:fill {itemId, pageUrl}  — NOT a seat: no vault, no K
the native host a local client of the seat, under the same peer-uid check
the seat        matches the row's own stored policy, unwraps K behind the
                member's unlock, receipts the fill, answers a value with a
                30-second life
the gateway     writes the access receipt — and never sees the password
```

Three things about that chain are worth stating because each is a refusal:

- **A popup cannot ask a Locker question.** Every `locker:*` message is judged against the **active tab's own origin** (v0's `assertTopFramePage`), and a popup has no tab, so its claim has nothing to check it against. The picker is drawn in the page, where a click is a trusted gesture.
- **The browser may lock the seat and may never unlock it.** _A door that can raise the passphrase prompt is a door that can be used to phish it._ The host refuses `unlock` and the seat refuses it again for `native-host` clients.
- **The material does not survive the round trip.** `HostLink.fillInto` asks, hands the value on (which structured-clones it across the process boundary), then clears this process's copy. `host-link.test.ts` asserts both halves — census §E seam 4 recorded that v0 does the clearing and _nothing tests that it happened_.

## Chunking, and where the bytes stop

Native messaging has a **1 MiB ceiling per message and no streaming**. A capture larger than `MAX_INLINE_BYTES` is staged: `stage:begin` → n × `stage:chunk` (512 KiB of raw bytes each, about 683 KiB of base64) → `stage:end`, which answers a **content-addressed handle** — a sha256 and a size, the shape `crates/apps/docs::bytes::StagedBlob` has and what `core.add_document`'s `staged_sha` takes.

Promoting that handle into the staging band is the **byte door**, which lane Docs landed as an app-crate trait with its implementation named as a hand-off. So `capture:document` carries the sha and the vault answers its own honest refusal until that door lands; `stage:end` says so in the frame (`claimed: false`, `pending: "bytes-door"`).

## The badge, and how stale it may be

> **Live while the port is open, and at most one minute otherwise.**

The host pushes the approval count when the seat's state changes, and the one-minute `chrome.alarms` entry is **kept as the fallback** — a push needs an open port and MV3 closes workers whenever it likes, so deleting the alarm in favour of the better mechanism would trade a bounded staleness for an unbounded one. `worker-core.ts`'s `BADGE_STALENESS` states both numbers and its test asserts this sentence against them.

## One port, closed when idle

Lane F opened a **native port per request** and gave a good reason: a native port holds a process. Two facts moved it (D-1020-X7): the seat's capability token is single-use, so one port per request means the shell minting a token per keystroke; and a pushed badge needs an open port. So the port is opened on first use and closed after 30 s of silence — the property lane F wanted, bounded by **use** rather than by request count.

## Setting it up

```sh
# Build the unpacked Companion for one browser.
bun run --cwd extension build -- --browser chrome --out dist/chrome

# Write the host manifest, with its extension-id allowlist.
cargo run -p centraid -- native-host install \
  --browser chrome --extension-id <32-char id> --out /tmp/dev.centraid.host.json
```

`native-host install` **never copies the manifest into a browser's directory**: a file that appeared under a browser's configuration because something was unpacked is a capability nobody chose to grant (the same rule `centraid gateway install` follows). It prints the directory to copy it to, per platform. An empty allowlist is refused: a host any extension may drive is a host that can read this vault.

**The id is a release artifact** (`contracts/extension/ids.json`). Firefox's is author-chosen and is pinned today; Chrome's is derived from a key the Web Store mints, so it is `null` with its reason rather than a placeholder. For a stable **dev** id, generate an RSA key once and put its base64 SPKI in the manifest's `key` field — Chrome derives the unpacked id from it, and `--extension-id` becomes usable before any store listing exists:

```sh
openssl genrsa 2048 | openssl rsa -pubout -outform DER | openssl base64 -A
```

## Proving the wire

```sh
bun run --cwd extension test        # the pure layer, in desktop/'s vitest project
bun run --cwd extension typecheck   # two programs: shipped (types: []) and tests
bun run --cwd extension lint        # the manifests and the method table
xvfb-run -a bun run --cwd extension e2e   # Chromium, unpacked, over a real port
cargo test -p centraid --test native_host # the host, against a real seat
node extension/scripts/native-round-trip.mjs
```

The Playwright run loads the unpacked build in Chromium, writes a native-messaging host manifest into the profile with the id Chromium derived, and points it at `e2e/fake-native-host.mjs` — a node script speaking the browser's framing. It is **headed**: the headless shell cannot load an extension at all, and it fails with an empty service-worker list rather than an error. The host's own half — the eighteen methods against a real seat — is `crates/centraid/tests/native_host.rs`, driving the same framing against `centraid native-host` and a real `centraid seat`.

## Owner hand-offs

- **Store enrolment** for the Chrome Web Store and AMO, and the ids that go in each browser's allowlist. Until an id is enrolled there is nothing to put in a manifest, and a manifest with a placeholder id is a manifest that silently does not work.
- **Registering the host with a real browser on a member's machine.** The verb prints the directories; which one an installer writes to (and whether the desktop installer should offer to) is a product decision.
- **How the browser's host gets its capability token.** The seat mints one per-turn token for the renderer to hand a child in its environment (D-1020-F14), and a browser-launched host does not inherit that environment. Today the host reads `CENTRAID_SEAT_TOKEN`, which works for a shell-launched host and for the tests; the member-facing gesture — "allow the browser extension to connect" in the shell, writing a 0600 grant the host redeems once — is named in the receipt and is the next thing this surface needs.
- **The Companion's icon.** The manifests name none, so browsers show a default; the mark is `packages/design`'s and a fabricated one would be worse than none.
- **Retiring v0's `companion` release row** — `contracts/handoff/extension/release-fanout.md`.
