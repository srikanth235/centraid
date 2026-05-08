# @centraid/agent-harness

Pi-coding-agent customization for **authoring centraid apps**, plus helpers desktop and mobile surfaces use to scaffold and publish those apps.

## Surfaces

| Function | Use |
| --- | --- |
| `createCentraidAgentSession({ projectDir, model? })` | Returns a pi `AgentSession` rooted at `projectDir` with the centraid system prompt appended. Subscribe / call `.prompt(text)` from your UI. |
| `scaffoldProject(projectsDir, id, { name?, version? })` | Creates `<projectsDir>/<id>/` with the canonical layout (index.html, app.json, package.json, tsconfig.json, queries/, actions/, crons/). |
| `listProjects(projectsDir)` | Enumerate existing projects (most-recent first), with a `built` flag. |
| `publishProject(projectDir, id, config, opts?)` | Run `bun run build` (or `tsc`), tarball the source, POST to `<gatewayUrl>/centraid/_apps/<id>/upload` with `Authorization: Bearer <gatewayToken>` (omitted when token empty). |
| `defaultHarnessConfig()` / `resolveHarnessConfig(overrides)` | Defaults: `projectsDir = ~/centraid-projects`, `gatewayUrl = http://127.0.0.1:7575`, `gatewayToken = ""`. |

## Auth

The publisher sends `Authorization: Bearer <gatewayToken>` when the token is non-empty. OpenClaw gateways configured with `auth.mode: "none"` (loopback only) accept requests without the header — leaving `gatewayToken` empty in that case is correct.

The token is the value of `gateway.auth.token` in `~/.openclaw/openclaw.json`. The desktop is expected to surface it as an editable setting; we never read the file directly.

## What gets uploaded

`publishProject` excludes from the tarball: `node_modules`, `.git`, `.DS_Store`, `dist`, `data.sqlite`, `current.json`, `_registry.json`, `versions`, `_uploads`, `_trash`, and any dotfile at the project root. Anything else under the project root is included.

The plugin's upload-side allowlist (extensions only — see `@centraid/openclaw-plugin`) is the second wall: an unexpected file gets rejected at the gateway.

## System prompt

`CENTRAID_APPEND_PROMPT` (also `centraidAppendPrompt()`) is exported so consumers can render it for debugging or layer their own additional context on top.
