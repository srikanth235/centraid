# `desktop/` — the Centraid desktop seat

One Electron window, one `centraid seat` child process, one local socket between them. Part of the v1 platform ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane F); the v0 desktop under `apps/desktop/` is the pinned oracle this was ported from and is not edited.

```
desktop/
  electron/    main + preload. Spawns and OWNS the sidecar, holds the socket,
               answers `centraid://`. Every module with an `electron` import has
               a pure `-core.ts` twin with unit tests.
  renderer/    the thin client. No credential, no socket, no network.
  e2e/         Playwright over a real Electron app and a real sidecar.
```

## The two modes

`centraid seat` runs one of two ways, and **the socket surface is identical** — that is the whole claim, and the renderer does not branch on it:

| Mode | What it is | What the shell shows |
| --- | --- | --- |
| **replicated** (default) | a full local mirror: its own vault file, its own outbox | reads offline, and says when what it shows may be behind |
| **thin** (`--thin`) | no local rows; every call is forwarded to the gateway **under the caller's principal** | reads only while the gateway answers, and says "nothing to show" when it cannot |

The shell picks with `CENTRAID_SEAT_THIN=1`. What differs between them is not the API but the **four states** below, and the shell draws those.

> The thin _forwarding_ itself is `crates/core`'s (`Role::Seat { kind: Thin }` answers `Unavailable` for anything the local file cannot serve until the gateway is dialled, which is wave 4's lane). This tree chooses the role and reports the state honestly rather than claiming a forward that does not happen yet.

## The four states

The sidecar sends them as **one** message, not four subscriptions, because they are read together — a shell with availability and no durability draws a different screen from one with both, and two arrivals means one frame drawn from a state that never existed.

| State | Values | Where it comes from |
| --- | --- | --- |
| **availability** | `local` · `forwarded` · `unavailable` | the mode, and whether the file or the gateway can answer |
| **durability** | `settled` · `local-only` · `none` | the outbox depth and the gateway's acknowledgement |
| **pending work** | `outbox`, `behind`, `stalled` | the core's own events — the outbox, the log watermark, the bounded event queue's stall flag |
| **connectivity** | `online` · `offline` · `unconfigured` | the core's connectivity events |

Two things about that table are deliberate:

- **`unconfigured` is not `offline`.** On first run the member has not chosen a gateway; telling them they are offline sends them looking for a network problem they do not have.
- **`unavailable` is not an empty list.** A thin seat that has lost its gateway knows _nothing_ about what the vault holds, so the screen says so with a reason. Every list here has three states — starting, nothing-to-show, rows — and `readState` is the only thing that decides which, so there is no `empty` branch to fall into.

v0 broadcast **connectivity only**, from a 5 s health poll in main. Durability and pending work have no v0 broadcast to extend, and they do not get a poll either: they are facts the core already tells us, and a poll would be a third source of truth for something the writer already said.

## The socket contract

`<userData>/seat.sock` — a Unix domain socket, **mode 0600 in a 0700 directory**, with a **peer-uid check on every accepted connection** ([R-1020-26](../docs/decisions.md)). On Windows the door is a named pipe with a DACL for the current user, and that is an **owner hand-off**: there is no Windows machine in this lane, and `centraid seat --socket` refuses to run there rather than opening an unprotected pipe.

**There is no bearer token.** v0's renderer carried one, which is why `SETTINGS_GET` had to strip it and `GATEWAY_AUTH_GET` had to be its single crossing. Here the socket _is_ the credential and main holds it, so the renderer is handed no credential at all and that rule cannot be broken.

### Frames

`u32BE(length) ‖ channel ‖ payload` — `crates/protocol`'s framing, with a channel byte:

| Channel | Body | Who speaks it |
| --- | --- | --- |
| `0x00` | a `centraid.core.v1.Envelope`, byte-identical to what crosses iroh | native clients (`centraid mcp`, a Rust test) |
| `0x01` | one UTF-8 JSON message | this window's Electron main |

The local channel is **not** in `centraid.core.v1`, and that is the design rather than a shortcut: every message on it names something that cannot exist on a remote wire — a peer uid, a byte offset into a file this process can see, a capability token for a child process on this machine. `centraid.core.v1` carries a `buf breaking` FILE promise to seats that update on their own schedule, and putting local-only messages under that promise would commit the gateway to a shape no remote peer can ever receive.

### Who may connect

Three local client kinds. The socket's mode and the peer check say _who_ (this uid); the handshake says _which local program_:

| Kind | Proves | Why |
| --- | --- | --- |
| `renderer` | the **instance nonce** the sidecar was spawned with, read from a 0600 file | so a shell belonging to another install of the same product cannot adopt this seat |
| `mcp` | a **per-turn capability token**, single-use | `centraid mcp` is a stdio child of the shell and has no listener of its own ([D-1020-AS2](../docs/decisions.md)); the shell mints a token and puts it in the child's environment |
| `native-host` | the same | a browser-launched process runs as the member, so uid alone cannot say _which_ local program is asking |

A token is minted by the **renderer only**, is clamped to ten minutes, and is **spent on redemption** — so a token read out of a child's `/proc/<pid>/environ` by a second child of the same uid buys nothing. Ten distinct refusal codes, each with its own sentence: a member's next action differs between "another install owns this socket" and "your shell is from a different build".

### Reads are NAMED, never composed

The wire carries a **statement name** and the sidecar holds the shapes (`contracts/desktop/socket-catalogue.json` pins them; `centraid seat --print-catalogue` prints them). The renderer is the part of this product that runs app-authored JSX, and a read it can compose is a read an app can compose.

### Adoption

A socket path that already exists may be **live and somebody else's**. It is probed with the protocol's own handshake:

| The probe says | What happens |
| --- | --- |
| `hello_ok` | a seat for this install is already serving: adopt it, exit 0 |
| `refused` | another install's live socket: refuse, exit 1, **never unlink** |
| connect fails | a stale file from a process that died: unlink and bind |

## What quit does

**Quit stops the seat.** v0 deliberately leaves a detached gateway running, because a gateway is a daemon with other clients; a seat process whose only client is this window is _owned_. The sequence is a list, and the order is the content:

1. **dispose** the supervisor — first, so a mid-teardown auto retry cannot resurrect a closing seat.
2. the protocol's **terminal command**, so the seat closes the core deliberately.
3. **await** the seat's `closing`. This is where the vault's last write lands; signalling first would be the process-death case on purpose instead of by accident.
4. `SIGTERM` → 5 s → `SIGKILL` — v0's escalation, unchanged. A bare pid, not a process group: this child is not `detached`, so `-pid` would signal the shell's own group.
5. **await the exit**, before anything reuses the socket path.
6. **unlink** the socket, last.

`desktop/electron/src/main/sidecar-supervisor-core.ts` states the list and its test asserts the order; `desktop/e2e/seat.e2e.ts` asserts that the process is really gone and the socket file really went with it.

## `centraid://` — the media door

