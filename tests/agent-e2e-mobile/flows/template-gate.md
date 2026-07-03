# template-gate

**Goal:** the per-template mobile compatibility gate (issue #263). Every
bundled UI template (kind `app` in `packages/blueprints/index.json`) must
open and render inside the phone's WebView — the mobile shell is a viewer
for published apps, so a template that renders on desktop but not on the
phone is a regression this flow catches.

**Setup:**

- Everything `home-loads.md` needs (installed dev build, booted device,
  Metro on `:8081`).
- A running gateway the flow can clone/publish/delete against over plain
  HTTP. Base + token come from env:
  - `MAESTRO_GATEWAY_URL` (default `http://127.0.0.1:18789`)
  - `MAESTRO_GATEWAY_TOKEN` (omit when the dev gateway runs token-less)
- **The phone must reach the same gateway.** Either the device is *paired*
  (the tunnel proxies everything to that desktop's gateway — the normal
  path on a real phone), or it's a simulator with the same dev gateway URL
  saved under Settings → Advanced (developer). The flow does not drive the
  Settings screen itself — driver text input is the flakiest Maestro
  operation on iOS, so configuration is a precondition, not a step.
- Optional: `MAESTRO_TEMPLATES=notes,tasks` to gate a subset (useful on
  iOS, where long flows hit driver disconnects — see README caveats;
  prefer Android for the full sweep).

**Steps (per template):**

1. Up front: `POST /centraid/_apps/_clone` with
   `{templateId, publish: true}` for every UI template — publish makes the
   clone live immediately, no session dance.
2. Relaunch the app (fresh launch lands on Home; Home re-fetches the app
   list on focus), scroll until the clone's tile is visible, tap it.
3. Wait up to 30s for the app's header/title to render **inside the
   WebView** — the marker is the template's own `<h1>` (or `<title>`)
   scraped from `packages/blueprints/apps/<id>/index.html`, with the
   clone's minted name accepted as an alternative. The native AppHeader
   alone doesn't count: it renders even when the web document fails.
4. Assert the shell's error states ("Could not load app", "Not connected")
   are absent, screenshot as `<appId>.png`.

**Cleanup:** every clone is deleted (`DELETE /centraid/_apps/<id>`) in a
`finally` block, so repeat runs don't accumulate "Notes 2, Notes 3…" tiles.

**Verdict:** PASS only when every template rendered. Per-template failures
are collected (the flow keeps going so one broken template doesn't hide
the rest) and listed in the FAIL verdict. Common causes: phone not
paired / no gateway URL saved in the app, the gateway not running, or a
template whose UI genuinely breaks in a mobile WebView — the thing this
gate exists to catch.
