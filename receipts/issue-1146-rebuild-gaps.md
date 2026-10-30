**Law** · window door · range `4c1c05f3..ed1ad342` · law digest `85a0756fba64` → `cae08e97c178`

law changed under this run: `tests/quarantine.json`

| Rule | Door | Verdict | Findings |
| --- | --- | --- | --- |
| `amendment-pairing` | hook | ✓ pass | 0 |
| `commit-message-format` | hook | ✓ pass | 0 |
| `constitution-coverage` | window | ✓ pass | 0 |
| `doc-integrity` | hook | ✓ pass | 0 |
| `doctrine-citation` | window | ✓ pass | 0 |
| `estate-separation` | hook | ✗ fail | 1 |
| `managed-tree-integrity` | hook | ✓ pass | 0 |
| `receipt-per-issue` | window | ✗ fail | 2 |
| `registry-completeness` | window | ✓ pass | 0 |
| `waiver-docket` | hook | ✓ pass | 0 |

### Findings

- `.governance/law/out/arrival.json:3458` **law/estate-separation** (warn) — this change edits the law and the territory, split across commits — law: 'tests/quarantine.json'; territory: 'ARCHITECTURE.md', 'Cargo.lock', 'Cargo.toml' and 298 more. One pull request answers one question; split it, or waive with 'governance: allow-estate-separation <reason>'.
- `.governance/law/out/arrival.json:10093` **law/receipt-per-issue** (error) — receipts/issue-1146-rebuild-gaps.md — ## Verification must record a command and its outcome (fence + pass/fail/exit) or a durable evidence URL; a fence alone is not evidence. This check does not prove the command ran.
- `.governance/law/out/arrival.json:10093` **law/receipt-per-issue** (error) — receipts/issue-1146-rebuild-gaps.md — '## Audit' records no PASS/REFUTED verdict; an independent reviewer must report a verdict + evidence for each check this rule names.

law estate: 11 paths, CODEOWNERS in sync

### Registries

- rulings recorded: #873, #916, #996, #1047, #1078, #1135, #1146 in `docs/decisions.md`
- changelog entries: #1146
- gates moved: `tests/quarantine.json` (unknown)
- no waivers used
- proposal link unverified (offline)
- token cost: not recorded
