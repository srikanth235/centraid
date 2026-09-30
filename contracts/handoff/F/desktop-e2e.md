# Lane F → lane G: the two desktop gate steps

**Status: already applied.** Lane G had landed by the time lane F reached this point, so the steps were spliced into `crates/xtask/src/gate.rs` directly rather than handed over as a patch — the route the umbrella's state block named as preferred once G was done. This note is the record of what was added and why, so a reader of `gate.rs` does not have to reconstruct the reasoning from the diff.

## `desktop-unit` — profile `pr`

```
step("desktop-unit", run_desktop_unit)
```

Runs `bun run --cwd desktop/electron test` (the vitest project over `desktop/electron`, `desktop/renderer` and `extension/src`) and then `bun run --cwd desktop/electron typecheck` (three tsconfigs: main, the test program, the renderer). Both are single-digit seconds on a warm tree.

**Why it is in `pr` and not only in `nightly`.** Every `electron`-importing module in this tree has a pure `-core.ts` twin, which is v0's own split and the reason the logic is testable without a display. Those twins hold the decisions a reviewer cares about — what quit does and in what order, whether a 416 or a retryable 503 answers an arriving blob, whether a refusal becomes an empty page — and none of them needs a window. Deferring them to nightly would mean a PR could change the shape of the product's teardown and go green.

**Why it is a separate vitest project and not a row in the repository-wide `vitest.config.ts`.** That list drives the v0 coverage run scored against `tests/floors.json`. Adding a new tree to it moves coverage numbers for reasons that have nothing to do with the v0 oracle it measures, which is a ledger change disguised as a test addition.

**Budget.** Measured 1.9 s for the vitest run and 6.4 s for the three typechecks on a warm tree; `pr`'s ceiling is 1500 s and this lane's addition is under 1% of it. `contracts/ledgers/gate-budgets.json` was not touched — the numbers there are down-only and `measure --write` owns them.

## `desktop-e2e` — profile `nightly`

```
step("desktop-e2e", run_desktop_e2e)
```

Builds `centraid` (debug), builds the app, and runs Playwright over a real Electron process:

```
cargo build -p centraid
bun run --cwd desktop/electron build
xvfb-run -a node_modules/.bin/playwright test -c desktop/e2e/playwright.config.ts
```

**Why nightly.** It compiles a binary and launches a browser — tens of seconds either side of the assertion — and what it proves is a claim about Chromium's media stack rather than about the diff.

**The three prerequisites are reported as themselves**, never as one "it did not run": the binary, `bun`/`node`, and a **display**. Electron has no real headless mode, so the step uses `xvfb-run` when `DISPLAY` is unset and it is available, and **fails with the install command** when neither is there. A browser test that read green with no window would be the loudest kind of lie, which is why this is a `Failed` and not a `Skipped`.

`PLAYWRIGHT_BROWSERS_PATH` is passed explicitly (defaulting to `/opt/pw-browsers`), so a run cannot silently download its own browser copy into `$HOME`.

## The demonstrated reds

Each step's subject was broken and the failure observed, then reverted:

| What was broken | Step | What failed |
| --- | --- | --- |
| the blob door answers `Unsatisfiable` where it answers `NotYet` (`crates/centraid/src/cmd/seat/blob.rs`) | `test` | `cmd::seat::blob::tests::an_arriving_blob_serves_its_prefix_and_says_not_yet_past_it` — FAILED, 82 passed 1 failed |
| the peer check returns `Ok(peer)` unconditionally (`crates/centraid/src/cmd/seat/peer.rs`) | `test` | `cmd::seat::peer::tests::the_owning_uid_is_admitted_and_a_second_uid_is_refused` — FAILED |
| the media door answers `416` instead of `503` for an arriving blob (`desktop/electron/src/main/media-response-core.ts`) | `desktop-unit` | `the statuses > is 503 with Retry-After — never 416 — for a range inside a declared total` — 1 failed, 113 passed |

## What lane G may want to change

- `gate-nightly.yml` needs `xvfb` on the runner for `desktop-e2e` to do anything but fail. On a hosted `ubuntu-latest` that is one `apt-get install -y xvfb` step, or the step can be left to fail loudly until the runner carries it — lane G owns that call, and either is honest.
- `desktop-unit` needs no tool `pr` does not already have.
