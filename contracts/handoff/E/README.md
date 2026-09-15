# `contracts/handoff/E` — what lane E hands to lane G

Lane G owns the shared files: `crates/xtask/src/{gate,rules}.rs`, the ledgers, `.github/workflows/gate*.yml`, `Cargo.toml` and `Cargo.lock` (census wave 3 §Cross-lane). Lane E delivers **one named step function plus its demonstrated red**, as a patch, and G splices it at the checkpoint.

| File | What it does |
| --- | --- |
| `mobile-jvm-step.patch` | turns `Profile::MobileJvm` from a ledger placeholder into a real profile with one step, and widens `commonmain-no-platform-import` to `mobile/core` |
| `device-lane-bodies.md` | the four `run:` bodies for `gate-nightly.yml`'s device lanes |
| `release-yml.patch` | drops the two retired EAS secrets from `release.yml`'s call |
| `findings.md` | what lane E found outside its own slice, each with a proposed patch |
| `measured.md` | the numbers `cargo xtask measure --write` should write |

## Apply it, or let E apply it

The brief says the patch may be applied by lane E in one commit touching only `gate.rs` and `rules.rs`, now that G has landed. **Lane E did not apply it**, and the reason is a real one rather than caution: `Profile::MobileJvm`'s refusal message, its two null ledger rows and its unit test (`gate.rs:1830`, `a ledger placeholder`) are one design that lane B2 wrote (D-1020-B2-3), and flipping it means editing that test and both ledger rows in the same breath — which is three of G's files, not one. The patch is complete and applies cleanly to the umbrella head; G splices it with the ledger write in the same commit, which is the only way the refusal and the numbers change together.
