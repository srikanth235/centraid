# agent-session-identity

`agent-session-identity` records the provenance of an agent-authored change
without recording conversation contents or usage data.

For each recognized runtime, the pre-commit helper resolves the issue anchor
from `(#N)` (or `AGENT_ISSUE`) and upserts one row in that issue's receipt:

```markdown
## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-06 | codex | 019ed... |
```

The directive reads only explicit identity signals (`GOVERNANCE_HARNESS` /
`GOVERNANCE_SESSION_ID`, supported harness environment markers, or the
kit-owned `session-identity` sidecar). It never opens a transcript, session
database, usage file, or harness-owned path. A runtime that does not expose a
session identifier records `-`; a plain human commit is a no-op.

`check.sh` validates all identifier tables in CI and requires the active
runtime/session row in the staged receipt during the commit-message hook. A
legitimate out-of-hook commit may use
`governance: allow-agent-session-identity <reason>` in its commit body.
