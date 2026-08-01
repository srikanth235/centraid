# issue-681 — restore the chrome's sans and display faces

The #677 token-contract rename (commit `1e7b2358`) collapsed `--font-sans` and
`--font-display` onto `--font-mono` across the client shell, so the desktop and web
chrome rendered body text in a monospace face. This restores the pre-#677 faces
without discarding the parts of that commit's font work that were genuine cleanup.

## Checklist

- [x] Restore the shell's default body face to the sans stack
- [x] Restore every `--font-sans` and `--font-display` declaration the rename collapsed, paired by selector
- [x] Restore the four `font-family: inherit` declarations the rename overwrote
- [x] Re-add the `literalFontFamily` allowances the ratchet needs for those inherit sites
- [x] Move the AutomationsOverviewScreen subtitle off mono onto the shared body convention
- [x] Verify in the running desktop app that the chrome computes to sans and mono stays an accent

## What changed

### The default body face

`packages/client/src/styles.css` is the headline case — the rule every unstyled
element in the shell inherits from:

```css
body {
-  font-family: var(--font-mono);
+  font-family: var(--font-sans);
```

### Selector-paired restoration across the shell

The rename touched 113 declarations. A blanket revert of `1e7b2358` would have
discarded real improvements in the same hunks, so each declaration was paired to its
pre-#677 counterpart **by CSS selector** (not by diff line order) and reverted only
where the token's meaning actually changed:

| Restored to | Count |
| --- | --- |
| `var(--font-sans)` / `var(--font-display)` | 78 across 32 files |
| `font-family: inherit` | 4 |

The four `inherit` sites — `.editTextarea`, `.tgChangeCard`, `.deviceBtn`, and one in
BuilderCloud — are restored to `inherit` rather than to any token, because `inherit`
is not equivalent to a named face and only the original keyword preserves whatever
the ancestor resolved to.

Files carrying restored declarations — the union of both kinds above, so the 32
sans/display files plus the two whose only restore was an `inherit`
(`BuilderCloud`, `BuilderShell`); `ApprovalsScreen` and `BuilderChatPane` carry
both:

- `packages/client/src/styles.css`
- `packages/client/src/react/screens/AppSettingsPanel.module.css`
- `packages/client/src/react/screens/ApprovalsScreen.module.css`
- `packages/client/src/react/screens/AssistantScreen.module.css`
- `packages/client/src/react/screens/AtlasBrowseTab.module.css`
- `packages/client/src/react/screens/AtlasKindsTab.module.css`
- `packages/client/src/react/screens/AtlasRelationsTab.module.css`
- `packages/client/src/react/screens/AtlasScreen.module.css`
- `packages/client/src/react/screens/AutomationTemplatesScreen.module.css`
- `packages/client/src/react/screens/AutomationThreadScreen.module.css`
- `packages/client/src/react/screens/BackupCard.module.css`
- `packages/client/src/react/screens/BuilderChatPane.module.css`
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/screens/GatewayServiceTip.module.css`
- `packages/client/src/react/screens/InsightsScreen.module.css`
- `packages/client/src/react/screens/LocalFootprintCard.module.css`
- `packages/client/src/react/screens/ResourceDialogs.module.css`
- `packages/client/src/react/screens/ResourceReceiptPanel.module.css`
- `packages/client/src/react/screens/RunViewScreen.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsStorageScreen.module.css`
- `packages/client/src/react/screens/WhatsNewModal.module.css`
- `packages/client/src/react/shell/PageScroll.module.css`
- `packages/client/src/react/shell/automationTemplatePreview.module.css`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/routes/AppViewRoute.module.css`
- `packages/client/src/react/shell/routes/SettingsRoute.module.css`
- `packages/client/src/react/shell/routes/assistantRich.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderShell.module.css`
- `packages/client/src/react/styles/drawerGroup.module.css`
- `packages/client/src/react/styles/modal.module.css`

### Ratchet allowances for the inherit sites

`tests/design-token-css-budget.json` regains the four `literalFontFamily: 1` entries
it carried before #677. The ratchet counts any `font-family` value not starting with
`var(--` as a literal stack, so a restored `inherit` trips it; these entries are the
same allowances the parent commit had, for the same four files.

### AutomationsOverviewScreen subtitle

`packages/client/src/react/screens/AutomationsOverviewScreen.module.css` rendered
page body copy — "Run on a schedule or when your data changes." — in mono. This
predates #677, but it is the same legibility defect on a screen this issue covers.
It now follows the shared page-subtitle convention used by `ApprovalsScreen` and
`SettingsConnectionsScreen`:

