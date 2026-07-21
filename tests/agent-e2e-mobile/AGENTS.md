# AGENTS.md — agent-driven e2e (mobile)

Notes for any agent (or human) writing or running flows in this folder.
Pair with [README.md](README.md) (general user-facing how-to). Shared run-id
and verdict conventions live in
[`../agent-e2e-shared/harness.mjs`](../agent-e2e-shared/harness.mjs); desktop
regression ownership lives in `apps/desktop/tests/e2e/`.

## What this layer is for

A loose, exploratory complement to whatever scripted-mobile tier
eventually lands in `apps/mobile/tests/e2e/` (Detox is the planned
inhabitant — not wired up yet). The harness ([`lib/harness.mjs`](lib/harness.mjs))
discovers a booted iOS Simulator **or Android emulator**, checks
`dev.centraid.mobile` is installed and Metro is reachable, allocates a
run dir, and exposes a `ctx` surface (`run`, `restart`, `note`) to the
flow body via `runFlow(slug, fn)`. Each `ctx.run(yaml)` spawns
`maestro test` once with cwd set to the run's `screenshots/` dir, so
`takeScreenshot:` directives land there.

`MAESTRO_PLATFORM=ios|android` forces a target when both are running;
otherwise iOS is preferred. `state.json` and `verdict.md` record the
chosen platform alongside the udid.

The structural payoff over flat YAML is **`ctx.restart()`** (stopApp +
relaunch without clearing state) and **on-disk verification via
`xcrun simctl get_app_container`** — both let a flow reason about what
crossed the process boundary, not just what the UI rendered.

## Choosing the right layer

| Symptom | Where it belongs |
|---|---|
| Hard invariant that must never flake in CI | `apps/mobile/tests/e2e/` (Detox, when wired up) |
| End-to-end mobile journey ("set gateway, open an app, see the WebView load, come back") | here |
| Visual / copy / "does this feel right" judgment | here |
| DOM-level assertion inside the in-app WebView | Playwright over CDP into the WebView |
| Native unit test | `apps/mobile/ios/CentraidTests/` (doesn't exist yet) |

## Running a flow

Metro has to be up first (the dev build fetches its JS bundle at
runtime):

```sh
cd apps/mobile && bunx expo start --dev-client
```

Then:

```sh
node tests/agent-e2e-mobile/flows/<slug>.mjs
```

Verdict at `runs/<slug>-<runId>/verdict.md`. Run dir is always kept —
mobile runs are mostly screenshot audit trails, not ephemeral
workspaces like desktop's `userData`.

## Authoring a flow

1. **Drive the screen manually via the MCP first.** Use
   `inspect_view_hierarchy` to dump the actual accessibility tree
   for the screen you want to assert on — selectors live there.
   Don't guess what Maestro sees from reading the RN source; the RN
   accessibility tree and the source aren't 1:1 (e.g.
   `accessibilityLabel` shows up as `accessibilityText` in the
   hierarchy, but `testID` doesn't exist at all unless you've added
   one).
2. **Write `flows/<slug>.md` first** — Goal, Setup, Steps,
   Expectations, Verdict. The prose stays the source of intent.
