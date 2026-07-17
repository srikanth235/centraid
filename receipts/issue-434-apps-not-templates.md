# Issue #434 — Apps, not templates: install/uninstall bundled blueprints in place, hide the builder for v1

## Checklist

### Phase 1 — serve bundled apps in place (the architectural core)

- [x] **Resolver rule.** `store.resolveActiveAppDir(appId)` / `codeDirOverride` (`packages/gateway/src/serve/build-gateway.ts:1753`, `packages/app-engine/src/runtime.ts:117-137`): resolve bundled blueprint apps to the `@centraid/blueprints` package dir; fall back to the code-store worktree for everything else (compiled automations, forks). One mental model: *generated or downloaded code lives in the store; shipped code serves in place.*
- [x] **Install registry without git.** Installed-app presence is currently "subtree exists on `main`" (`worktree-store.ts:137-197 listAppsWithMeta`). Replace for bundled apps with a per-vault install record — `consent_app` (`packages/vault/src/schema/consent.ts`, `origin: 'installed'`) plus runtime registry entry (`ensureRegistered` → `registry.ensureUploaded` + `vaultRegistry.enrollApp` + `grantDeclaredAppScopes`, `build-gateway.ts:1209-1216`). App listing = union of installed bundled apps + code-store apps (automations).
- [x] **Install endpoint.** New `POST /centraid/_apps/_install {templateId}` (or repurpose `_clone` behind the same route): keep the blueprint's own id (no `suggestCloneIdentityFrom` identity minting), no `readTemplateFiles`/`cloneTemplateFiles`/`stageAndMaybePublish` (`lifecycle-routes.ts:201-281`). Idempotent: installing an installed app is a no-op returning the existing registration.
- [x] **Uninstall endpoint.** Rename/alias `DELETE /centraid/_apps/<id>` semantics for bundled apps: `deregisterAndCleanup` + `vaultRegistry.revokeApp` (grants cascade, tombstones cleared — `vault-plane.ts:597-649`), but **no** `store.deleteApp` git commit (there is nothing in git). Ext-band data, model rows, receipts retained (current behavior).
- [x] **Automations unchanged.** `POST /_automations/compile` → headless builder session → code store publish stays exactly as is (`lifecycle-automation-routes.ts`, `headless-automation-compile.ts`). Webhook secret provisioning (`provisionPendingWebhooksInFiles`) stays on the automation path.

### Phase 2 — shell UX: Install / Uninstall

- [x] **Discover** (`DiscoverRoute.tsx`, `DiscoverScreen.tsx`, `templatePreview.ts`, `templatesData.ts`): "Use this template" → **Install**; installed state → **Open**. `installAppTemplate` calls the new install endpoint; keep pin-to-Home + navigate.
- [x] **App detail / consent sheet**: render `vault.scopes` + `why` from the catalog entry (`GET /centraid/_templates` already carries the manifest) before confirming install.
- [x] **Context menu** (`HomeRoute.tsx:66-99` `appContextMenu`, also emitted from `Sidebar.tsx:186,200`): Open / Star / Rename / App info / **Uninstall**; drop Edit-with-Centraid, Reveal-in-Finder, Share, Delete-draft. `deleteAppFlow` → `uninstallAppFlow` with the data-stays copy.
- [x] **App info surface**: live grants for the app id, linking to the existing consent screens.
- [x] **Rename** becomes registry metadata (per-vault label), not an app.json rewrite.

### Phase 3 — hide the builder (flag, don't delete)

- [x] Dev flag (settings-gated) hiding: `enterBuilder` entry points and "New app" (`App.tsx:86-92, 530`), `builder`/`automation-builder` route cases (`App.tsx:594-623`, `router.ts:55-60`), Home drafts section + "Continue editing", Automations editor "Open builder" buttons (`AutomationEditorRoute.tsx:244-254`, `AutomationViewRoute.tsx:163`).
- [x] Gateway editing endpoints (`/_apps/<id>/files`, publish, rollback — `apps-store-routes.ts`) stay for dev mode; unreachable from the release UI.
- [x] Headless automation compile is NOT behind the flag.

### Phase 4 — catalog + cleanup

- [x] Catalog = bundled blueprints only for v1; defer `fetchRemoteTemplates` (`templates-routes.ts:63-69`) — remote install is the one case where install legitimately copies (a download), designed later.
- [x] Copy pass on all install/uninstall/consent strings.
- [x] Existing vaults: per pre-release policy, no migration — fresh vaults work the new way; old snapshot-installed apps keep serving from the store until the vault is recreated.