```css
 .subtitle {
   margin: 0;
-  font-family: var(--font-mono);
-  font-size: 12px;
+  font: var(--t-body);
+  font-size: 13px;
   color: var(--text-faint);
 }
```

### Checklist crosswalk

- **Restore the shell's default body face to the sans stack** — "The default body
  face" above; `packages/client/src/styles.css`.
- **Restore every `--font-sans` and `--font-display` declaration the rename collapsed, paired by selector**
  — "Selector-paired restoration across the shell"; 78 declarations across 32 files.
- **Restore the four `font-family: inherit` declarations the rename overwrote** — same
  section; the four sites listed there.
- **Re-add the `literalFontFamily` allowances the ratchet needs for those inherit sites**
  — "Ratchet allowances for the inherit sites"; `tests/design-token-css-budget.json`.
- **Move the AutomationsOverviewScreen subtitle off mono onto the shared body convention**
  — "AutomationsOverviewScreen subtitle" above.
- **Verify in the running desktop app that the chrome computes to sans and mono stays an accent**
  — the live Electron/Playwright run under `## Verification`.

## Decisions

- **Selector-paired restoration over `git revert`.** Reverting `1e7b2358`'s font
  hunks wholesale would have re-introduced hardcoded stacks the same commit
  legitimately cleaned up. Pairing by selector reverts only the declarations whose
  token changed meaning and leaves the cleanup intact.
- **Kept the mono-literal normalizations.** Declarations that were already a
  monospace literal (`ui-monospace, SFMono-Regular, …`, `"JetBrains Mono", …`) or a
  `var(--font-mono, …)` fallback chain, and which #677 collapsed onto plain
  `var(--font-mono)`, are left as-is — they render the same face and the collapsed
  form is the better one.
- **Kept the six `system-ui` → `var(--font-sans)` conversions.** Same reasoning in
  the other direction: those replaced hardcoded stacks with the token.
- **Left newly-added declarations alone.** Rules that #677 *added* (in
  `OnboardingScreen`, `RecoverScreen`, `BuilderAutomationPane`) mix sans and mono
  deliberately and have no pre-#677 counterpart to restore to.
- **`inherit` restored as `inherit`, not as a token.** See above — substituting a
  named face would have changed rendering wherever the ancestor was not sans.
- **The AutomationsOverviewScreen fix is in scope by explicit instruction.** It is a
  pre-existing defect rather than #677 fallout; it was surfaced for a decision and
  folded in on request rather than silently.

## Out of scope

- **57 corrupted comments from the same search/replace.** `1e7b2358` also rewrote
  issue references inside comments (`(issue #468 K6)` → `(issue var(--text) K6)`,
  `(issue #667)` → `(issue var(--text))`) across roughly 20 files. Cosmetic, but it
  destroys the issue breadcrumbs; it wants its own commit and is not fixed here.
- **`AutomationTemplatesScreen.module.css` `.sub`.** The sibling Automations screen
  has the same mono page-subtitle shape. It was left alone to keep this change
  scoped to what was asked; it is the obvious companion if the convention is being
  swept.
- **`packages/design/kit/kit.css`.** Its 23 font changes in `1e7b2358` were the
  legitimate `--kit-mono` → `--mono` rename. Untouched.
- **Mobile (`apps/mobile`).** Its `family.mono*` usages are pre-existing and were not
  affected by the rename.
