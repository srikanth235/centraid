# issue-96 — Multi-trigger automations (cron + webhook) + Behavior & Apps form sections

GitHub issue: [#96](https://github.com/srikanth235/centraid/issues/96)

The redesigned New-automation form exposed only a name, instructions, and
a single cron trigger. This issue makes triggers plural, adds a webhook
trigger kind, and surfaces manifest fields (model / retention / on-failure
/ apps) the form could not previously reach. GitHub-event triggers, a
Permissions tab, and local desktop webhooks are explicitly out of scope.

## Checklist

- [x] Manifest → plural `triggers[]` with dual-read back-compat
- [x] Scheduler host fan-out (OS scheduler + openclaw cron)
- [x] Run ledger `trigger_origin` column
- [x] Webhook dispatch core + openclaw `/_centraid-hook` route
- [x] Scaffold + IPC + preload plumbing (Behavior fields, webhook secret)
- [x] New-automation form rebuild (trigger list, Behavior, Apps sections)

## What changed

### Manifest → plural `triggers[]` with dual-read back-compat

`AutomationManifest.trigger` becomes `triggers: readonly AutomationTrigger[]`,
where `AutomationTrigger` is a `CronTrigger | WebhookTrigger` union.
`resolveTriggers()` dual-reads: a plural `triggers` array validates each
entry; a legacy single `trigger` object is wrapped into a one-element
list; neither yields an empty list (a legal "manual fire only"
automation). Old `automation.json` files stay readable with no
filesystem sweep — the manifest is rewritten plural on next save.
Validation allows multiple cron triggers but at most one webhook.
`AutomationRow.cronExpr` → `triggers`.

### Scheduler host fan-out (OS scheduler + openclaw cron)

`OsSchedulerHost` partitions a row's triggers: cron triggers go to the
OS scheduler, webhook triggers are skipped (the desktop is a gateway
client, not an HTTP host). `OsSchedulerJobSpec` takes
`cronExprs: string[]` — launchd folds multiple schedules into one plist
(`StartCalendarInterval` array), systemd into one timer (multiple
`OnCalendar=` lines); Windows Task Scheduler supports exactly one cron
per automation and throws otherwise. The openclaw cron host registers
one cron job per cron trigger (`centraid:<id>`, `centraid:<id>:<n>`),
and reconcile diffs the flattened name set.

### Run ledger `trigger_origin` column

A new `runs.trigger_origin` column (`ACTIVITY_MIGRATIONS` v2→v3, no
backfill) records what fired each run — `cron` / `webhook` / `manual`.
It is threaded through `runAutomationHandler`, `runAutomationLocal`, and
`runOpenclawFire`, and shown on the run detail's Trigger tile.

### Webhook dispatch core + openclaw `/_centraid-hook` route

`WebhookTrigger` carries a generated route slug `id` and a SHA-256
`secretHash`. The plaintext secret is minted server-side at create time
and shown once; only the hash is persisted because `automation.json` is
user-visible. New `automation-webhook.ts` in runtime-core holds the
secret helpers (generate / hash / timing-safe verify) and
`makeWebhookRouteHandler` — a body-size cap, fixed-window rate limit,
and single-in-flight guard, with the automation fire delegated to a
caller-supplied callback so the module carries no openclaw dependency.

The centraid openclaw plugin registers one `/_centraid-hook` prefix
route at `auth: 'plugin'` (verified against the installed SDK —
`OpenClawPluginHttpRouteAuth` is `"gateway" | "plugin"`); the handler
resolves the path slug to an automation, verifies the shared secret
(`Authorization: Bearer` or `x-openclaw-webhook-secret`), and fires via
`runOpenclawFire`. The desktop never mounts the route.

### Scaffold + IPC + preload plumbing (Behavior fields, webhook secret)

`scaffoldAutomationProject` accepts `triggers`, `model`, `historyKeep`,
and `onFailure`, writing them into the manifest. The `AUTOMATIONS_CREATE`
IPC handler and the `createAutomation` preload type are widened to pass
them through; the handler mints each webhook trigger's id + secret
server-side, stores the hash, and returns the one-time plaintext secret
+ URL to the renderer.

### New-automation form rebuild (trigger list, Behavior, Apps sections)

The single trigger card becomes an additive list — a stack of Schedule
and Webhook rows with `+ Schedule` / `+ Webhook` buttons (webhook capped
at one). A Behavior section adds a model select (Default plus
`listChatModels`), a run-retention select, and an on-failure picker fed
by `listAutomations`. An Apps section multi-selects over the app
projects. After create, a webhook trigger reveals its URL + secret in a
one-time panel.

## Out of scope

- GitHub-event triggers — only `cron` + `webhook` kinds.
- A Permissions tab — no permissions concept exists in the manifest or
  runtime.
- Local desktop webhooks — the desktop is a gateway client; webhook
  triggers activate only on a cloud gateway.

## Verification

- runtime-core typecheck + 275 tests; agent-runtime build + 82 tests;
  openclaw-plugin build + 21 tests; builder-harness build + 8 tests;
  desktop typecheck + build. Full monorepo `build` + `typecheck` +
  `test` — 22/22 turbo tasks green. Lint + format clean.
- The Electron form UI was not interactively click-tested.
