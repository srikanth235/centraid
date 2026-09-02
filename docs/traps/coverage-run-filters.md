# Trap: filtering a coverage run

## What goes wrong

Re-measuring one tree's coverage floor looks like a filtered vitest run. Two of the three obvious ways to filter silently produce a **higher** number than the truth, and the third produces no number at all:

| Filter | Coverage roots | Denominator | Result |
| --- | --- | --- | --- |
| `--project <name>` | collapsed to that project's root | only files the run **executed** | silently over-measures |
| positional path filter (`packages/blueprints/ apps/mobile/`) | stays `[repoRoot]` | every file the root `include` globs match | honest |
| any filter, run fails | — | — | no report written at all |

`--project` narrows more than the test selection: v8 coverage roots follow the project, so files under it that no test imported never enter the report. A floor re-seeded from that run is seeded against the covered files only, and the missing denominator reads as coverage that does not exist. Positional path filters select test **files** without touching the coverage roots, so untested sources stay in every denominator and a filtered run can only ever UNDER-measure relative to the full `bun run coverage` — the safe direction for a seed.

`coverage.reportOnFailure` defaults to `false`. A filtered run trips every floor belonging to the packages it did not touch, so it exits non-zero and vitest writes nothing to `coverage/` — leaving whatever the previous run left behind, which is easy to read as this run's answer.

## The invariant

> A coverage number quoted in a floor, a receipt, or `approvedDeviation` must come from a run whose coverage roots are the repo root. Filter by path, never by project, and pass `--coverage.reportOnFailure` so a threshold failure still produces the report.

## Correct remediation

```sh
# dist/ must exist for the packages the suites import
bun run --cwd packages/server build

# From the repo root, with the root config
node node_modules/vitest/vitest.mjs run --coverage --coverage.reportOnFailure \
  packages/blueprints/ apps/mobile/

# Then blend per-file totals over the scope's globs
# (coverage/coverage-summary.json), never the printed "All files" row.
```

The run exits non-zero. That is expected — the untouched packages' floors fail — and it is exactly why `--coverage.reportOnFailure` is not optional here.

## How agents get it wrong

1. **`--project` to "just run the blueprints"** — the report loses every unexecuted file and the measurement comes out points too high.
2. **Reading a stale `coverage/` after a failing run** — no report was written; the numbers belong to some earlier run.
3. **Quoting the terminal `All files` row** — that is the whole repo-root include, not the scope being floored; blend the per-file totals for the scope's globs.
4. **Seeding a floor from a filtered run without saying so** — record the exact command beside the number, so the next agent can reproduce it rather than re-derive a different one.

## Checklist

- [ ] Path filters only; no `--project` on a coverage run
- [ ] `--coverage.reportOnFailure` passed
- [ ] `coverage/coverage-summary.json` newer than the run
- [ ] Number blended over the scope's globs, not read off `All files`
- [ ] Exact reproduction command recorded next to the number

## Related

- Issue [#839](https://github.com/srikanth235/centraid/issues/839) (Wave 0 blend re-seed; the recorded numbers did not reproduce)
- [TESTING.md](../../TESTING.md#product-tiers-and-coverage-gates) — the floor table and its measured column
- `tests/floors.json#coverage` — `approvedDeviation` carries each seed's provenance
- `vitest.config.ts` — the root config whose `include` defines every denominator