- **`packages/design/src/kit.test.ts` is not part of this work.** It belongs to
  `ebcd2131` (#672), which is committed locally but not yet pushed, so governance's
  `origin/main..HEAD` change set sweeps it in alongside these staged files. It has
  its own receipt (`receipts/issue-672-theme-contract.md`) and is named here only to
  satisfy file coverage and to state plainly that this commit does not touch it.
- **The token layer itself.** `packages/design/src` still emits `--font-sans`,
  `--font-display`, and `--font-mono` exactly as before; nothing about the contract
  needed changing, only its consumers.

## Verification

Gates:

```sh
bun run format:check
bun run lint:css
bun run lint:design-tokens
bun run typecheck
bun run --filter '@centraid/client' test
bun run --filter '@centraid/design' test
```

Results: format clean over 3414 files; `css-classes` 406 module imports, no dead
classNames; `design-token-css` zero regressions (82 grandfathered hex values, 4
literal font stacks — the restored `inherit` sites); typecheck 34/34; client 214
files / 1741 tests passed; design 16 files / 158 tests passed.

Reconciliation against the pre-#677 tree — every surviving difference is an
intended one:

```sh
git diff 1e7b2358^ -- 'packages/client/**/*.css' | grep -E '^[-+].*font-family'
```

The only remaining `-` lines are monospace literals and `var(--font-mono, …)`
fallback chains (collapsed onto `var(--font-mono)`) plus six hardcoded `system-ui`
stacks (collapsed onto `var(--font-sans)`). No `--font-sans` or `--font-display`
declaration remains rewritten.

Live verification in the running desktop app — launched a real Electron process via
the repo's Playwright harness with a fresh `userData` and a mock gateway, then
measured computed styles across four screens:

```sh
cd apps/desktop && bun run build
bun x playwright test -c tests/e2e/playwright.config.ts
```

`getComputedStyle(document.body).fontFamily` resolves to
`system-ui, -apple-system, "system-ui", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
on Home, Discover, Automations, and Analytics. Leaf text elements per screen —
Home 49 sans / 14 mono, Discover 24/11, Automations 21/8, Analytics 19/7. Every
remaining mono element is an intended accent (⌘-shortcut chips, eyebrow labels, the
hero date, `DRAFT` badges, tile counts), and each was confirmed mono in the
pre-#677 tree as well.

## Audit

PASS — a fresh-context sub-agent was handed only the staged diff, this receipt, and
`gh issue view 681`, and asked adversarially whether `## What changed` describes the
diff, whether each `- [x]` item is realized in it, and whether the `## Checklist`
mirrors the issue's, defaulting to REFUTED when uncertain.

What it confirmed by direct count against the patch: 35 `+var(--font-sans)` and 43
`+var(--font-display)` lines (78 total) across exactly 32 distinct files, matching
the table; exactly 4 `+font-family: inherit` lines, in the same four files that gain
`literalFontFamily: 1` entries in `tests/design-token-css-budget.json`; the
`AutomationsOverviewScreen` subtitle change; the six checklist items identical in
wording and order to the issue's; complete file coverage; and no undisclosed change
— every `+`/`-` line in the CSS files touches `font-family`, `font:`, or `font-size`
and nothing else.

Two limits it recorded rather than waived:

1. The selector names given for the `inherit` sites (`.editTextarea`,
   `.tgChangeCard`, `.deviceBtn`) sit outside the diff's three-line hunk context, so
   the auditor could not confirm them from the diff alone. They are asserted by the
   author, not independently checked.
2. Checklist item 6 — the live desktop verification and its per-screen element
   counts — is narrative and produces no artifact in the diff, so it is
   unfalsifiable from the audit materials. The auditor treated it skeptically and
   did not count it as evidence either way.

Neither limit contradicts diff evidence, which is why the verdict is PASS rather
than REFUTED.

## Steering

A fresh-context sub-agent on the low tier was handed the session transcript
(`cb7dbb8f-b680-41f2-858a-c645894de891.jsonl`) and this receipt, and classified every
user message as interrupt / correction / not-steering.

- **Check 1 — every human-steering event is recorded as a row in `### Steering`:
  PASS.** It found zero interrupts and zero corrections across the session's five
  user messages, and the receipt records zero steering rows. The messages were: the
  initial task, a `/compact` invocation, "open desktop app and check please", a
  request to summarize, and the instruction to fix AutomationsOverviewScreen and
  commit. The last three add scope rather than push back on work already done, which
  the directive explicitly excludes from steering.
- **Check 2 — no non-steering message is recorded as a steering event: PASS.** No
  `### Steering` rows exist, so there are no false positives.

No `ledger.py append-row` calls were needed, since there were no events to append.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-cb7dbb8f-b68-1785591204-1 | claude-code | cb7dbb8f-b680-41f2-858a-c645894de891 | #681 | claude-opus-5 | 713 | 576819 | 19104555 | 94392 | 671924 | 15.5208 | 713 | 576819 | 19104555 | 94392 |  |
| claude-code-cb7dbb8f-b68-1785591417-1 | claude-code | cb7dbb8f-b680-41f2-858a-c645894de891 | #681 | claude-opus-5 | 35 | 36817 | 3215901 | 13184 | 50036 | 2.1678 | 748 | 613636 | 22320456 | 107576 |  |
| claude-code-cb7dbb8f-b68-1785591522-1 | claude-code | cb7dbb8f-b680-41f2-858a-c645894de891 | #681 | claude-opus-5 | 17 | 29391 | 1901557 | 10817 | 40225 | 1.4050 | 765 | 643027 | 24222013 | 118393 |  |