`centraid://blob/<sha256>` , answered by `protocol.handle` in main out of the seat's blob store. Local-only and in-process: there is no loopback port and nothing on the network, which is what replaces v0's `webRequest` `Authorization` injector — a subresource load needs no header when the scheme itself is only answerable inside this window.

- `Accept-Ranges: bytes`, `206` with `Content-Range`, `ETag` = the blob digest.
- `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, and `text/html`, `application/xhtml+xml` and `image/svg+xml` are **never inline**: blob bytes may be attacker-authored.
- `Cache-Control: immutable` **only once the blob is complete**. A prefix cached forever is a truncated video that survives a restart.
- For a blob still arriving: a range inside the received prefix is served; a range that straddles its end is served **short**; a range past it **waits on the writer** and then answers `503` with `Retry-After`, never `416`. A `416` means "that range does not exist" and a media element that gets one stops asking, permanently.

The `Range` **grammar lives once**, in the sidecar (`crates/centraid/src/cmd/seat/blob.rs`), and the header crosses untouched: two copies of that grammar is how `bytes=-10` starts meaning different things at each end.

## Running it

```sh
# The binary the shell spawns.
cargo build -p centraid

# Build main, preload and the renderer.
bun run --cwd desktop/electron build

# The pure cores and the three type programs.
bun run --cwd desktop/electron test
bun run --cwd desktop/electron typecheck

# The Playwright run. Electron has no real headless mode, so a display is
# needed; `xvfb-run -a` is what CI and a container use.
cargo build -p centraid && bun run --cwd desktop/electron build
xvfb-run -a node_modules/.bin/playwright test -c desktop/e2e/playwright.config.ts

# Or through the gate, which does all of the above:
cargo xtask gate --profile pr        # `desktop-unit`
cargo xtask gate --profile nightly   # `desktop-e2e`
```

`desktop/**` is deliberately **not** a member of the bun workspace or of the repository-wide vitest project list: that list drives the v0 coverage run scored against `tests/floors.json`, and adding a new tree to it would move coverage numbers for reasons that have nothing to do with the v0 oracle it measures. The v1 gate entrypoint is `cargo xtask gate`, which runs both suites by name.

## Owner hand-offs

- **macOS and Windows runs.** Everything above is proven on Linux under Xvfb. The commands are the ones in _Running it_; on Windows `centraid seat --socket` exits 3 with the named-pipe hand-off until its DACL door is written and observed to refuse somebody.
- **Signing and notarisation** stay enrolment-gated (`.github/workflows/lane-release-desktop.yml`, `docs/enrollment.md`), and the updater's trusted-key set stays **empty** — so every packaged update refuses with `no-trust-anchor`, which is the fail-closed state and not a gap.
- **The browser host manifest** is written by `centraid native-host install --browser chrome|firefox --extension-id <id> --out <path>` and **copied by a person** into the directory the browser reads. A file that appeared under a browser's configuration because something was unpacked is a capability nobody chose to grant.
- **Mounting the v0 app UIs.** `packages/blueprints/apps/{tally,photos}/ app-inline` take v0's `@centraid/client` context — a gateway HTTP client, an SSE change feed, a design-token provider — so mounting them is adapting that context rather than a data source. This tree ships the screens over the same named reads; the parity claim is kept by `desktop/renderer/src/apps/tally/fold.test.ts`, which compares this dashboard's fold against `contracts/apps/tally/queries.json` case 0 field by field.