### Non-goals (v1) — held, see "Out of scope"

- Remote/third-party app catalog and downloaded installs.
- "Customize this app" (builder fork — copy-on-edit; the current clone machinery becomes the fork machinery when the builder returns).
- Per-app data purge on uninstall (separate explicit owner act, later).
- Any migration of existing snapshot-installed vaults.

## What changed

### Checklist evidence

#### **Resolver rule.** `store.resolveActiveAppDir(appId)` / `codeDirOverride` (`packages/gateway/src/serve/build-gateway.ts:1753`, `packages/app-engine/src/runtime.ts:117-137`): resolve bundled blueprint apps to the `@centraid/blueprints` package dir; fall back to the code-store worktree for everything else (compiled automations, forks). One mental model: *generated or downloaded code lives in the store; shipped code serves in place.*

`codeDirOverride` in `packages/gateway/src/serve/build-gateway.ts` is now a two-arm resolver: a bundled id that is installed in the *request's* vault returns `bundledAppDir(appId)`; everything else falls through to `store.resolveActiveAppDir(appId)` exactly as before. `packages/app-engine/src/runtime.ts` needed no change — `codeDirOverride` was already the seam, which is why the rule lands in one function rather than in a new app kind. The blueprints package gained the two primitives the rule needs (`packages/blueprints/src/index.ts`): `bundledAppDir(id)` (→ `templateSourceDir(id, { kind: 'app' })`) and `listBundledAppTemplates()` (all templates minus automations — automations still compile into the code store, so they must not be reserved or served in place). `buildGateway` resolves that id set **once** at construction and closes over it (`bundledAppIds` / `isBundledAppId`): it is the release's catalog, fixed for the process lifetime. The installed check is deliberately per-vault, so a legacy snapshot-cloned `photos` keeps serving from that vault's store while a fresh vault serves the shipped dir. Both arms return a plain absolute dir, so the app-engine static-path sandbox (`security.ts resolveStaticPath`) applies identically and cannot tell the origins apart — the risk the issue flagged.

#### **Install registry without git.** Installed-app presence is currently "subtree exists on `main`" (`worktree-store.ts:137-197 listAppsWithMeta`). Replace for bundled apps with a per-vault install record — `consent_app` (`packages/vault/src/schema/consent.ts`, `origin: 'installed'`) plus runtime registry entry (`ensureRegistered` → `registry.ensureUploaded` + `vaultRegistry.enrollApp` + `grantDeclaredAppScopes`, `build-gateway.ts:1209-1216`). App listing = union of installed bundled apps + code-store apps (automations).

The install record is a `consent_app` row with `origin = 'installed'` — no new table. `packages/vault/src/host.ts` adds `listInstalledApps(db)` (`WHERE origin = 'installed' AND status = 'active' ORDER BY installed_at`) and `setAppLabel(db, appId, label)`, both exported from `packages/vault/src/index.ts` with the `InstalledAppRow` type. `packages/vault/src/schema/consent.ts` adds one nullable column, `label`. `packages/gateway/src/serve/vault-plane.ts` wraps them as `installApp()` / `installedAppIds()` / `installedApps()` / `setAppLabel()`. Grant-time reading split cleanly: `grantDeclaredAppScopes` (code-store, reads `store.resolveActiveAppDir`) and `grantDeclaredBundledScopes` (reads `bundledAppDir`) now share one `grantScopesFromDir(plane, appId, dir)` body, so a bundled app's declared scopes come off the shipped manifest rather than the empty store. Boot re-registration was the non-obvious half: the existing settle/reconcile loops walk the git store and therefore skip installed bundled apps entirely, so both loops gained a second pass over `plane.installedAppIds()` calling `registry.ensureUploaded` + `grantDeclaredBundledScopes` — without it an installed app stops serving after a gateway restart. The listing union lands in `packages/gateway/src/routes/apps-store-routes.ts`: `GET /_apps` concatenates `opts.bundledApps()` with the store rows filtered by the bundled id set, bundled winning. The shared row shape is the new exported `AppMetaRow`; the bundled half is built in `build-gateway.ts` from `readBundledAppMeta(bundledAppDir(name))` (a new helper reading `app.json` + `index.html` presence, mirroring `listAppsWithMeta`'s shape and degrading to id-only on a malformed manifest) with `label ?? meta.name ?? id`.

