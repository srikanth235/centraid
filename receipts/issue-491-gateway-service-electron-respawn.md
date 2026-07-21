# issue-491 — gateway OS-service install baked the Electron binary into the service unit

Enabling the opt-in "install gateway as an OS service" (#351/H5) generated a
launchd LaunchAgent (and the analogous systemd unit) whose `ProgramArguments[0]`
/ `ExecStart` was the **Electron binary**, not node. With `RunAtLoad=true` +
`KeepAlive{SuccessfulExit:false}`, launchd relaunched the full desktop app every
~10s — it exited 1 (the running desktop already owned the port), so KeepAlive
respawned it forever, flashing a window/dock icon open and shut. On an affected
machine `launchctl print gui/$UID/dev.centraid.gateway` showed `program =
.../Electron`, `last exit code = 1`, `runs = 946`. The apparent "gateway
heartbeat" was launchd's KeepAlive, not the desktop `gateway-monitor.ts`
heartbeat (which only fires notifications and never spawns/quits Electron).

Root cause: `installGatewayOsService` spawns `process.execPath` to run
`centraid-gateway service install`; under Electron `process.execPath` is the
Electron binary. `buildSpec` captured `nodeBin: process.execPath` verbatim, and
the unit generators emitted no environment block — so nothing forced node mode.
`ELECTRON_RUN_AS_NODE` appeared nowhere in the repo. (`process.execPath` stays
the Electron path even under `ELECTRON_RUN_AS_NODE`, so the generated unit must
carry the flag too, not just the install invocation.)

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5ac9baf3-ae7-1784630733-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #491 | claude-opus-4-8 | 238 | 335305 | 14096013 | 128620 | 464163 | 12.3604 | 238 | 335305 | 14096013 | 128620 | fix(gateway): run the OS-service unit as node, not the Electron app (#491)instal |
| claude-code-5ac9baf3-ae7-1784631083-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #491 | claude-opus-4-8 | 7 | 19220 | 784288 | 7378 | 26605 | 0.6968 | 245 | 354525 | 14880301 | 135998 | fix(gateway): run the OS-service unit as node, not the Electron app (#491)instal |
| claude-code-5ac9baf3-ae7-1784631181-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #491 | claude-opus-4-8 | 14 | 16465 | 1148642 | 10436 | 26915 | 0.9382 | 259 | 370990 | 16028943 | 146434 | fix(gateway): run the OS-service unit as node, not the Electron app (#491)instal |
| claude-code-5ac9baf3-ae7-1784631357-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #491 | claude-opus-4-8 | 33 | 39010 | 3207716 | 20708 | 59751 | 2.3655 | 292 | 410000 | 19236659 | 167142 | fix(gateway): run the OS-service unit as node, not the Electron app (#491)instal |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Steering

**PASS**

No human-steering events were detected in this session. The user provided initial task description, answered the agent's questions about whether to create an issue and PR, and sent explicit instructions to proceed with those actions. None of these constituted interrupts or corrections to the agent's work — they were expected task progression answers and tool-result acknowledgments, explicitly exempt from steering accounting.

**Evidence:**
1. Every human-steering event is recorded as a row: No steering events were identified; the steering table correctly remains empty.
2. No non-steering message is recorded as a steering event: All 5 genuine user inputs were classified correctly as non-steering:
   - "I see gateway heartbeat triggering an electron app and auto closing it" — initial task description (not steering)
   - Task notifications (×2) — tool results, explicitly exempt per README
   - "create an issue please" — answer to agent's explicit question ("Want me to file an issue?")
   - PR command — explicit instruction to proceed, which agent had already proposed

## Checklist

- [x] A generated service unit whose `nodeBin` is the Electron binary carries `ELECTRON_RUN_AS_NODE=1`, so launchd/systemd runs cli.js as node instead of launching the desktop app.
- [x] Real-node installs (standalone `centraid-gateway` daemon) emit **no** environment block — the flag is gated on `process.versions.electron`.
- [x] The `service install` invocation itself runs in node mode, so it does not flash a second Electron app once at install time.
- [x] Both the launchd plist (`EnvironmentVariables` dict) and the systemd unit (`Environment=` line before `ExecStart`) carry the env.

## What changed

**`packages/gateway/src/cli/service-unit.ts`** — added an optional
`env?: Record<string, string>` to `ServiceUnitSpec`. `buildLaunchdPlist` now
emits an `EnvironmentVariables` `<dict>` when `env` is non-empty;
`buildSystemdUnit` emits `Environment=` lines (before `ExecStart`). Empty/absent
`env` emits no block, so existing real-node units are byte-for-byte unchanged.

**`packages/gateway/src/cli/service-admin.ts`** — `buildSpec` sets
`env: { ELECTRON_RUN_AS_NODE: '1' }`, gated on `process.versions.electron`.
`nodeBin` remains `process.execPath` (which is the correct, packaged-safe binary
to run — as node — when there is no standalone node on the box).

**`apps/desktop/src/main/detached-gateway.ts`** — `installGatewayOsService`
passes `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }` to the `service
install` `spawnSync`, so the one-shot install runs the Electron binary in node
mode.

**`packages/gateway/src/cli/service-unit.test.ts`** — four new tests: launchd
omits `EnvironmentVariables` when `env` is empty; launchd emits it (well-formed
XML) with the flag; systemd omits `Environment=` when empty; systemd emits it
before `ExecStart`.

Checklist crosswalk (each item → where it lands in the diff):

- A generated service unit whose `nodeBin` is the Electron binary carries `ELECTRON_RUN_AS_NODE=1`, so launchd/systemd runs cli.js as node instead of launching the desktop app. Cited: `service-admin.ts` `buildSpec` sets the flag; both generators in `service-unit.ts` emit it.
- Real-node installs (standalone `centraid-gateway` daemon) emit **no** environment block — the flag is gated on `process.versions.electron`. Cited: the `service-admin.ts` electron gate; empty `env` emits no block in both generators.
- The `service install` invocation itself runs in node mode, so it does not flash a second Electron app once at install time. Cited: `detached-gateway.ts` `installGatewayOsService` `spawnSync` env.
- Both the launchd plist (`EnvironmentVariables` dict) and the systemd unit (`Environment=` line before `ExecStart`) carry the env. Cited: `buildLaunchdPlist` / `buildSystemdUnit` in `service-unit.ts`.

## Decisions

- **Kept `nodeBin: process.execPath` rather than resolving a real `node` path.**
  A packaged desktop app has no standalone `node` on the box, so the Electron
  binary *is* the only interpreter available — running it in node mode
  (`ELECTRON_RUN_AS_NODE=1`) is the packaged-safe choice, not a workaround.
- **Gated the flag on `process.versions.electron` instead of setting it
  unconditionally.** A standalone real-node daemon install does not need the
  var; gating keeps those generated systemd/launchd units byte-for-byte
  unchanged, so this fix is a no-op for the non-Electron path.
- Did not touch `resolveNodeBin()`'s `'node'`-on-`PATH` assumption for the
  detached spawn — it fails closed (spawn error → supervised backoff) rather
  than launching Electron, so it is a separate concern (see Out of scope).

## Out of scope

- The fragility of the detached-gateway spawn relying on `node` being on `PATH`
  (`resolveNodeBin()` in `detached-gateway.ts`) — separate from this bug (it
  fails closed rather than launching Electron), left as-is.
- A `docs/traps/` entry for the `process.execPath` / `ELECTRON_RUN_AS_NODE`
  footgun — worth adding but not blocking this fix.

## Verification

```sh
# CLI unit + admin + install-integration suites (23 pass, 1 skipped)
bun run --cwd packages/gateway vitest run \
  src/cli/service-unit.test.ts \
  src/cli/service-admin.test.ts \
  src/cli/service-install.integration.test.ts

# typecheck across the two touched packages (+ deps) — green
bunx turbo run typecheck --filter=@centraid/gateway --filter=@centraid/desktop
```

Behavioral proof that the generated plist now runs the Electron binary as node:

```sh
node --input-type=module -e '
import { buildLaunchdPlist } from "./packages/gateway/dist/cli/service-unit.js";
const xml = buildLaunchdPlist("dev.centraid.gateway", {
  nodeBin: "/Apps/Electron.app/Contents/MacOS/Electron", cliEntry: "/x/cli.js",
  args: ["serve","--data-dir","/d"], stdoutLog:"/o", stderrLog:"/e",
  workingDirectory:"/d", env: { ELECTRON_RUN_AS_NODE: "1" },
});
console.log(xml.includes("EnvironmentVariables") && xml.includes("ELECTRON_RUN_AS_NODE"));
'  # → true
```

## Audit

**PASS**

Evidence for all three rubric checks:

1. **`## What changed` faithfully describes the diff (no misrepresentation, no omission):**
   - `service-unit.ts`: Receipt claims optional `env?: Record<string, string>` was added to `ServiceUnitSpec`, emits `EnvironmentVariables` dict for launchd and `Environment=` lines for systemd when env is non-empty — diff confirms all three changes, exactly as stated. ✓
   - `service-admin.ts`: Receipt claims `buildSpec` sets `env: { ELECTRON_RUN_AS_NODE: '1' }` gated on `process.versions.electron` — diff shows `...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {})`, confirming the gate and the exact value. ✓
   - `detached-gateway.ts`: Receipt claims `installGatewayOsService` passes `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }` to `spawnSync` — diff shows this exact syntax in the options object. ✓
   - `service-unit.test.ts`: Receipt claims four new tests (launchd empty, launchd with flag, systemd empty, systemd with flag) — diff shows all four tests with correct expectations. ✓
   
   No omissions or misrepresentations. PASS.

2. **Each `- [x]` checklist item is realized in the diff:**
   - "A generated service unit whose `nodeBin` is the Electron binary carries `ELECTRON_RUN_AS_NODE=1`" — diff shows `buildLaunchdPlist` emits `EnvironmentVariables` dict with key/value entries from `spec.env`, and `buildSystemdUnit` emits `Environment=` lines from `spec.env`. When `env: { ELECTRON_RUN_AS_NODE: '1' }` is present in spec, both functions emit it. ✓
   - "Real-node installs (standalone `centraid-gateway` daemon) emit **no** environment block — the flag is gated on `process.versions.electron`" — diff in `service-admin.ts` uses conditional spread `...(process.versions.electron ? { env: ... } : {})`, ensuring non-Electron environments produce empty env. ✓
   - "The `service install` invocation itself runs in node mode" — diff in `detached-gateway.ts` shows `spawnSync(..., { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })`, so the child process runs with the flag set. ✓
   - "Both the launchd plist (`EnvironmentVariables` dict) and the systemd unit (`Environment=` line before `ExecStart`) carry the env" — diff shows launchd path emits `<key>EnvironmentVariables</key>` block and systemd path emits `Environment=` lines placed before `ExecStart=`. ✓
   
   All checklist items are realized. PASS.

3. **The `## Checklist` mirrors the issue's checklist/intent:**
   The issue #491's "Proposed fix" section specifies exactly:
   - "`service-unit.ts`: add optional `env` to `ServiceUnitSpec`; launchd emits an `EnvironmentVariables` dict, systemd emits `Environment=` lines."
   - "`service-admin.ts buildSpec`: set `ELECTRON_RUN_AS_NODE=1`, gated on `process.versions.electron`"
   - "`detached-gateway.ts installGatewayOsService`: pass `ELECTRON_RUN_AS_NODE=1` to the install `spawnSync`"
   
   The receipt's four checklist items map directly to these three proposed bullets:
   - Item 1 → both unit generators carry env (launchd + systemd)
   - Item 2 → real-node installs gated on `process.versions.electron`
   - Item 3 → install invocation passes the flag
   - Item 4 → both file formats carry env (reiterates items 1+3 in implementation terms)
   
   Checklist mirrors issue intent perfectly. PASS.