3. **Encode it as `flows/<slug>.mjs`** using `runFlow`. Skeleton in
   [README.md](README.md#authoring-a-flow).
4. **Iterate against `~/.maestro/tests/<timestamp>/` debug artifacts**
   when a step fails — the latest dir has the failure screenshot
   and the parsed `commands-(*).json` so you can see exactly which
   selector or assertion Maestro objected to.
5. **Commit both files.** `runs/` is gitignored.

## Shared exploratory-flow conventions

- **Slug = filename = `runFlow()` first arg.** Keep them identical so
  verdicts and run dirs are greppable.
- **Throw on failure, return `{ pass: true, notes }` on success.**
  Don't swallow errors with try/catch — let the harness write the
  FAIL verdict.
- **Use `ctx.note(msg)` for observations the verdict should preserve.**
  Things like "AsyncStorage manifest holds the URL pre-restart" —
  short, factual.
- **`takeScreenshot: <descriptive-name>`** in YAML, not `step1.png`.
  Screenshots are part of the audit trail.

## Flow authoring rules

Getting `mobile-e2e` green (#474/#478) surfaced six flows that were green while
observing nothing, or red for a reason unrelated to their claim. These rules
prevent the recurrence (issue #483). The first two are **mechanically enforced**
by `scripts/lint-e2e-flows.mjs` (runs in `bun run check:pr` and CI `static`); the
rest are review judgment.

1. **Every `inputText` must be observed before it can be wiped.** _(enforced)_
   Follow it with an `assertVisible`/`extendedWaitUntil` on the value typed, so a
   dropped or corrupted keystroke fails AT the field — not as an unrelated redbox
   two steps later. A value that genuinely cannot be read back (a masked secret, a
   throwaway keystroke that is erased) is exempt with a reason:
   `# e2e-lint-allow: unasserted-input — <why>` on the step or the comment above it.
2. **Never assert on a tab-bar label or route name.** _(enforced)_
   `Home/Photos/Docs/Agenda/Settings/Apps` render in the tab bar on every screen
   (and `Apps` is a route name, never visible text), so `tapOn "Docs.*"` +
   `assertVisible "Docs"` passes even when the tap did nothing. Assert a string the
   target screen alone publishes — a heading or a Pressable `accessibilityLabel`
   (e.g. Photos → "Search photos"). `tapOn` on a label is fine; asserting one is not.
   Exempt a deliberate case with `# e2e-lint-allow: route-name — <why>`.
3. **Anchor every `tapOn` so it cannot match help copy.** _(review)_
   Maestro matches text as a substring; a bare `tapOn "http://127.0.0.1:18789"`
   matched the help paragraph that quotes the URL and focused nothing. Use a
   `below:`/`above:` anchor or `^exact$` regex.
4. **Assert on strings the product deliberately publishes.** _(review)_
   Prefer a testID or `accessibilityLabel` over incidental copy. Where a flow has
   to fall back to incidental text, the product is missing an accessible name —
   file it (see #482) rather than cementing the fragile selector.

## Conventions specific to this layer

- **Never write a selector from the React source.** Boot the simulator,
  install the app, and read `inspect_view_hierarchy` before asserting on
  any string. Selectors inferred from JSX shipped a `mobile-e2e` lane in
  which the pairing tap was a silent no-op, the "arrived at Settings"
  assertion passed on Home, the gateway URL was typed into nothing, and a
  tab was asserted by its route name (`Apps`) rather than its label
  (`Home`) — all green, all meaningless. See "A passing step is not a
  working step" in `README.md` for the specific traps. A step that reports
  COMPLETED has not necessarily done anything: confirm the screen actually
  changed.
- **Verify on disk when state is the unit of truth.** Maestro's text
  matcher is unreliable on RN `TextInput` values (the value is in
  `inspect_view_hierarchy` under both `text=` and `value=`, but
  `assertVisible: "<substring>"` against it doesn't match). For
  AsyncStorage assertions, read it directly via platform-specific
  paths:
  - **iOS**: `xcrun simctl get_app_container <udid> dev.centraid.mobile data`
    then `Library/Application Support/dev.centraid.mobile/RCTAsyncLocalStorage_V1/manifest.json`.
  - **Android**: `adb -s <udid> shell run-as dev.centraid.mobile cat databases/RKStorage` —
    RKStorage is a SQLite DB; query with `sqlite3 :memory: '.read /dev/stdin' "SELECT * FROM catalystLocalStorage WHERE key='centraid.v1.settings.gatewayUrl';"`.
    Or `adb pull` it to host disk first.

  Values are double-JSON-encoded (Store.set runs JSON.stringify, the
  storage layer wraps the result) — `JSON.parse` twice.
- **Batch directives per `ctx.run()`.** Each call costs ~hundreds of
  ms (process spawn + Maestro warm-up + driver handshake). 15
  separate `ctx.run()` calls is a minute of overhead. Group them.
- **Keep iOS flows short.** Maestro `2.0-dev.1`'s iOS driver gets
  flaky past ~10 commands on iOS 26.4 — driver disconnects during
  text input, `kAXErrorInvalidUIElement` from the accessibility tree.
  Not a flow-author bug; it's a known prerelease-toolchain issue.
  Android (UIAutomator2) is more stable — when a flow needs to be
  long, validate it on Android first. See "Known caveats" in
  [README.md](README.md#known-caveats).
- **Selectors prefer accessibility text over coordinates.** RN
  components expose `accessibilityLabel` as the iOS-level
  accessibility text — Maestro's `tapOn: { text: "..." }` matches
  that. Coordinates rot the moment a layout changes.
- **Anchor with regex when you need exact text.** `tapOn: "Settings"`
  matches both the Home header gear icon (accessibility text
  "Settings") AND the "Check settings" body button. Use
  `tapOn: { text: "^Settings$" }` to isolate the gear.
- **Pre-flight checks are part of `setup()`.** The harness already
  fails loudly when no sim is booted, Centraid.app isn't installed,
  or Metro isn't reachable. Don't paper over those in a flow — fix
  the environment.

## When a flow fails

1. Read `runs/<runId>/verdict.md` — it has the error and notes.
2. Look at the last screenshot Maestro produced. The harness's own
   `screenshots/` dir holds whatever your flow captured via
   `takeScreenshot:`. Maestro's debug dir at
   `~/.maestro/tests/<timestamp>/` holds the failure screenshot
   (filename has `❌` in it) and `commands-(*).json` with per-step
   status and stack traces.
3. If the failure is a driver disconnect (`Failed to connect to
   /127.0.0.1:7001`, `kAXErrorInvalidUIElement`), it's the Maestro
   driver flaking — retry once. If it consistently flakes at the
   same step, simplify by batching directives or by switching the
   assertion to an on-disk check.
4. For "selector didn't match" failures, run
   `inspect_view_hierarchy` via MCP against the current sim state —
   the hierarchy at the moment of failure tells you what Maestro
   could and couldn't see.

## What not to do

- **Don't add retries inside a flow.** Flakiness is signal. Fix the
  selector, batch the directives, or move the assertion to disk.
- **Don't commit `runs/`.** It's gitignored — workspaces are tied
  to local sim UDIDs.
- **Don't call `process.exit()` from a flow.** Throw or return
  `{ pass: false }` and let `runFlow` handle the verdict.
- **Don't reach into `apps/mobile/ios/build/` or rebuild manually.**
  Run `bun run --filter=@centraid/mobile ios` once; the harness
  doesn't trigger builds (it errors loudly when the app isn't
  installed).
- **Don't use `clearState: true` without acknowledging the cost.**
  It wipes the Expo dev client's Metro URL cache along with
  AsyncStorage. The next launch may need a deep-link relaunch via
  `xcrun simctl openurl <udid> "dev.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`
  to recover.
- **Don't trust the UI alone for persistence assertions.** Read the
  AsyncStorage manifest from disk for round-trip claims.

## Where to look

- [README.md](README.md) — user-facing how-to and known caveats.
- [lib/harness.mjs](lib/harness.mjs) — `runFlow`, `setup`, sim/Metro
  preflight, ctx surface. Read this before adding a helper.
- [flows/home-loads.mjs](flows/home-loads.mjs) — canonical example
  flow (5 directives, runs in ~20s).
- [../agent-e2e-shared/harness.mjs](../agent-e2e-shared/harness.mjs) — shared run identity and verdict writer,
  parent of these conventions.
- [../../AGENTS.md](../../AGENTS.md) — repo-wide conventions agents
  must follow on top of these.
