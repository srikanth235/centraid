# `crates/assist` — the assistant plane

What runs where, what is data, and what is a hand-off (#1020 wave 4, lane
assist). The rulings this crate implements are `D-1020-AS1` … `D-1020-AS9` in
[`receipts/issue-1020-v1-platform.md`](../../receipts/issue-1020-v1-platform.md);
the current-state doc for the harnesses themselves is
[`docs/harnesses.md`](../../docs/harnesses.md).

## What runs where

```
  the member's shell                the gateway                 the harness
  ──────────────────                ───────────                 ───────────
  Settings → Agents  ──────────▶  registry (data)
                                  preflight (--version, 24 h)
  "ask the assistant"  ──────────▶ TurnPlane::run_turn
                                    │  consent asked FIRST
                                    ▼
                                  acp::agent_for  ─── spawn ──▶  codex / grok /
                                    │                            opencode / …
                                    │  ◀── session/update ──     (an external
                                    ▼                             process)
                                  ledger (crates/vault)              │
                                    conversation ⊃ turn ⊃ item       │ spawns
                                                                     ▼
                                                            centraid mcp
                                                            (stdio, no port)
                                                                     │
                                                              seat socket
                                                              (lane F's)
```

Three processes, and the arrows only go the way they are drawn. The harness is
**never** in-process: nothing here is a model, an inference loop or a provider
client. The gateway spawns a CLI that speaks the Agent Client Protocol on its
stdin and stdout, implements the protocol's `Client` half, and writes what comes
back into the ledger.

## The registry is data, and nothing else branches on the kind

Seventeen kinds live in
[`contracts/assist/harnesses.json`](../../contracts/assist/harnesses.json),
generated from v0's `registry.ts` by
`contracts/tools/export-harnesses.ts`. They differ only in *how the process is
launched*, and [`registry::LaunchPlan`](src/registry.rs) is the one answer this
module gives. The turn plane, preflight and model enumeration take a
`LaunchPlan` and have no opinion about the kind that produced it — so a
`match kind` anywhere outside `registry.rs` is a bug, and a grep for one is the
test.

Two lists, both carried: `HARNESSES` has 17 entries, `SUPPORTED_HARNESS_KINDS`
has **five** (`codex, claude-code, opencode, grok, pi`). Twelve registered kinds
are launchable and not in the supported list. Keeping one list would mean either
dropping twelve working kinds or claiming support for twelve nobody verified.

Two arguments are **refused** rather than documented: `--mdns` for opencode
(it defaults its listen host to `0.0.0.0`, publishing an unauthenticated
code-execution harness to the LAN) and `--port` for copilot (stdio only). They
were prose comments in v0; a comment cannot stop a member typing one into the
extra-args box.

## The two adapter kinds

Fifteen kinds speak ACP natively and need only a process spawn. **`codex` and
`claude-code` do not**: each speaks the protocol through a pinned npm package,
so the process actually spawned is `node <adapter>/bin.js` and the member's own
`claude`/`codex` binary is passed to the adapter through an environment variable
(`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). `claude-code` additionally runs in
`bypassPermissions`, because a gateway turn has no approval UI and the default
mode deadlocks.

That is the one runtime dependency the Rust gateway cannot satisfy itself, and
it is handled by **discovery, never by fetching**:

1. `CENTRAID_ACP_ADAPTER_DIR`, for a packaged build or an operator.
2. `<data-dir>/acp-adapters`, where `centraid assist adapters install` points.

`npx -y` at turn time is ruled out: it is an unreviewed download in the hot path
of a door that has the member's vault open, and it fails on an aeroplane. (The
`agent-client-protocol` crate's own `AcpAgent::claude_agent()` convenience
constructor does exactly this. It is not used.) When no adapter is present,
preflight reports those two kinds unavailable *with the install verb in the
hint* — warn, never block; the other fifteen still work.

## The stdio MCP shape

v0 served three vault tools over a **loopback HTTP MCP server** on an ephemeral
port, with a per-turn bearer token, because ACP's `type: "acp"` MCP transport is
experimental and neither first-party adapter implements it while both advertise
HTTP MCP. It was careful, and it was still a listening socket in a product whose
invariant is that there are none.

`centraid mcp` serves the same three tools and the same five methods over
**stdin and stdout**. The harness launches it as its own MCP child through the
`mcpServers` entry of `session/new`:

```json
{ "command": "/usr/local/bin/centraid",
  "args": ["mcp"],
  "env": { "CENTRAID_SEAT_SOCKET": "…/seat.sock",
           "CENTRAID_TURN_TOKEN": "…" } }
```

Nothing binds, nothing listens, and the tools stay generic across kinds because
stdio MCP is better supported than HTTP MCP, not worse. The per-turn secret gets
*stronger*: instead of a bearer in a header it is a capability token the shell
mints, presented to the seat socket, which also checks the peer's uid — so a
token that leaked to another account on the machine still does not work.

`unstable_mcp_over_acp` exists in `agent-client-protocol` 2.1.0 and is
**recorded, not enabled**: it is the future collapse of this whole module into
the ACP connection itself, and it stays unadopted while it is unstable and while
the adapters do not implement the transport it needs.

## Consent is a property of the posture

[`turn::TurnPlane::run_turn`](src/turn.rs) asks the posture's consent **before**
it touches the dispatcher. No process is spawned, no session is opened, nothing
leaves. The refusal is typed and names the kind and the egress class.

`TurnPosture` cannot be constructed without an `EgressConsent`, and the consent
is a closure asked at dispatch time rather than a boolean captured earlier — a
member who revoked a grant since the conversation opened has revoked it. An
absent answer is a refusal: a posture that forgot to wire consent fails closed.

`permission_policy` is `auto-allow` or `deny` and **never a prompt**.

## What is a hand-off

Three things this slot could not finish in its own files, each with the shape
the fix needs. They are in the receipt with their evidence; in one line each:

1. **The park gate.** `CommandDefinition::confirm` is carried, documented and
   never read, so a confirm-gated command from a non-owner executes instead of
   parking. Four of the #842 corpus's fourteen payloads are about exactly that,
   and they are deferred with a test that **fails the day park lands**
   (`crates/assist/tests/prompt_injection.rs::the_park_gate_is_still_missing`).
   Needs a third `CommandStatus` and a wire enum value — `crates/api-proto` and
   `crates/core/src/api.rs`, another lane's files this slot.
2. **`vault_sql` over the seat socket.** The local channel carries *named* reads
   and commands on purpose — a renderer cannot compose a read the seat did not
   ship — and no message carries a free-form statement. The grammar, the row cap
   and the principal check are implemented
   ([`centraid_vault::ledger::sql_guard`](../vault/src/ledger/sql_guard.rs)); the
   transport is lane F's successor's.
3. **The `prompt-injection` gate step.** Applied locally in its own commit and
   also filed as
   [`contracts/handoff/assist/gate.patch`](../../contracts/handoff/assist/gate.patch),
   because `crates/xtask` is another lane's this slot.

## The SQL is not here

`sql-confinement` allows SQL under `crates/{ontology,vault,seat,search}` and
`crates/apps/kit`. The ledger band's **statements** therefore live in
[`crates/vault/src/ledger/`](../vault/src/ledger/) — a module this slot owns,
with a header saying so — and this crate owns the band's **meaning**: what a
posture is, when a breaker opens, what a turn costs, what gets archived. The
rule's file list was not widened; the assistant plane was arranged to fit it.
