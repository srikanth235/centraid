# Receipt — issue #790: live and hardware test rigs

## Checklist

- [x] Audit every #790 skip and deterministic-environment entry against the
      workflows that actually invoke it.
- [x] Record the current named rigs and their exact commands in `TESTING.md`.
- [x] Correct stale inventory prose for the native relay and byte-plane lanes,
      which already run in required Linux CI.
- [x] Re-home every listed live/hardware skip and env-red citation to #790.
- [ ] Provide a mutable macOS user-session rig for launchd install/uninstall.
- [ ] Provide a real full-filesystem rig (APFS image or Linux loop device).
- [ ] Provision the Clawgnition checkout and `.dev.vars`; the weekly workflow
      currently sets the env flag but collection-skips on a clean runner.
- [ ] Provide real harness binaries for live automation failover.
- [ ] Provide an uncontended native SQLite runner for strict mobile perf.
- [ ] Provide a named APFS/btrfs/xfs reflink runner.

## What changed

`TESTING.md` now carries the current-state rig table. Five claims have effective
named evidence: native QUIC relay and the TypeScript/Rust byte-plane contracts
run in the required Linux `verify` job; the 10 GiB restore has its isolated
`restore-year3` nightly job; and exact fsync counts run with required `strace`
in PR and nightly performance lanes. `tests/skips.json` no longer says Linux CI
lacks the native module or omits the byte-plane contracts.

The table also records the blockers rather than deleting their gates. In
particular, `interop-weekly.yml` sets `CLAWGNITION_INTEROP=1` but neither checks
out `CLAWGNITION_REPO` nor supplies `apps/gateway/.dev.vars`; the suite's
collection-time guard therefore skips it on a clean GitHub runner. Issue #790
must remain open while the unchecked rig items above remain.

Checklist crosswalk: Audit every #790 skip and deterministic-environment entry
against the workflows that actually invoke it. Record the current named rigs
and their exact commands in `TESTING.md`. Correct stale inventory prose for the
native relay and byte-plane lanes, which already run in required Linux CI.
Re-home every listed live/hardware skip and env-red citation to #790.

Changed paths for this issue:

```text
TESTING.md
tests/skips.json
packages/gateway/src/routes/owners-routes.test.ts
receipts/issue-790-live-hardware-rigs.md
```

## Out of scope

No environment gate was removed, no skip or env-red budget was widened, and no
physical/privileged rig was claimed from this unprivileged development session.
Provisioning credentials, hardware-backed filesystems, mutable launchd state,
or external harness installations requires operator-owned CI resources.

The owner-route test also received a strict tuple annotation so the current
main typecheck does not infer possibly-undefined sort keys; its runtime
assertion and behavior are unchanged.

## Decisions

- Existing required workflow invocations count as named rigs even though the
  focused test still self-skips in an ordinary local full-suite run.
- A workflow name alone is not a rig: the Clawgnition job remains blocked
  because its clean-runner preconditions are absent.
- The remaining `tests/skips.json` and `tests/env-red.json` entries stay intact;
  closing a tracker is never grounds to erase an unprovided environment.

## Verification

```sh
rg -n "CENTRAID_RUN_NATIVE_TUNNEL|test:data-plane|strace|CENTRAID_SCALE_RESTORE_GIB" .github/workflows packages/tunnel/package.json
# native + byte-plane in required Linux verify; strace in PR/nightly;
# restore-year3 sets CENTRAID_SCALE_RESTORE_GIB=10

rg -n "CLAWGNITION_REPO|DEV_VARS_FILE|CLAWGNITION_INTEROP" packages/backup/src/interop-clawgnition.test.ts .github/workflows/interop-weekly.yml
# workflow sets the flag; suite requires an unprovisioned checkout + .dev.vars

bun run test:matrix
# green: 15 surfaces × 11 dimensions; 30 inventoried skips
```

## Audit

PASS — `/root/receipt_audit_790_791` verified the receipt against issue #790
and the current diff: the checked inventory, documentation, correction, and
citation work is present; unavailable rigs remain truthfully unchecked. The
separately disclosed owner-route tuple annotation is type-only, path-covered,
and preserves the green runtime assertion.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |
