# template-gate

**Goal:** the per-template mobile compatibility gate (issue #263). Every
bundled UI template (kind `app` in `packages/blueprints/index.json`) must
open and render inside the phone's WebView — the mobile shell is a viewer
for published apps, so a template that renders on desktop but not on the
phone is a regression this flow catches.

**Setup:**

- Everything `home-loads.md` needs (installed dev build, booted device,
  Metro on `:8081`).
- A running gateway the flow can install/delete against over plain
  HTTP. Base + token come from env:
  - `MAESTRO_GATEWAY_URL` (default `http://127.0.0.1:18789`)
  - `MAESTRO_GATEWAY_TOKEN` (omit when the dev gateway runs token-less)
- **The phone must reach the same gateway.** The flow clears app state and
  saves `MAESTRO_GATEWAY_URL` (plus the optional token) through the real
  Settings → Advanced UI before installing. Nightly CI supplies a loopback-only,
  tokenless real gateway host because a manual-mode WebView cannot attach a
  bearer. A real phone may instead use its paired tunnel in exploratory runs.
- Optional: `MAESTRO_TEMPLATES=notes,tasks` to gate a subset (useful on
  iOS, where long flows hit driver disconnects — see README caveats;
  prefer Android for the full sweep).

**Steps (per template):**

1. Clear state and save the declared gateway through Settings → Advanced.
2. Up front: `POST /centraid/_apps/_install` with `{templateId}` for every
   gated UI template. Install, not clone: since #434 a bundled blueprint app is
   registered IN PLACE — a consent row plus grants, copying no code — and
   `_clone` now rejects bundled ids outright. The route is idempotent and
   reports `alreadyInstalled`, so no publish step is needed.
3. Relaunch the app (fresh launch lands on Home; Home re-fetches the app
   list on focus), scroll until the app's tile is visible, tap it. The tile
   is matched by its accessibility label — `Open <name>` — not by the tile
   title: the card is a Pressable with an `accessibilityLabel`, which on iOS
   collapses its children so the title `<Text>` is not its own node.
4. Wait up to 30s for the app's header/title to render **inside the
   WebView** — the marker is the template's own `<h1>` (or `<title>`)
   scraped from `packages/blueprints/apps/<id>/index.html`, with the
   registered app name accepted as an alternative. The native AppHeader
   alone doesn't count: it renders even when the web document fails.
5. Assert the shell's error states ("Could not load app", "Not connected")
   are absent, screenshot as `<appId>.png`.

**Scope — which apps are gated.** `photos`, `docs` and `agenda` are
implemented NATIVELY by the mobile shell (`NATIVE_APPS` in
`apps/mobile/src/screens/Home.tsx`; `openApp` navigates to a native screen for
each), so they have no web document and this gate's premise does not apply.
They are excluded rather than asserted loosely — a gate that cannot fail is
worse than one that does not run. That leaves five WebView apps: tasks, people,
notes, locker, tally. Keep `NATIVE_ON_MOBILE` in the flow in sync with
`NATIVE_APPS`; drift means a WebView app silently goes ungated.

**Cleanup:** every app this run installed is deleted
(`DELETE /centraid/_apps/<id>`) in a `finally` block. Apps the vault already
had — reported by `alreadyInstalled` — are left alone, so the flow never
removes something it did not create.

**Verdict:** PASS only when every template rendered. Per-template failures
are collected (the flow keeps going so one broken template doesn't hide
the rest) and listed in the FAIL verdict. Common causes: the declared gateway
not running or reachable from the device, Settings input failing, or a template
whose UI genuinely breaks in a mobile WebView — the thing this gate exists to
catch.
