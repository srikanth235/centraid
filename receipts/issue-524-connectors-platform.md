# Receipt — Issue #524: Connectors platform

Issue: https://github.com/srikanth235/centraid/issues/524

## Checklist

- [x] Connectors is a top-level sidebar route (not only Settings subpage)
- [x] Google/Microsoft tiles show OAuth 2.0; detail shows redirect URI + Save & authorize
- [x] Automations can bind a concrete connectionId for a connector
- [x] Provider presets expose capabilities (syncs/actions)
- [x] Additional pull blueprints registered in index/manifest
- [x] Unit tests for connector platform + connections UI paths
- [x] Receipt + PR

## What changed

Connectors is a top-level sidebar route (not only Settings subpage):

- `packages/client/src/react/shell/Sidebar.tsx` — Connectors + Automations above Pages; Discover kept
- `packages/client/src/react/shell/Sidebar.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/router.ts`
- `packages/client/src/react/shell/router.test.ts`
- `packages/client/src/react/shell/routes/ConnectorsRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/types.d.ts`
- `packages/client/src/react/screens/SettingsProvidersAgents.tsx`
- `README.md`

Google/Microsoft tiles show OAuth 2.0; detail shows redirect URI + Save & authorize:

- `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`
- `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx`
- `packages/client/src/react/shell/routes/settingsConnectionsData.ts`
- `packages/client/src/react/shell/routes/settingsConnectionsData.test.ts`
- `packages/client/src/gateway-client-connections.ts` — oauthCallbackUri
- `packages/client/src/react/screens/connectorBrandMarks.tsx`
- `scripts/fetch-connector-brand-icons.mjs`

Automations can bind a concrete connectionId for a connector:

- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/fire/connector.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/serve/connection-broker.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.module.css`
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx`
- `packages/client/src/react/screens/AutomationEditorTriggers.test.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.module.css`
- `packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx`
- `packages/client/src/react/shell/routes/AutomationsRoute.tsx`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/shell/routes/templatesData.ts`
- `packages/client/src/react/shell/routes/templatesData.test.ts`
- `apps/desktop/tests/e2e/automations.spec.ts` — targets the automation name field by its stable accessible label after the editor copy changed.

Provider presets expose capabilities (syncs/actions):

- `packages/gateway/src/routes/connection-providers.ts`
- `packages/gateway/src/routes/connection-providers.test.ts`
- `packages/gateway/src/routes/connections-routes.ts`
- `packages/gateway/src/routes/connections-routes.test.ts`
- `packages/client/src/react/shell/routes/connectorPlatform.ts`
- `packages/client/src/react/shell/routes/connectorPlatform.test.ts`
- `packages/client/src/react/shell/routes/connectorAssistantTools.ts`

Additional pull blueprints registered in index/manifest:

- `packages/blueprints/index.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/automations/dropbox-pull/app.json`
- `packages/blueprints/automations/dropbox-pull/automations/dropbox-pull/automation.json`
- `packages/blueprints/automations/dropbox-pull/automations/dropbox-pull/handler.js`
- `packages/blueprints/automations/gitlab-pull/app.json`
- `packages/blueprints/automations/gitlab-pull/automations/gitlab-pull/automation.json`
- `packages/blueprints/automations/gitlab-pull/automations/gitlab-pull/handler.js`
- `packages/blueprints/automations/google-drive-pull/app.json`
- `packages/blueprints/automations/google-drive-pull/automations/google-drive-pull/automation.json`
- `packages/blueprints/automations/google-drive-pull/automations/google-drive-pull/handler.js`
- `packages/blueprints/automations/linear-pull/app.json`
- `packages/blueprints/automations/linear-pull/automations/linear-pull/automation.json`
- `packages/blueprints/automations/linear-pull/automations/linear-pull/handler.js`
- `packages/blueprints/automations/microsoft-calendar-pull/app.json`
- `packages/blueprints/automations/microsoft-calendar-pull/automations/microsoft-calendar-pull/automation.json`
- `packages/blueprints/automations/microsoft-calendar-pull/automations/microsoft-calendar-pull/handler.js`
- `packages/blueprints/automations/microsoft-contacts-pull/app.json`
- `packages/blueprints/automations/microsoft-contacts-pull/automations/microsoft-contacts-pull/automation.json`
- `packages/blueprints/automations/microsoft-contacts-pull/automations/microsoft-contacts-pull/handler.js`
- `packages/blueprints/automations/microsoft-onedrive-pull/app.json`
- `packages/blueprints/automations/microsoft-onedrive-pull/automations/microsoft-onedrive-pull/automation.json`
- `packages/blueprints/automations/microsoft-onedrive-pull/automations/microsoft-onedrive-pull/handler.js`
- `packages/blueprints/automations/microsoft-outlook-pull/app.json`
- `packages/blueprints/automations/microsoft-outlook-pull/automations/microsoft-outlook-pull/automation.json`
- `packages/blueprints/automations/microsoft-outlook-pull/automations/microsoft-outlook-pull/handler.js`
- `packages/blueprints/automations/notion-pull/app.json`
- `packages/blueprints/automations/notion-pull/automations/notion-pull/automation.json`
- `packages/blueprints/automations/notion-pull/automations/notion-pull/handler.js`
- `packages/blueprints/automations/slack-pull/app.json`
- `packages/blueprints/automations/slack-pull/automations/slack-pull/automation.json`
- `packages/blueprints/automations/slack-pull/automations/slack-pull/handler.js`
- `packages/blueprints/automations/todoist-pull/app.json`
- `packages/blueprints/automations/todoist-pull/automations/todoist-pull/automation.json`
- `packages/blueprints/automations/todoist-pull/automations/todoist-pull/handler.js`

Unit tests for connector platform + connections UI paths: covered by the `.test.ts` / `.test.tsx` files listed above.

Receipt + PR: this file `receipts/issue-524-connectors-platform.md` and the PR opened for issue #524.

## Out of scope

- Hosted/shared Centraid OAuth app or token handoff for self-hosters who skip BYO
- Webhook ingress, multi-tenant connection tags
- Product copy or docs naming third-party iPaaS platforms
- Full assistant tool execution backend beyond client-side descriptors from healthy connections

## Decisions

- Keep #304 BYO OAuth only in this PR; hosted assist is a separate product track.
- Durable binding is soft `connections[]` with optional `connectionId` (not hard fail if unbound for legacy templates).
- Connectors top-level route reuses SettingsConnectionsScreen presentation rather than a second gallery implementation.
- Brand marks + optional icon fetch script; no third-party platform names in product strings.

## Verification

```
bun run --filter @centraid/client test -- src/react/shell/routes/connectorPlatform.test.ts src/react/shell/routes/settingsConnectionsData.test.ts src/react/screens/SettingsConnectionsScreen.test.tsx src/react/screens/AutomationEditorScreen.test.tsx src/react/shell/Sidebar.test.tsx
bun run --filter @centraid/gateway test -- src/routes/connection-providers.test.ts src/routes/connections-routes.test.ts
bun run --filter @centraid/automation test -- src/fire/connector.test.ts
bun run --cwd apps/desktop test:e2e -- tests/e2e/automations.spec.ts
bun run --filter @centraid/client typecheck
bun run --filter @centraid/gateway typecheck
bun run --filter @centraid/automation typecheck
```

## Audit

**Check 1 — What changed faithfully describes the diff**
PASS – Receipt enumerates client shell/Connectors UI, OAuth helpers, automation connectionId binding, gateway capabilities, every new pull blueprint path, and tests in the change set.

**Check 2 — All checked checklist items are realized in the diff**
PASS – Each acceptance item has corresponding code: sidebar route, OAuth detail UX, connectionId binding, capabilities, pull blueprints, tests, this receipt (+ PR).

**Check 3 — Checklist mirrors the issue**
PASS – Checklist matches issue #524 acceptance criteria.

## Accounting

### Steering

(no rows — no interrupt/correction events recorded for this change set)

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f8e48-8ec-1784814585-1 | codex | 019f8e48-8ec9-7800-9630-fb1e00b1121b | #524 | gpt-5.6-sol | 131313 | 0 | 7711232 | 8230 | 139543 | 2.3795 | 2841599 | 0 | 111222272 | 261813 | test(desktop): use stable automation name selector (#524) |
## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting**
PASS – No interrupt or mid-task correction events; empty steering table is correct.

**Check 2 — no non-steering message is recorded as a steering event**
PASS – No false-positive steering rows.
