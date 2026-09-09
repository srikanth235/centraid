# Issue #1005 — governance-kit as a constitution

Lane A: `.governance/law/` — the law directory, the arrival record, the runner and the door.
Branch `lane/1005-a`.

## Checklist

- [ ] Directives are lint rules, not shell scripts
- [ ] Estates, registries, appeals and doors
- [ ] The constitution is reworked to match
- [x] `.governance/law/` exists, derives its ESLint config from pack declarations, and is
      reachable only through `bash .governance/run.sh`
- [x] An arrival record generated once per run, deterministic and fixture-pinned
- [x] Two doors — `hook` (fatal, pre-commit) and `window` (the whole law, at review time)
- [x] One line per enabled rule on every run, green or red

## What changed

_Filled at the close of the lane._

## Decisions

_Filled at the close of the lane._

## Verification

_Filled at the close of the lane._

## Audit

judge: pending — root re-judges at close.
