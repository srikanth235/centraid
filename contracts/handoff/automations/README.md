# Hand-offs — lane automations (#1020, wave 4)

Two files this lane needs and does not own.

## `api-proto.patch` — the fourth `Event` arm

`centraid.core.v1`'s `Event` oneof carries `change`, `health` and `connectivity`. A system signal is none of those: `HealthEvent` is a queue sample and `ConnectivityEvent` is a transport state, so a signal delivered through either would be a fact wearing the wrong shape.

`crates/api-proto` is a shared file with no wave-4 app-lane owner (census §Cross-lane), so the arm ships as a patch rather than as an edit made from inside one lane. `centraid_automations::signals::SignalSink` is the seam in the meantime, and the crate logs nothing instead of signalling — see [D-1020-AU7](../../../receipts/issue-1020-v1-platform.md).

**The demonstrated red**: with the patch applied and no lowering written, `crates/core`'s event-queue test that every `Event` kind round-trips through the queue fails on the new arm, because `coalesce_into` matches only `Change`. That is the failure the lowering has to answer, and it is why the patch is a patch and not a one-line proto edit.

## `gateway-scheduler.md` — the host that ticks

`crates/automations` holds no timer: `CursorEngine::tick` is a function a host calls with an instant, `fire::register` is a function a host calls with a manifest's triggers, and `centraid automations deliver` hands a webhook body over with nowhere yet to hand it. The scheduler host — the thing that ticks once a minute, reconciles registrations against the app folders, drains `trigger_ingress` and nudges on a change — belongs to the gateway lane. This file names what it must call and in which order.