#### **Install endpoint.** New `POST /centraid/_apps/_install {templateId}` (or repurpose `_clone` behind the same route): keep the blueprint's own id (no `suggestCloneIdentityFrom` identity minting), no `readTemplateFiles`/`cloneTemplateFiles`/`stageAndMaybePublish` (`lifecycle-routes.ts:201-281`). Idempotent: installing an installed app is a no-op returning the existing registration.

`handleInstall` in `packages/gateway/src/routes/lifecycle-routes.ts` is a distinct route, not a repurposed `_clone`: it reads `{ templateId }`, 400s on a missing id or an absent vault plane, 404s (`AppScaffoldError('not_found')`) on an unknown bundled id, and otherwise returns **200** — not 201 — with `{ app, installed: true, alreadyInstalled }`. 200 is the idempotence signal: a re-install returns the existing registration rather than erroring, matching app-store reinstall semantics. The implementation (`installBundledApp` in `build-gateway.ts`) reads the manifest meta, records `alreadyInstalled` *before* writing, calls `plane.installApp(templateId, meta.name)` + `registry.ensureUploaded` + `grantDeclaredBundledScopes` + `invalidateToolCatalog()`, and touches no git and no identity minting. `LifecycleRouteOptions` grew `isBundledAppId`, `installBundledApp` and `renameBundledApp` (both optional — hosts with no vault plane omit them) plus the `InstalledBundledApp` return type in `packages/gateway/src/lifecycle/lifecycle-shared.ts`. Id reservation is enforced at both scaffold seams: `handleCreate` and `handleClone` throw `already_exists` (409) on a bundled id, so a code-store app can never shadow a shipped blueprint — the identity-collision risk the issue named. Client side, `packages/client/src/gateway-client-editing.ts` calls the endpoint and `packages/client/src/react/shell/routes/templatesData.ts` `installAppTemplate` shapes the Home pin from the response, keeping the blueprint's own id.

#### **Uninstall endpoint.** Rename/alias `DELETE /centraid/_apps/<id>` semantics for bundled apps: `deregisterAndCleanup` + `vaultRegistry.revokeApp` (grants cascade, tombstones cleared — `vault-plane.ts:597-649`), but **no** `store.deleteApp` git commit (there is nothing in git). Ext-band data, model rows, receipts retained (current behavior).

No gateway code change was needed, and that is the finding rather than an omission. The existing `DELETE /centraid/_apps/<id>` already runs `deregisterAndCleanup` + `revokeApp` and already tolerates a store delete that reports `no_changes` — which is exactly what a bundled app produces, because nothing of it is in git. The revoke path clears scope tombstones, so reinstall is fresh-consent by construction. Retention of ext-band data, model rows and receipts is likewise the pre-existing behaviour; #434's work on it was to *say so* (see the copy pass) rather than to change it. The uninstall was exercised end-to-end anyway (see Verification) precisely because "no change needed" is a claim worth testing rather than asserting.

#### **Automations unchanged.** `POST /_automations/compile` → headless builder session → code store publish stays exactly as is (`lifecycle-automation-routes.ts`, `headless-automation-compile.ts`). Webhook secret provisioning (`provisionPendingWebhooksInFiles`) stays on the automation path.

`lifecycle-automation-routes.ts` and `headless-automation-compile.ts` are absent from the diff — the automation compile path is untouched, byte for byte. The guarantee is structural, not incidental: `listBundledAppTemplates()` filters automation-kind templates out of the reserved id set, so `handleClone`'s reservation guard never fires for an automation template and automations keep cloning into the code store. `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts` pins both halves — a bundled app id (`tasks`) now 409s on `_clone` and installs via `_install`, while the automation tests in the same file are unchanged and still green.

#### **Discover** (`DiscoverRoute.tsx`, `DiscoverScreen.tsx`, `templatePreview.ts`, `templatesData.ts`): "Use this template" → **Install**; installed state → **Open**. `installAppTemplate` calls the new install endpoint; keep pin-to-Home + navigate.

`packages/gateway/src/routes/templates-routes.ts` gained an `installedAppIds?: () => Set<string>` option, resolved once per request; each catalog row carries `installed` when it is wired. `build-gateway.ts` passes it off the ambient vault scope, wrapped in a try/catch that degrades to an empty set — the catalog is readable before any vault is addressed, and a throw there would blank the gallery. `packages/client/src/react/screens/DiscoverScreen.tsx` (+ `.module.css`) renders **Install** / **Open** plus an "Installed" marker; `DiscoverRoute.tsx` routes the CTA through `installAppTemplate`, which keeps pin-to-Home + navigate. `installed` and the `vault` block are typed through `packages/client/src/app-shell-context.ts` (`TemplateEntry`, new `TemplateVaultBlock`) and `packages/client/src/gateway-client.ts` (`TemplateMetaEntry`, new `TemplateVaultDTO` / `TemplateVaultScope`).

