# @centraid/builder-harness

Pi-coding-agent customization for **the centraid app builder** — an agent that authors centraid apps in the `@centraid/openclaw-plugin` format, plus helpers desktop and mobile surfaces use to scaffold and publish those apps.

> The in-app **data chat** (talking to a deployed app's SQLite over the chat panel) is a separate surface — see [`@centraid/chat-harness`](../chat-harness).

## Surfaces

| Function | Use |
| --- | --- |
| `createCentraidAgentSession({ projectDir, model? })` | Returns a pi `AgentSession` rooted at `projectDir` with the centraid system prompt appended. Subscribe / call `.prompt(text)` from your UI. |
| `scaffoldProject(projectsDir, id, { name?, version? })` | Creates `<projectsDir>/<id>/` with the canonical layout (index.html, app.json, package.json, tsconfig.json, queries/, actions/). |
| `listProjects(projectsDir)` | Enumerate existing projects (most-recent first), with a `built` flag. |
| `publishProject(projectDir, id, config, opts?)` | Run `bun run build` (or `tsc`), tarball the source, POST to `<gatewayUrl>/centraid/_apps/<id>/upload` with `Authorization: Bearer <gatewayToken>` (omitted when token empty). |
| `defaultHarnessConfig()` / `resolveHarnessConfig(overrides)` | Defaults: `projectsDir = ~/centraid-projects`, `gatewayUrl = http://127.0.0.1:18789`, `gatewayToken = ""`. |

## Auth

The publisher sends `Authorization: Bearer <gatewayToken>` when the token is non-empty. OpenClaw gateways configured with `auth.mode: "none"` (loopback only) accept requests without the header — leaving `gatewayToken` empty in that case is correct.

The token is the value of `gateway.auth.token` in `~/.openclaw/openclaw.json`. The desktop is expected to surface it as an editable setting; we never read the file directly.

## What gets uploaded

`publishProject` excludes from the tarball: `node_modules`, `.git`, `.DS_Store`, `dist`, `data.sqlite`, `current.json`, `_registry.json`, `versions`, `_uploads`, `_trash`, and any dotfile at the project root. Anything else under the project root is included.

The plugin's upload-side allowlist (extensions only — see `@centraid/openclaw-plugin`) is the second wall: an unexpected file gets rejected at the gateway.

## System prompt

`CENTRAID_APPEND_PROMPT` (also `centraidAppendPrompt()`) is exported so consumers can render it for debugging or layer their own additional context on top. It covers the authoring contract: folder layout, handler signatures, db semantics, migrations, security model.

### UI/UX grounding

`createCentraidAgentSession` also appends five generated blocks that ground the look and feel of authored apps:

| Block | Source |
| --- | --- |
| `### Design tokens` | `toCss()` from `@centraid/design-tokens` — the live CSS-variable contract (colors, radii, spacing, shadows) the shell uses. Tells the agent to write `var(--accent)` etc. and never hardcode. |
| `### Icon set` | The Lucide-style paths from `@centraid/design-tokens/icons.ts`. Inlined `<svg>` snippets the agent copy-pastes; no remote SVGs, no emoji-as-icon. |
| `### Component primitives` | Copy-pasteable HTML for the recurring shapes (header, button + input bar, list row, empty/loading/error). Matches the utility classes shipped in the scaffold's `app.css`. |
| `### UI/UX rules` | Non-negotiables: viewport/iframe contract, state triad (empty/loading/error), a11y floor (44px targets, focus-visible, semantic landmarks), motion (prefers-reduced-motion). |
| `### Reference exemplars` | Points the agent at the bundled `@centraid/app-templates/todos` and `journal` as canonical references. |

`buildUiGroundingBlocks({ withScreenshotTool? })` is also exported for debugging or for callers that compose their own prompt.

### Visual feedback loop

`createPreviewScreenshotTool({ capture })` returns a pi `ToolDefinition` you can pass into `customTools`. The agent calls it after meaningful visual changes and receives a PNG of the rendered preview as an `ImageContent` in the next turn.

The desktop wires this up via Electron's `webContents.capturePage()` clipped to the preview iframe's bounding rect — the agent sees the app, not the chat pane and chrome. Headless/CLI callers should omit the tool; the matching system-prompt guidance only turns on when the tool is registered (detected by name).

## What the scaffold writes

`scaffoldProject()` lays down a project that already passes the visual contract:

- `index.html` — runs an inline live-settings `<script>` synchronously before paint (handles URL-hash fallback for the builder preview path plus `centraid:theme` postMessage for live updates), then `tokens.css`, then `app.css`. The runtime bakes the initial `data-theme` / `--bg-l` into `<html>` server-side so first paint is correct without a script having to run.
- `tokens.css` — a frozen snapshot of `@centraid/design-tokens` at scaffold time. The app stays self-contained; re-running scaffold regenerates this if tokens evolve.
- `app.css` — utility classes (`.head`, `.add-bar`, `.list`, `.row`, `.surface`, `.primary`, `.ghost`, `.empty`, `.loading`, `.error`, etc.) styled entirely against `var(--…)` tokens, mobile-first with a 720px breakpoint, hit targets ≥ 44px, `:focus-visible` rings, `prefers-reduced-motion` respected.
