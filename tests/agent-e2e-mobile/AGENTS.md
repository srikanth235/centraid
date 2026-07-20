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

## Conventions specific to this layer

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
  "Settings") AND the "Open Settings" / "Check Settings" body
  buttons. Use `tapOn: { text: "^Settings$" }` to isolate the gear.
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