#### **App detail / consent sheet**: render `vault.scopes` + `why` from the catalog entry (`GET /centraid/_templates` already carries the manifest) before confirming install.

The issue's parenthetical was optimistic — `GET /_templates` carried identity and blurb but **not** the `vault` block, so the sheet had nothing to render. `templates-routes.ts` adds `readTemplateVault(t, cacheDir)`, which reads `app.json` from the template's source dir and returns the consent slice (`purpose?`, `why?`, `scopes[]`), skipping automations (they declare access on their own manifest) and degrading to `undefined` on anything malformed — app-authored input never breaks the gallery. Reads run in parallel across the catalog. `packages/client/src/react/shell/templatePreview.ts` turns from a preview into the install/consent sheet: the new exported `describeScopes()` groups scopes by verb (splitting compound `read+act` values), maps `read` → "Read" and `act` → "Add & change" with a fallback so an unknown verb never renders blank, orders read-before-act, de-duplicates nouns, relaxes `content_item` → "content item", and `joinNouns` caps at 7 with "+N more". A scope-less app renders "This app requests no access to your vault." rather than an empty box. `templatePreview.module.css` carries the new access rows; `templatePreview.test.ts` covers the grouping, the compound split, the cap and the empty case.

#### **Context menu** (`HomeRoute.tsx:66-99` `appContextMenu`, also emitted from `Sidebar.tsx:186,200`): Open / Star / Rename / App info / **Uninstall**; drop Edit-with-Centraid, Reveal-in-Finder, Share, Delete-draft. `deleteAppFlow` → `uninstallAppFlow` with the data-stays copy.

`packages/client/src/react/shell/routes/HomeRoute.tsx` branches the menu three ways. A bundled install gets exactly Open / App info / Rename / Star / Uninstall — Share (a stub) and Reveal in Finder are gone. A non-draft code-store app (a legacy clone) keeps Delete, because deleting it really does remove code. Drafts keep "Delete draft" but only render at all when the builder flag is on. "Bundled" is decided by testing the app id against the catalog's app-template ids (`loadAppTemplates()`), which is sound precisely because a bundled install keeps its blueprint id and those ids are reserved; the lookup is best-effort and degrades every app to the code-store menu. The uninstall confirm reads `Removes "<name>" and revokes its access. Your data stays in your vault.` `Sidebar.tsx` emits the same anchor and is updated alongside; `HomeRoute.test.tsx` is new and pins the menu composition and the confirm copy verbatim.

#### **App info surface**: live grants for the app id, linking to the existing consent screens.

New `packages/client/src/react/shell/routes/AppInfoModal.tsx` + `AppInfoModal.module.css`. It does not reimplement a consent view: it mounts the existing `VaultScreen` via `buildVaultProps` scoped to the app id, so requested access, live grants and Revoke are the same components (and the same revoke semantics) the consent screens already use — one implementation, two entry points.

#### **Rename** becomes registry metadata (per-vault label), not an app.json rewrite.

`consent_app.label` is the store; `setAppLabel` trims and coalesces blank to `NULL`, so "clear" and "rename to whitespace" both fall back to the manifest name. `handleMeta` in `lifecycle-routes.ts` tries `renameBundledApp(appId, name)` first and returns `{ ok: true, staged: false }` when it handles the id, falling through to the code-store `app.json` rewrite otherwise — one route, both origins. The client gained a session-free `renameInstalledApp()` (`gateway-client-editing.ts`), which also fixes a standing wart: renaming used to open a git session worktree to rewrite a file, for a change that was never about code.

#### Dev flag (settings-gated) hiding: `enterBuilder` entry points and "New app" (`App.tsx:86-92, 530`), `builder`/`automation-builder` route cases (`App.tsx:594-623`, `router.ts:55-60`), Home drafts section + "Continue editing", Automations editor "Open builder" buttons (`AutomationEditorRoute.tsx:244-254`, `AutomationViewRoute.tsx:163`).

