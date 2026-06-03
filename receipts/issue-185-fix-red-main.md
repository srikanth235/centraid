# issue-185 — Fix red main left by #183

GitHub issue: [#185](https://github.com/srikanth235/centraid/issues/185)

`main` (8cb47c4, #182/#183 "drop custom-endpoint provider keys") merged with a
red CI: the `check` job's `oxfmt --check .` and the `Governance` job's
`no-broken-internal-doc-links` both fail. Both block every open PR's merge CI.
This is a minimal repair of those two pre-existing failures, bundled into the
#181 PR so its CI can go green.

## Checklist

- [x] Run oxfmt on apps/desktop/src/renderer/app.ts
- [x] Unlink the deleted auth-import.ts references in the issue-71 receipt

## What changed

### Run oxfmt on apps/desktop/src/renderer/app.ts

#183 rewrote `apps/desktop/src/renderer/app.ts` (386 lines changed) but left a
`SettingsPageId` union expanded across lines instead of collapsed onto one. Ran
the formatter — a one-line whitespace-only reflow, no behavior change.

### Unlink the deleted auth-import.ts references in the issue-71 receipt

#182 deleted `apps/desktop/src/main/auth-import.ts`, but
`receipts/issue-71-chat-harness-openclaw-gateway-inference.md` still linked to it
at lines 225 and 279, so `no-broken-internal-doc-links` flagged two broken links.
Converted both Markdown links to plain code spans (the historical prose is kept
verbatim; only the now-dangling hyperlink to the deleted file is dropped).

## Out of scope

- The substance of #182/#183 (the auth-agnostic agent detection refactor) — only
  its CI fallout is touched here.
- The #181 feature change shares this branch but is a separate commit.

## Verification

- `npx oxfmt --check .` — all 447 files clean.
- `no-broken-internal-doc-links` governance directive — passes (0 violations).
- `npx turbo run typecheck test` for app-engine + gateway + conversation-engine
  + agent-runtime — green after rebasing #181 onto the new main.
