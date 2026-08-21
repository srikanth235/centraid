# Issue #842 — product hardening: the other mechanisms

GitHub issue: [#842](https://github.com/srikanth235/centraid/issues/842)

Umbrella issue worked by orchestration ([docs/multi-agent.md](../docs/multi-agent.md)):
one receipt, no child issues; slices are sub-agents and commit waves under this
umbrella, landing on the same branch (and the same PR) as #839 by owner
instruction. Nine workstreams W0–W8. Items whose completion depends on an
external actor (money, enrollment, third-party accounts, multi-day wall clock)
land their code side here and are recorded in the blocked-external register
below rather than being claimed done.

## Checklist

W0 — re-arm what's already built:

- [ ] W0.1 `test:suite-wall-clock` wired into a lane that actually runs it
- [ ] W0.2 repo-wide diff-coverage `approvedDeviation` (#639) removed
- [ ] W0.3 `PendingRestartJourney.test.tsx` collects; collection-error tripwire
- [ ] W0.4 photos flows in the e2e-flows roster; roster discovered, not enumerated
- [ ] W0.5 `sendToFirstToken` measured and ceilinged; `projected` metrics seeded
- [ ] W0.6 SonarCloud wired or claim retired; dormant-bits sweep

W1 — the bytes survive:

- [ ] W1.1 Seeded crash-consistency lane over every registered fault point
- [ ] W1.2 `centraid doctor` (CLI verb + surface) + scheduled scrub
- [ ] W1.3 Automated restore drill (in-product + CI)
- [ ] W1.4 Backup-format archaeology corpus
- [ ] W1.5 Schema-migration corpus

W2 — hostile input:

- [ ] W2.1 Differential guard testing (three peer path guards agree)
- [ ] W2.2 Prompt-injection corpus against the agent loop (fake ACP)
- [ ] W2.3 Hostile-peer protocol harness
- [ ] W2.4 DAST lane (nightly)

W3 — time, network, disorder:

- [ ] W3.1 Network chaos on the tunnel plane
- [ ] W3.2 Composition-level chaos
- [ ] W3.3 Clock-skew + calendar-edge injection
- [ ] W3.4 Long-run soak rig (weekly)
- [ ] W3.5 Renderer leak testing

W4 — load and limits:

- [ ] W4.1 Composite-load rig
- [ ] W4.2 Stress-to-failure

W5 — compatibility and lifecycle:

- [ ] W5.1 WebKit project in web e2e
- [ ] W5.2 Windows/macOS path-gated CI jobs
- [ ] W5.3 Released-binary skew lane
- [ ] W5.4 Install/upgrade lifecycle lane

W6 — ship-time custody:

- [ ] W6.1 Apple notarization + signature-verified auto-update
- [ ] W6.2 Signed images, SBOM, provenance
- [ ] W6.3 CI egress control + dependency-behaviour layer

W7 — the running process:

- [ ] W7.1 Sandbox model runtime + handler workers
- [ ] W7.2 Rust-side lanes (cargo-audit/deny; unsafe-edge pass)

W8 — the field, and the spec:

- [ ] W8.1 Crash/anomaly ledger + redacted diagnostics bundle
- [ ] W8.2 Mobile resource evidence ledger seeded
- [ ] W8.3 External reviews scheduled; formal-model note

## What changed

(Filled per wave as slices land.)

## Blocked-external register

(Items whose completion requires an external actor; the code side lands, the
external half is named here with what unblocks it.)

## Decisions

(Dated root-agent rulings for this umbrella.)

## Audit

(The single fresh-context audit covering #839 and #842 lands its verdicts
here at the end of all waves.)
