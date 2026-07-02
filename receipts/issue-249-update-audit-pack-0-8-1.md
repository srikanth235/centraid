# Issue #249 — chore(governance): update audit pack 0.8.0 → 0.8.1

GitHub issue: [#249](https://github.com/srikanth235/centraid/issues/249)

Re-pin the `governance-kit/audit` pack from the pinned `audit/v0.8.0` to the
newly published `audit/v0.8.1`. It is the only governance-kit concern pack with
a newer published tag — `governance-kit/foundation` (v0.5.1) and
`governance-kit/commits` (v0.2.2) already sit on their latest tags, so this run
touches audit alone. The upgrade is delegated to the pack engine fetched by the
installer shim from the repo-pinned kit (v0.12.0).

## Checklist

- [x] Re-pin governance-kit/audit to v0.8.1 (SHA 14e7af7) in packs.lock
- [x] Refresh the audit directive lib files to v0.8.1 content
- [x] Confirm the diff is cosmetic (type-ignore cleanup, no check.sh/config change)
- [x] Verify the governance smoke test passes

## What changed

**Re-pin governance-kit/audit to v0.8.1 (SHA 14e7af7) in packs.lock.** The
`.governance/packs.lock` entry for `governance-kit/audit` moved from
`version: 0.8.0` / sha `d4b822cf…` / ref `…/audit@audit/v0.8.0` to
`version: 0.8.1` / sha `14e7af7140d79587e1103ae2befba73479abfefd` /
ref `…/audit@audit/v0.8.1`, with the eight per-directive `digest:` hashes
refreshed to the v0.8.1 content. The lockfile was upserted by the pack engine
(`packverb pack-apply add`), not hand-edited — the prior 0.8.0 pin was replaced
atomically by pack id.

**Refresh the audit directive lib files to v0.8.1 content.** Six directive
library files were overwritten with the v0.8.1 content:

- `.governance/packs/governance-kit/audit/directives/agent-steering-accounting/lib/ledger.py`
- `.governance/packs/governance-kit/audit/directives/agent-token-accounting/lib/endpoint.py`
- `.governance/packs/governance-kit/audit/directives/agent-token-accounting/lib/ledger.py`
- `.governance/packs/governance-kit/audit/directives/agent-token-accounting/lib/rates.py`
- `.governance/packs/governance-kit/audit/directives/agent-token-accounting/lib/report.py`
- `.governance/packs/governance-kit/audit/directives/agent-token-accounting/lib/validate.py`

The engine re-wrote all eight audit directive folders in place, but only these
six library files carried a content change; every `check.sh`, `directive.yaml`,
`constitution.md`, `defaults.conf`, and `README.md` is byte-identical between
0.8.0 and 0.8.1. No user overlay under `.governance/conf/` was touched (overlays
are sacrosanct across `pack update`/`pack add`).

**Confirm the diff is cosmetic (type-ignore cleanup, no check.sh/config
change).** Every hunk in the six changed files removes a trailing
`# type: ignore` (and `# type: ignore[…]`) pragma comment from the Python
import-fallback blocks — the `try: import receipt_io as rio` / `except
ModuleNotFoundError: … import receipt_io as rio` pattern that each accounting lib
uses, plus one `# type: ignore[operator]` and one `# type: ignore[assignment]`.
No executable statement, function signature, rule, or rate row changed, so the
directive behavior is identical.

## Decisions

- **Used `pack add @audit/v0.8.1` rather than `pack update`.** The lockfile pins
  a fixed version tag (`audit/v0.8.0`), and `pack update` re-fetches that same
  tag → same SHA → no drift, so it reports "up to date" and moves nothing. The
  supported way to move a deliberately version-pinned pack to a newer tag is
  `governance pack add` with the new ref, which the engine classifies as an
  in-place update of the already-installed pack id. This is the intended path,
  not a workaround.
- **audit only; foundation and commits left untouched.** They are already on
  their latest published tags (foundation v0.5.1, commits v0.2.2), so there was
  nothing to re-pin. Kept this commit scoped to the single pack that actually
  moved.
- **Ran the engine under `python3.12`.** The system default `python3` (3.14) has
  no `PyYAML`; `python3.12` on this machine does. The choice of interpreter has
  no bearing on the written artifacts — it only lets the stdlib+yaml engine run.

## Out of scope

- **Kit runtime files.** `kit_version` in `.governance/install.yaml` and the
  `generated=`/`kit-version=` markers on `.governance/run.sh`,
  `.governance/lib.sh`, `.github/workflows/governance.yml`, and `.githooks/*`
  stay at 0.12.0. `pack add`/`pack update` only touch pack content; the separate
  `governance update` verb re-stamps runtime files.
- **The `governance-kit/docs` pack.** A newer `docs/v0.2.1` tag exists upstream,
  but the docs pack is deliberately not installed in this repo (dropped in #247),
  so it is not part of this update.
- **The local `srikanth235/centraid` pack.** A repo-local pack with no upstream;
  `pack update`/`pack add` skip it by design. Its six custom directives are
  unchanged.

## Verification

```sh
# audit pin moved to 0.8.1
grep -A3 'governance-kit/audit' .governance/packs.lock | grep -E 'version|sha'
#   version: 0.8.1
#   sha: 14e7af7140d79587e1103ae2befba73479abfefd

# the diff is cosmetic — every changed hunk only drops a `# type: ignore` pragma
git diff --unified=0 -- '.governance/packs/governance-kit/audit/**/*.py' \
  | grep -E '^[-+]' | grep -v '^[-+][-+]' | grep -v 'type: ignore'
#   (no output — every +/- line is a type-ignore pragma line)

# Verify the governance smoke test passes
bash .governance/run.sh
#   ✓ governance: all 21 directive(s) passed
```

The pack engine's own post-apply smoke test already reported
`✓ governance: all 21 directive(s) passed` at apply time; the command above
re-runs it against the working tree.

## Audit

Fresh-context sub-agent audit against the staged diff and issue #249.

1. **PASS** — "## What changed" faithfully mirrors the staged diff: the packs.lock re-pin (0.8.0→0.8.1, sha d4b822cf…→14e7af71…, refreshed per-directive digests), the exact set of six changed lib files, and the cosmetic-only nature all match; `git diff --cached --unified=0` over the audit `*.py` files shows every changed hunk is a `# type: ignore` pragma removal with no executable/config change (no misrepresentation, no omission).
2. **PASS** — every `- [x]` item is realized in the diff: (1) packs.lock now pins version 0.8.1 / sha 14e7af7140d79587e1103ae2befba73479abfefd; (2) the six named lib files are all present in the staged diff; (3) the cosmetic claim holds — filtering out `type: ignore` lines leaves no substantive change; (4) the smoke-test-passes item is documented in ## Verification and consistent with the diff being pragma-only.
3. **PASS** — the receipt's "## Checklist" reproduces issue #249's four checklist items verbatim (only the box state flips from `- [ ]` in the issue to `- [x]` in the receipt).

Verdict: PASS

## Steering

Fresh-context sub-agent steering audit of session 43eec44a over the transcript.

No human-steering events: the transcript contains zero interrupts (`Request interrupted` count = 0) and no mid-task free-text corrections. The only user turns are the initial request ("update core pack"), the create-PR command, and answers to the agent's own AskUserQuestion prompts ("Yes, apply v0.8.1"; "Full ceremony" + create-issue). None of these redirect or correct the agent mid-task, so zero rows were written to the steering ledger.

Verdict: PASS

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-43eec44a-eed-1782971288-1 | claude-code | 43eec44a-eed3-44a5-a168-8d8b90666e07 | #249 | claude-opus-4-8 | 29187 | 475811 | 13614568 | 121664 | 626662 | 12.9686 | 29187 | 475811 | 13614568 | 121664 | chore(governance): update audit pack 0.8.0 → 0.8.1 (#249) -m Re-pin governance-k |