`builderEnabled?: boolean` joins `CentraidSettings` (`packages/client/src/centraid-api.d.ts`), default absent → disabled, no settings-screen toggle (hand-edit the JSON and relaunch — it is a dev flag, and shipping a toggle would advertise a surface the release does not offer). `packages/client/src/react/shell/useBuilderEnabled.ts` reads it once on mount, optional-chaining `getSettings` so a partial bridge reads false. It is threaded through `ShellActions.builderEnabled` (`actions.tsx`) so menus and the palette read it without prop-drilling. Gated in `App.tsx`: drafts are replaced by a frozen `NO_DRAFTS` before they reach the sidebar or Home, `onNewApp` is omitted entirely rather than rendered-disabled, and the `builder` / `automation-builder` route cases return the new `BuilderRouteRedirect` (which navigates Home) instead of the builder. Also gated: the Home composer hero and "Browse apps" pathing (`HomeScreen.tsx`), the ⌘K create row (`paletteData.ts`, `PaletteScreen.tsx`), "Edit with Centraid" / "Continue editing" / "Delete draft" (`HomeRoute.tsx`), and the Use/Build titlebar switch (`AppViewRoute.tsx`). The two `onOpenBuilder` call sites this item names (`AutomationEditorRoute.tsx:244`, `AutomationViewRoute.tsx:163`) needed no change, and the issue's wording overstated what was there: the prop is passed by the route but **no screen renders a control for it** — `onOpenBuilder` has exactly two references in the codebase (its declaration in `screen-contracts.ts:505` and the route's handler), and the automations editor screens were already documented "hidden in v0". There is no button to hide. `BuilderRouteRedirect` is the backstop if one is ever wired up.

#### Gateway editing endpoints (`/_apps/<id>/files`, publish, rollback — `apps-store-routes.ts`) stay for dev mode; unreachable from the release UI.

`apps-store-routes.ts` keeps every editing route; the only change to it is the listing union plus a file split (below). Nothing is deleted, and with the flag on the whole builder works exactly as before — the gate is UI reachability only.

#### Headless automation compile is NOT behind the flag.

`POST /_automations/compile` is ungated, and deliberately so: the builder *is* the automations compiler, so gating the compile would break automations rather than hide a UI. `lifecycle-automation-routes.ts` and `headless-automation-compile.ts` are untouched.

#### Catalog = bundled blueprints only for v1; defer `fetchRemoteTemplates` (`templates-routes.ts:63-69`) — remote install is the one case where install legitimately copies (a download), designed later.

`build-gateway.ts` no longer passes `remoteTemplatesUrl` into `makeTemplatesRouteHandler`, so the v1 catalog is the shipped package and nothing else. The mechanism is *kept*, not deleted: `fetchRemoteTemplates` and the `remoteTemplatesUrl` option remain wired inside the route handler, ready for the remote/third-party catalog when it is designed. Deferring by not passing the option — rather than by ripping out the code — is what makes the deferral cheap to reverse.

#### Copy pass on all install/uninstall/consent strings.

Discover's h1 goes "Templates" → "Apps" with a new blurb (`DiscoverScreen.tsx`); `HomeScreen.tsx` "Browse templates" → "Browse apps"; `PaletteScreen.tsx` placeholder corrected. `AppViewRoute.tsx`'s gear popover reads Uninstall for bundled apps with the same `Removes "<name>" and revokes its access. Your data stays in your vault.` confirm. `AppSettingsPanel.tsx` takes a new `bundled?: boolean` prop (wired via `screen-contracts.ts` and `AppSettingsController.tsx`) and renders "Uninstall app" + "Revokes its access. Your data stays in your vault." instead of "Delete app". The install sheet closes with "Installing grants the access above. Nothing is copied — the app runs from the shipped release and updates with it. Uninstall anytime; your data stays in your vault." Automations deliberately keep "Use this template" and clone wording — for them, cloning is still what happens.

#### Existing vaults: per pre-release policy, no migration — fresh vaults work the new way; old snapshot-installed apps keep serving from the store until the vault is recreated.

There is no migration and no backfill. `consent_app.label` is added to the DDL only (v0 policy: no migrations). The resolver's per-vault `installedAppIds()` test is what makes this safe rather than merely declared: a legacy vault has no `origin='installed'` row for `photos`, so `codeDirOverride` takes the store arm and the snapshot keeps serving; the same binary serves a fresh vault from the shipped dir. Home's menu inherits the same split — a legacy clone keeps Delete because it genuinely has code to delete.

#### Also in the diff — two file splits under the 500-line hygiene cap

