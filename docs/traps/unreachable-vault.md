# Trap: a vault that never answers reads as a vault that is fine

## What goes wrong

Kill the gateway under a phone that is otherwise online. The radio does not move, no error is drawn, and the seat goes on saying everything is well — indefinitely:

| Surface | What it said with the vault dead |
| --- | --- |
| Home | `Everything's uploaded` |
| Docs caption | `Everything here is on this gateway and on this device` |
| A change saved on the phone | `Sending this change.` |

The second one is the sentence a member reads before deleting their own copy of something. None of [mobile-offline.md](../mobile-offline.md)'s foreground states — `Offline on this phone`, `Gateway asleep`, `Syncing recent changes…` — appeared on any surface.

## Why

Three assumptions, each reasonable alone:

1. **Reachability was re-read only on a radio event.** `Network.addNetworkStateListener` was the trigger; a gateway dying is not a network-state change, so nothing asked again.
2. **`resolveGatewayBase()` does not probe.** It returns the tunnel's address or the saved URL. Deriving "connected" from it means "a URL exists", not "a vault answered" — so every pass re-asserted reachability it had not earned, and a state that had just settled to `gateway-asleep` came back to life.
3. **Gateway requests had no deadline.** The phone reaches its vault through a tunnel listener **inside its own process**. When the peer is gone that listener still accepts, so a request neither succeeds nor fails — it hangs. `pullScopes()` never returned, so the pass that "MUST settle" never did, and the write drain sat in `sending` on an intent it could not deliver.

Together they made a dead vault indistinguishable from a healthy one, and the one component that knew — the change feed, whose stream had ended — swallowed the failure under a comment saying `ReplicaProvider` would report it.

## The invariants

> A gateway request runs under a deadline. Time to first byte only: a vault streaming a large page is plainly reachable; one that has not begun to answer has said nothing. (`apps/mobile/src/lib/replica/gateway-deadline.ts`)

> A pass that has not asked the gateway anything may lower reachability and never raise it. Only an answer may say a vault is reachable. (`attemptedReachability` in `apps/mobile/src/kit/replica/replica-status.ts`)

> Whoever is actually talking to the gateway reports what they saw — the change feed for a member who only reads, the write drain for one who writes. They decide nothing; they ask `refreshReachability` to look again.

## What does not catch it

No lane owns "the vault goes away under a running app". The mobile integration tier asks what the session reports rather than what the screen says, and every test transport fails fast — none of them hangs, which is the whole defect. It was found by killing a real gateway under a real phone and watching.

Nothing here is specific to Docs or to Photos: the copy defects were spread across four surfaces because they all read one reachability value.
