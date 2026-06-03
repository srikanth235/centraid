# issue-180 — Remove dead gateway/runtime defaults from the settings fallback

GitHub issue: [#180](https://github.com/srikanth235/centraid/issues/180)

Cleanup flagged during [#176](https://github.com/srikanth235/centraid/issues/176).

## Checklist

- [x] Trim the settings fallback object to only the field that is read

## What changed

**Trim the settings fallback object to only the field that is read.** In
`renderSettingsAsync` (`apps/desktop/src/renderer/app.ts`) the `getSettings()`
`.catch` fallback carried six leftover fields from the retired local/remote
toggle form — `gatewayUrl`, `gatewayToken`, `appsDir`, `runtimeMode`,
`remoteGatewayUrl`, `remoteGatewayToken`. Only `current.chatModel` is read off
that object (the chat-picker seed), so the fallback is reduced to
`{ chatModel: undefined }`, with a comment noting why.

## Out of scope

- The real `CentraidSettings` type (unchanged — `getSettings` still returns the
  full shape; this only touches the unreachable-path fallback literal).

## Verification

- `apps/desktop` typecheck — clean.
- oxlint + oxfmt clean on the changed file.