Neither is a #434 feature; both are the cap forcing a seam, and each was split where the code already had one. `packages/client/src/gateway-client-automation-editing.ts` (new) takes the automation CRUD block out of `gateway-client-editing.ts`, which reached 542 lines once `installAppTemplate` + `renameInstalledApp` landed; the barrel `gateway-client.ts` re-exports it, so no call site changes. `packages/gateway/src/routes/apps-store-draft-files.ts` (new) takes `readDraftFiles` / `writeDraftFile` + `EDITABLE_EXT` + `MAX_DRAFT_FILE_BYTES` out of `apps-store-routes.ts`, which the listing union pushed over; the routes file imports them back. Both are pure moves — the extracted bodies are byte-identical to what was deleted.

### Changed paths

Modified:

- `packages/blueprints/src/index.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-client-editing.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AppSettingsPanel.tsx`
- `packages/client/src/react/screens/DiscoverScreen.module.css`
- `packages/client/src/react/screens/DiscoverScreen.test.tsx`
- `packages/client/src/react/screens/DiscoverScreen.tsx`
- `packages/client/src/react/screens/HomeScreen.test.tsx`
- `packages/client/src/react/screens/HomeScreen.tsx`
- `packages/client/src/react/screens/PaletteScreen.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/Sidebar.test.tsx`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/actions.tsx`
- `packages/client/src/react/shell/routes/AppSettingsController.tsx`
- `packages/client/src/react/shell/routes/AppViewRoute.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`
- `packages/client/src/react/shell/routes/DiscoverRoute.test.tsx`
- `packages/client/src/react/shell/routes/DiscoverRoute.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.tsx`
- `packages/client/src/react/shell/routes/paletteData.test.ts`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/client/src/react/shell/routes/templatesData.test.ts`
- `packages/client/src/react/shell/routes/templatesData.ts`
- `packages/client/src/react/shell/templatePreview.module.css`
- `packages/client/src/react/shell/templatePreview.test.ts`
- `packages/client/src/react/shell/templatePreview.ts`
- `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.ts`
- `packages/gateway/src/routes/apps-store-routes.ts`
- `packages/gateway/src/routes/lifecycle-routes.ts`
- `packages/gateway/src/routes/templates-routes.test.ts`
- `packages/gateway/src/routes/templates-routes.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/consent.ts`

Added:

- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/react/shell/routes/AppInfoModal.module.css`
- `packages/client/src/react/shell/routes/AppInfoModal.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.test.tsx`
- `packages/client/src/react/shell/useBuilderEnabled.ts`
- `packages/gateway/src/lifecycle/install-over-http.test.ts`
- `packages/gateway/src/routes/apps-store-draft-files.ts`
- `receipts/issue-434-apps-not-templates.md`

## Out of scope

- **Remote/third-party catalog and downloaded installs.** Deferred, and the one case where install legitimately *does* copy — a download is code the gateway cannot otherwise get, which is precisely the code-store's new remit. `fetchRemoteTemplates` and the `remoteTemplatesUrl` option stay wired inside `makeTemplatesRouteHandler`; only the call site stops passing them.
- **"Customize this app" (the builder fork).** Copy-on-*edit*, not copy-on-install. The existing clone machinery is untouched and becomes the fork machinery when the builder returns; that is why `handleClone` is guarded rather than deleted.
- **Per-app data purge on uninstall.** Uninstall revokes access and retains data. Deleting a vault's data is a separate, explicit owner act — bundling it into uninstall would make an irreversible act a side effect of a reversible one.
- **Migration of existing snapshot-installed vaults.** Per v0 policy, none. Old vaults keep serving from their store; fresh vaults work the new way. Both paths are live in the same binary, decided per vault by the resolver.
- **The automations editor's own `onOpenBuilder` plumbing** (`AutomationEditorRoute.tsx:244`, `AutomationViewRoute.tsx:163`). Left as-is under hide-not-delete: the handlers are inert today (no screen renders a control for them) and `BuilderRouteRedirect` closes the route regardless, so gating them would add a flag to props nothing reads.
- **`display_name`'s self-heal was left alone.** It overwrites on every re-enrollment; that is correct for a manifest-derived pretty name and is why `label` exists beside it rather than replacing it.
- Pre-existing local artifacts and #435's committed replica/photos work are untouched and excluded from this receipt.

## Decisions

- **Install is a consent record, not a parallel installed-apps store.** `consent_app` already models "this app is enrolled here and may touch these tables" — the exact relationship an install *is*. A second table would have made the two disagree. `origin = 'installed'` is written only by the new path, so it is an unambiguous signal rather than a heuristic over pre-existing rows.
- **`label` is a new column, not a reuse of `display_name`.** `display_name` self-heals to the manifest name on every re-enrollment, so an override stored there would silently evaporate on the next boot. Two fields because there are two facts: what the app calls itself, and what the owner calls it here.
- **A resolver rule, not two app kinds.** Bundled-first with a code-store fallback keeps one mental model — *generated or downloaded code lives in the store; shipped code serves in place* — and keeps the origins invisible to the app-engine sandbox. Two kinds would have forked every listing, lifecycle and security path on a distinction the owner should never see.
- **The builder is hidden behind a flag, not deleted.** It is the automations compiler; deleting it breaks automations. A flag also keeps the machinery reachable and testable, so hiding it does not rot it.
- **`readTemplateFiles` needed no materialized cache.** The premise that bundled templates might be virtual was checked and is false — it reads real on-disk dirs under the installed package, so `bundledAppDir` can be served directly. No cache was built.
- **Uninstall needed no gateway change, and that was verified rather than assumed.** The existing DELETE already tolerates a `no_changes` store delete and already runs deregister + `revokeApp`. The work was making the copy honest about behaviour that was already correct — and driving it end-to-end to prove the claim.
- **Install returns 200, not 201.** Idempotence is the product requirement (installing an installed app is a no-op returning the existing registration), and 201 would assert a creation that did not happen. `alreadyInstalled` carries the distinction for callers that care.
- **`installedAppIds` degrades to an empty set rather than throwing.** The catalog must be readable before any vault is addressed; a throw inside the route would blank the gallery for a question ("is this installed?") that simply has no answer yet.
- **The files were split rather than waivered.** `gateway-client-editing.ts` hit 542 lines and `apps-store-routes.ts` followed; both had an obvious seam (automation CRUD; draft file I/O). Taking a file-size waiver would have spent the cap's credibility on files that wanted splitting anyway.
- **Automations keep "Use this template".** The vocabulary change tracks a behaviour change. Automations really are cloned into the store, so calling that "Install" would be the lie the rest of this issue removes.

## Verification

```sh
# Gates
bun run build          # 14/14
bun run typecheck      # 28/28
bun run lint:types     # 9/9
bun run lint           # 0 errors
bun run lint:css       # clean
bun run format:check   # pass

