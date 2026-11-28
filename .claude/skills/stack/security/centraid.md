# Security review in Centraid

`general/` is a copy of public security-review skills: four from [Trail of Bits](https://github.com/trailofbits/skills) (CC BY-SA 4.0, [licence](licenses/trailofbits-skills-LICENSE)) and one from [Sentry](https://github.com/getsentry/skills) (Apache-2.0, [licence](licenses/getsentry-skills-LICENSE)). Start at [general/INDEX.md](general/INDEX.md). The list, and why the rest is left out, is in [sync.py](sync.py). The Trail of Bits skills are copied verbatim, never digested, because of their share-alike licence.

**This page wins over `general/`.** The skills are written for audits of any project. Centraid's bar is its own trust rules, in [../../product/SKILL.md](../../product/SKILL.md) and [../../product/rulings/keep-protect.md](../../product/rulings/keep-protect.md):

- The phone's Rust core is the vault's only writer. Nothing else opens the vault file, and a shell never declares a hash or holds a key.
- Sealed values (Locker secrets, one-time-code seeds, sealed files, passkey keys) stay sealed: never in an index, a derived file, a log, a queue, a prompt or a backup in the clear.
- The gateway is blind: ciphertext under keyed names, no content, no schema, no listing that links vaults, no key it can mint.
- The `unsafe` boundary is `core-ffi` and `assist-llama`; every other crate forbids it. Read [`crates/core-ffi/CONTRACT.md`](../../../../crates/core-ffi/CONTRACT.md) before an FFI change.

A review checks a change against those first, then against the skill's checklist. A finding that breaks one of them is blocking.

## When to use which

| Skill | Use it | Notes |
| --- | --- | --- |
| [rust-review](general/trailofbits/rust-review/SKILL.md) | Before landing a large Rust change, and at a milestone's end, for Locker sealing, `core-ffi` and the backup crypto | Most useful where input is untrusted or `unsafe` lives: the FFI boundary, the gateway protocol, imports and the share-in inbox. See [../rust/centraid.md](../rust/centraid.md) |
| [supply-chain-risk-auditor](general/trailofbits/supply-chain-risk-auditor/SKILL.md) | When a dependency is added or raised | Alongside `cargo deny check`, not instead of it. A new dependency is a product call |
| [sharp-edges](general/trailofbits/sharp-edges/SKILL.md) | When designing an action, a read, a config or a wire message | Ask whether the safe use is the easy use and whether a wrong value fails loudly |
| [property-based-testing](general/trailofbits/property-based-testing/SKILL.md) | When writing tests for a pure rule: currency rescaling, an override rule, a draft round trip, a keyset cursor, an export and import round trip | Use `proptest` (Rust). Test layout is in [../../land/tests.md](../../land/tests.md) |
| [gha-security-review](general/getsentry/gha-security-review/SKILL.md) | Whenever `.github/workflows/` changes | A workflow with release or signing rights is the highest-value target. See [../../land/ci.md](../../land/ci.md) |

## Rules

- **Findings go in the change, or are reported.** Fix a finding in the change that caused it. Anything left is named in the report with its risk, as [../../land/report.md](../../land/report.md) says. Do not file issues or pull requests upstream.
- **Tool suggestions are not dependencies.** The skills suggest Semgrep, CodeQL, cargo-audit, Echidna and more. None is a dependency or a required check unless the repo already uses it. Use what is installed, or say the step was not run.
- **The skills' output files are scratch.** Reports, SARIF and run plans go outside the repo, or are not committed.
- **Centraid's bar beats the skill's severity.** A sealed value, a recovery word or a gateway token in a log, an index or a payload is critical even if the skill would rate it low.

## Updating general/

```bash
git clone --depth 1 https://github.com/trailofbits/skills /tmp/tob-skills
git clone --depth 1 https://github.com/getsentry/skills /tmp/sentry-skills
python3 .claude/skills/stack/security/sync.py trailofbits=/tmp/tob-skills getsentry=/tmp/sentry-skills
python3 .claude/skills/stack/security/sync.py --check
```

Never edit `general/` by hand. To take or drop a skill, edit the lists in `sync.py` and sync. Read the diff of an update like any other change.
