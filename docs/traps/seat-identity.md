# A seat file's identity, and who owns its cursor

Two footguns that cost the same thing — a member's queued writes — and neither looks like a bug while you are writing it. Both were paid for by [#1014](https://github.com/srikanth235/centraid/issues/1014) (finding R25), under ruling [R-1014-11](../decisions.md#replication-offline-and-sharing-1014).

## 1. There is no stand-in for a gateway id

A seat file is named after the pair `(gatewayId, vaultId)`: `centraid-seat-<hash(gatewayId, vaultId)>.sqlite3` (`apps/mobile/src/lib/replica/native-seat-path.ts`). The name is not a label on the file — it is the only thing that tells two vaults', or two gateways', copies apart.

So a placeholder gateway id is not a placeholder. It is a **different file**. The shipped code used the literal `"manual"` when a mount had no endpoint id yet, opened that file, took the member's writes into ITS `seat_outbox` — and then, the moment a real endpoint id arrived, rewrote the link and **moved the path**. Every write queued before that moment stayed in a file nothing would ever open again: undrained, unreported, and (because storage accounting was looking for a different prefix) invisible on the storage screen too.

**The rule.** A mount resolves its gateway id before it names a file, or it refuses — `SeatGatewayUnresolvedError`, which is a WAITING state the next reachability wake retries, not a failure. `noteActiveIdentity` may FILL an empty gateway id and must never rewrite a resolved one; a different gateway answering for a link is a new link, not a rename.

**What this generalises to.** Anything else keyed by that pair — the last reachable base URL, a scope cache, a freshness stamp — is per gateway too. One global "last base" across two paired desktops is the same bug wearing a different hat: vault B's seat, feed and intent drain all open at gateway A's port, and the applier's epoch check is the only thing in the way.

## 2. A cursor with two owners is a cursor with none

The seat's applied position (`seat_state.applied_seq`, written in the applier's own transaction alongside the rows it names) is the only resume cursor on the device. `apps/mobile/src/lib/replica/native-session.ts` says so in its opening comment, and it is true because the SSE feed is a **wake, not a delivery** — a frame means "the gateway moved", and the answer is one catch-up.

The multiplex feed kept a second cursor anyway: durable, debounced, and keyed by `gatewayId ?? baseUrl` — a value `updateGatewayBase` mutates mid-session. So every launch orphaned a key, the gateway was sent a position nothing ever reconciled with `applied_seq`, and the write had to be flushed on teardown to avoid regressing a number no one owned.

**The rule.** If the seat can answer the question, ask the seat. A second durable copy of a position is not a cache; it is a second source of truth that drifts, and the drift shows up as changes that silently never arrive. The feed now reads the seat's watermark on every connect, fresh — not cached, because a catch-up between two reconnects is exactly the case a stale copy would send the gateway backwards for.

**The matching half:** a cursor whose epoch merely DIFFERS is not a newer cursor. Accepting one moves the scope onto a stream it is not on, and every later frame of the real epoch then looks "different" too and is taken as well. An epoch change is legitimate exactly twice: before the scope has a position, and after the gateway has said `rebootstrap`.

## How it presents

Neither of these looks like itself from the outside. R25 presented as a network problem: a standing "Can't reach your vault" banner, an empty library, a Photos card explaining that photographs live on the gateway — on a phone with a healthy connection to a healthy gateway that was serving the other mount throughout. If a mount looks offline while another mount on the same gateway is fine, suspect identity before you suspect the network.
