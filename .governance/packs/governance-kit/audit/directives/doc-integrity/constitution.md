### doc-integrity

- **Directive**: System-of-record documents are append-only relative to the change set's baseline — the default-branch merge-base. Defaults are `frozen-files receipts/*.md` (always restored) and `frozen-section CONSTITUTION.md Evolution Log`. The overlay `.governance/conf/governance-kit/audit/doc-integrity.conf` may add rules or drop the Evolution Log freeze with `!<rule>`. Three modes:
    - `frozen-files <glob>` — every file matching `<glob>` that exists at the baseline is byte-immutable; it may not be modified, renamed, or deleted, but new files may be added.
    - `append-only <file>` — the baseline version of `<file>` must be an exact byte-prefix of the current version.
    - `frozen-section <file> <heading>` — every line present under that heading at the baseline must still appear, verbatim. The rest of the file is free.
  Content authored within the current branch stays editable until it merges. When no default branch resolves, the baseline falls back to HEAD.
- **Rationale**: Receipts and the constitution's evolution log are the durable record of *what happened*. They are only trustworthy if their history cannot be quietly rewritten. In-flight receipts stay editable until they merge.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/doc-integrity/check.sh` (Mode B — CI walks merge-base → HEAD) and `.githooks/commit-msg` (Mode A). Protected documents come from the manifest registry plus its tunable overlay.
- **Exceptions**: Path-scoped per-change-set waiver — `governance: allow-doc-integrity <path> <reason>` in a commit body exempts `<path>` (reason required). Receipts remain covered even if the overlay tries to drop that rule. The Evolution Log freeze may be dropped with `!frozen-section CONSTITUTION.md Evolution Log`.
