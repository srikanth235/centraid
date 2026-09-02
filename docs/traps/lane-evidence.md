# Lane evidence: the file is the row

The nightly report is a **pure function of `artifacts/evidence/`** plus `tests/claims.json` (#915). Nothing else reaches the page. That is what makes it honest, and it is also the trap: three ordinary-looking mistakes make a lane disappear from the report while its job still shows green in Actions.

## 1. Uploading the evidence from the wrong path

The nightly downloads every lane's artifact with ONE glob and `merge-multiple: true`:

```yaml
- uses: actions/download-artifact@…
  with: { pattern: nightly-evidence-*, path: artifacts, merge-multiple: true }
```

So every producer must upload with `path: artifacts/` — never `path: artifacts/evidence/`. Uploading the subdirectory flattens `evidence/` away and the files land where nothing reads them. This is the exact #532 defect, and `scripts/test-report/validate-nightly-wiring.mjs` guards it.

`write-evidence.mjs` always resolves its output against the **repo root**, not the cwd, for the same reason `prepare.mjs` does (#535 F2): a lane that runs from `apps/mobile` would otherwise write `apps/mobile/artifacts/evidence/`.

## 2. Forgetting `if: always()`

The step's whole purpose is to speak when the lane failed. Without `if: always()` it runs only on green, so a red lane writes nothing and renders as `no evidence` — which the report reads as "the wiring broke", not "the product broke". Pair it with `--verdict auto --job-status ${{ job.status }}`.

## 3. Naming a lane the claims file does not register

Lane identity is the **GitHub job id**, and `tests/claims.json#lanes` is the list of lanes the report has a row for. An evidence file naming an unregistered lane is not rendered anywhere — so `bun run lint:evidence-mapping` fails the PR instead, and `bun run test:claims` fails a registered rung 2–5 lane whose job carries no `Write lane evidence` step. Both directions are gates because either one alone lets a lane go quiet.

A matrix leg (`coverage-shard-${{ matrix.shard }}`) writes one file per leg under one registered lane, and a loop over reusable-workflow results writes several lanes from one step; the linter resolves both. Anything else templated into `--lane` is an error, because a lane id nobody can read is a row nobody can find.

## What good looks like

```yaml
- id: start
  run: echo "at=$(date -u +%FT%TZ)" >> "$GITHUB_OUTPUT"
# … the lane …
- name: Write lane evidence
  if: always()
  env:
    LANE_STARTED_AT: ${{ steps.start.outputs.at }}
  run: >
    node scripts/test-report/write-evidence.mjs --lane <job-id> --rung 4 --platform ios --verdict auto --job-status ${{ job.status }} --started-at "$LANE_STARTED_AT" --budget-ms 3600000 --candidate "$CANDIDATE_SHA" --qualities journey --surfaces mobile-native
```

Parks need nothing here: the writer reads `tests/quarantine.json#lanes` itself and writes `verdict: "parked"` rather than `"failed"` for a lane with an unexpired entry. A park is a date on the debt, never a mute.