# Focused suites for this change
bunx vitest run packages/gateway/src/lifecycle/install-over-http.test.ts \
                packages/gateway/src/lifecycle/lifecycle-over-http.test.ts \
                packages/gateway/src/routes/templates-routes.test.ts
cd packages/client && bunx vitest run src/react/shell/routes/HomeRoute.test.tsx \
                                      src/react/shell/routes/templatesData.test.ts \
                                      src/react/shell/templatePreview.test.ts \
                                      src/react/shell/App.test.tsx

# Full test load
bun run test           # client 926, vault 758 (+1 skipped), gateway 696 (+2 skipped), blueprints 222

bash .governance/run.sh
```

Suites: client 926, vault 758 (+1 skipped), gateway 696 (+2 skipped), blueprints 222. **Reported honestly:** under the combined `turbo run test` load, 7 `@centraid/blueprints` `app-boot` / `docs-media` suites time out at the 5000ms limit. All 7 pass in isolation. This is a pre-existing under-load flake — those suites boot real app runtimes and contend for CPU with three other packages' suites — not #434 fallout; nothing in this change touches them.

The architectural claim is test-enforced rather than asserted. `install-over-http.test.ts` (new) drives the endpoint over real HTTP: install keeps the blueprint's own id, is idempotent (a second install returns 200 with `alreadyInstalled`), 404s an unknown id, writes nothing to git, and lists through `GET /_apps`. `lifecycle-over-http.test.ts` pins the reservation from the other side — `_clone` of a bundled id now 409s, and the scaffold tests moved off `notes`/`tasks` onto non-bundled ids (`jotter`/`planner`) precisely *because* the reservation is real. `templates-routes.test.ts` asserts app-kind rows carry a well-formed `vault` block and automations never do.

Manual E2E in the real desktop app, fresh profile — the reproducible recipe:

1. Onboard a new vault → Discover reads **"Apps"**.
2. Click **Notes** → the consent sheet lists the access it will get, grouped by verb.
3. **Install** → instant, no draft stage; the app pins to Home and opens.
4. Write a note → it receipts, so the grants are live and the app is serving from the shipped package.
5. Home context menu on the tile → exactly **Open / App info / Rename / Star / Uninstall**.
6. **App info** → requested access + live grants + working Revoke.
7. **Uninstall** → the confirm reads `Removes "Notes" and revokes its access. Your data stays in your vault.` → the app leaves Home.
8. Reinstall from Discover → **the note is still there.**

Step 8 is the load-bearing one: it proves data retention across uninstall/reinstall *and* that serving comes from the shipped package with no per-vault code copy — a snapshot-clone model cannot produce that result, since the reinstall would have minted a fresh copy.

## Audit

PASS

- **"What changed" faithfulness**: The section accurately describes the diff. The checklist claims are substantiated in the code: `bundledAppDir()` / `listBundledAppTemplates()` export from blueprints package; `codeDirOverride` two-arm resolver in build-gateway.ts with `isBundledAppId` closure; `consent_app` with `origin='installed'` and new `label` column in schema; `handleInstall` POST endpoint idempotent with 200 return and `alreadyInstalled` flag; vault-plane wraps install/label functions; `useBuilderEnabled` hook gates builder routes; file splits legitimate (gateway-client split 377+183 lines, apps-store split with 82-line draft-files module).

- **Checklist realization**: All 12 '- [x]' items are realized. The bundled app resolver, install registry, install/uninstall endpoints, unchanged automation path, UI vocabulary changes (Install/Open/Uninstall), consent sheet with scopes, context menu rebuild, app info modal, rename via label override, dev flag hiding (BuilderRouteRedirect backstop), deferred remote catalog, and copy pass are all present in the diff.

- **Checklist vs. issue match**: The receipt's checklist matches issue #434's "Implementation plan" four phases exactly.

- **One minor evidence citation issue**: Phase 3 notes cite AutomationViewRoute.tsx:163 as a line needing `onOpenBuilder` hiding, but that line contains route navigation to 'automation-builder' (via seedMessage parameter), not an `onOpenBuilder` call. The substance of the Phase 3 claim ("no screen renders a control for it") is correct—onOpenBuilder appears only in its declaration and one handler (AutomationEditorRoute.tsx:244)—but the cited line reference is inaccurate. This is an error in the receipt's evidence details, not a functional misstatement.

## Steering

PASS

- **Steering event identified**: One correction event recorded—the user's message at 2026-07-17T06:47:05.362Z redirecting the session from Photos replica debugging (#435 work) to the app install/uninstall brainstorm and redesign (#434). The message ("let's take a step back...hide builder...install/uninstall instead of cloning...") is a mid-task redirect, not a tool denial or ordinary approval.

- **Non-steering events correctly excluded**: The second user message ("your recommendations are good...") was correctly identified as NOT steering—it was approval to proceed with the brainstormed plan, not a redirect or correction of the agent's work.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-d9a902af-877-1784278821-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 32 | 23596 | 4172479 | 12878 | 36506 | 2.5558 | 1094 | 1993419 | 85658336 | 370805 | feat(gateway): install bundled apps in place instead of cloning them (#434)Centr |
| claude-code-d9a902af-877-1784279162-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 6 | 10128 | 802776 | 4350 | 14484 | 0.5735 | 1100 | 2003547 | 86461112 | 375155 | feat(gateway): install bundled apps in place instead of cloning them (#434)Centr |
| claude-code-d9a902af-877-1784279240-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 10 | 3748 | 1365233 | 1878 | 5636 | 0.7530 | 1110 | 2007295 | 87826345 | 377033 | feat(gateway): install bundled apps in place instead of cloning them (#434)Centr |
| claude-code-d9a902af-877-1784279293-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 4 | 7712 | 549352 | 1204 | 8920 | 0.3530 | 1114 | 2015007 | 88375697 | 378237 | feat(shell): hide the builder behind a dev flag for the first release (#434)The  |
| claude-code-d9a902af-877-1784279343-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 2 | 831 | 278532 | 816 | 1649 | 0.1649 | 1116 | 2015838 | 88654229 | 379053 | feat(shell): install and uninstall apps, with consent as the install moment (#43 |
| claude-code-d9a902af-877-1784279392-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 2 | 1119 | 279363 | 372 | 1493 | 0.1560 | 1118 | 2016957 | 88933592 | 379425 | feat(shell): say apps, not templates, and serve only the shipped catalog (#434)T |
| claude-code-d9a902af-877-1784279659-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | claude-opus-4-8 | 18 | 3743 | 2535325 | 1828 | 5589 | 1.3368 | 1136 | 2020700 | 91468917 | 381253 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-d9a902af-1784277625-2 | d9a902af-877b-4579-9d81-b893be0e42fa | #434 | correction | classifier | Pivot from Photos replica debugging to app install/uninstall redesign; hide builder in v1; serve bundled apps in place instead of cloning | pending | 2 | 2026-07-17T06:47:05.362Z |
