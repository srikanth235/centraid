import { useRef } from "react";
import type { JSX } from "react";

import {
  auth,
  compileAutomation,
  configureConnection,
  createAutomation,
  deleteAutomation,
  getBlocking,
  invokeAutomationAndAwait,
  listAgents,
  listTemplates,
  listOutboxGrants,
  readAutomationSource,
  rotateAutomationWebhookSecret,
  setAutomationEnabled,
  getUserPrefs,
  listVaultEntityTypes,
  searchVaultAnchors,
  searchVaultEntities,
  updateAutomation,
} from "../../../gateway-client.js";
import type {
  AuEditorCatalogConnectorDTO,
  AutomationEditorData,
} from "../../screen-contracts.js";
import AutomationEditorScreen from "../../screens/AutomationEditorScreen.js";
import { buildFeatured } from "../../screens/SettingsConnectionsScreen.js";
import type { ConnectionRowDTO } from "../../screens/SettingsConnectionsScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { useShellCapabilities } from "../useCapabilities.js";
import { openWebhookReveal } from "../webhookReveal.js";
import {
  loadCompileAttempts,
  loadTurnSteps,
  watchTurnSteps,
} from "./automationCompileData.js";
import { buildCreateAutomationEditorData } from "./automationEditorCreateData.js";
import { loadAutomationEditorData } from "./automationEditorData.js";
import { buildAutomationHarnessEditorData } from "./automationEditorHarnessData.js";
import { triggerToDto, vaultForTriggers } from "./automationEditorTriggers.js";
import { deriveAutomationHero } from "./automationsData.js";
import {
  decideConsentItem,
  filterConsentForAutomation,
} from "./automationThreadData.js";
import {
  beginConnectionAuthorize,
  loadConnectionProvidersData,
  loadConnectionsData,
} from "./settingsConnectionsData.js";
import { loadHarnesses } from "./settingsHarnessesData.js";

export { vaultForTriggers } from "./automationEditorTriggers.js";

// React-owned automation editor — the instructions-first create/edit form
// (Automations UI revamp, see receipts/issue-387-automations-ui-revamp.md). This is a real
// wrapper, not a stub: it wires `AutomationEditorScreen`'s full bridge-prop
// surface against `loadAutomationEditorData` + the existing
// create/update/enable/run/delete/webhook client fns, reusing
// `deriveAutomationHero`/`filterConsentForAutomation` so the webhook URL and
// standing-consent list are derived exactly once, the same way the thread
// does. Lane B (editor) owns this file going forward — the screen it renders
// is still the AutomationEditorScreen placeholder until Lane B lands the
// real form.
// Canonical entity-type list is small and static per gateway — fetch once and
// reuse across every @-search keystroke.
let entityTypeCache: string[] | null = null;

export function matchEditorConnection(
  connections: readonly ConnectionRowDTO[],
  providerId: string,
  kind: string
): { match: ConnectionRowDTO | null; matches: ConnectionRowDTO[] } {
  const candidates = connections.filter(
    (connection) =>
      connection.kind === kind && connection.provider === providerId
  );
  return {
    match: candidates.length === 1 ? candidates[0]! : null,
    matches: candidates,
  };
}

async function loadEditorConnectorCatalog(): Promise<
  AuEditorCatalogConnectorDTO[]
> {
  const [providers, connections] = await Promise.all([
    loadConnectionProvidersData(),
    loadConnectionsData(),
  ]);
  const featured = buildFeatured(providers);
  return featured.map((f) => {
    // Provider is part of connection identity. Kind-only matching can lend
    // trusted catalog branding to a free-form credential; choosing the first
    // of multiple same-kind accounts silently binds the wrong principal.
    const { match, matches } = matchEditorConnection(
      connections,
      f.providerId,
      f.kind
    );
    return {
      allowedHosts: f.provider.allowedHosts,
      authUrl: f.provider.authUrl,
      connection: match
        ? {
            connectionId: match.connectionId,
            health: match.health,
            label: match.label,
            principal: match.principal,
          }
        : null,
      connections: matches.map((connection) => ({
        connectionId: connection.connectionId,
        health: connection.health,
        label: connection.label,
        principal: connection.principal,
      })),
      credKind: f.provider.credKind,
      key: f.key,
      kind: f.kind,
      name: f.meta.name,
      providerId: f.providerId,
      providerName: f.provider.name,
      scope: f.scope,
      scopes: f.provider.scopes,
      setup: [...f.provider.setup],
      templateId: f.templateId,
      tokenUrl: f.provider.tokenUrl,
      tone: f.meta.tone,
    };
  });
}

export default function AutomationEditorRoute({
  automationId,
  templateId,
  watchEntity,
}: {
  automationId?: string;
  templateId?: string;
  watchEntity?: string;
}): JSX.Element {
  const { navigate, showToast, confirm } = useShellActions();
  // The editor lives behind the automations gate, but connectors is its OWN
  // gate: a gateway may run automations with no connector plane at all, and
  // the editor degrades to "no provider accounts" rather than erroring.
  const { connectors } = useShellCapabilities();
  // `refIdRef` is the automation's `ref` once it exists on the gateway —
  // `undefined` at mount for a brand-new create flow, set by `loadData` (edit
  // mode) or by `onSave`'s create-mode branch (first save mints the row).
  const refIdRef = useRef<string | null>(automationId ?? null);
  const rowRef = useRef<CentraidAutomationRow | null>(null);

  return (
    <PageScroll>
      <AutomationEditorScreen
        loadData={async (): Promise<AutomationEditorData> => {
          // `refIdRef` first: after a create-mode save the automation exists
          // but the route prop is still undefined, and reloading against the
          // prop alone would bounce the form back to create mode instead of
          // handing the owner a live compile rail.
          const loaded = await loadAutomationEditorData({
            automationId: refIdRef.current ?? automationId,
          });
          rowRef.current = loaded.row;
          refIdRef.current = loaded.row?.ref ?? automationId ?? null;
          if (!loaded.row) {
            const [templates, harnessStatus, prefs] = await Promise.all([
              templateId ? listTemplates() : Promise.resolve([]),
              loadHarnesses(),
              getUserPrefs().catch(() => ({}) as Record<string, unknown>),
            ]);
            const template = templates.find((entry) => entry.id === templateId);
            const defaultCronTimeZone =
              typeof prefs["automation.cron.defaultTimezone"] === "string"
                ? prefs["automation.cron.defaultTimezone"]
                : null;
            return {
              ...buildCreateAutomationEditorData({
                harness: buildAutomationHarnessEditorData(harnessStatus),
                ...(template ? { template } : {}),
                ...(watchEntity ? { watchEntity } : {}),
                instructions: loaded.instructions,
                name: loaded.name,
              }),
              defaultCronTimeZone,
            };
          }
          const [{ baseUrl }, blocking, grants, agents, harnessStatus, prefs] =
            await Promise.all([
              auth(),
              getBlocking(),
              listOutboxGrants(),
              listAgents(),
              loadHarnesses(),
              getUserPrefs().catch(() => ({}) as Record<string, unknown>),
            ]);
          const hero = deriveAutomationHero(loaded.row, baseUrl);
          const defaultCronTimeZone =
            typeof prefs["automation.cron.defaultTimezone"] === "string"
              ? prefs["automation.cron.defaultTimezone"]
              : null;
          return {
            automationId: loaded.row.ref,
            connectors: loaded.connectors,
            consent: filterConsentForAutomation(
              agents.find(
                (agent) => agent.enrollmentKey === loaded.row?.ownerApp
              )?.agentId,
              blocking,
              grants
            ),
            defaultCronTimeZone,
            enabled: loaded.row.enabled,
            instructions: loaded.instructions,
            mode: "edit",
            model: loaded.model,
            name: loaded.name,
            onFailure: loaded.onFailure,
            rowId: loaded.rowId,
            harness: loaded.harness,
            triggers: loaded.triggers.map(triggerToDto),
            webhook: hero.webhook,
            ...buildAutomationHarnessEditorData(harnessStatus),
          };
        }}
        onSave={async (fields) => {
          try {
            const connections =
              fields.connections && fields.connections.length > 0
                ? fields.connections
                : undefined;
            if (refIdRef.current) {
              const { row, webhook } = await updateAutomation({
                automationId: refIdRef.current,
                name: fields.name,
                prompt: fields.instructions,
                triggers: fields.triggers,
                ...(vaultForTriggers(fields.triggers)
                  ? { vault: vaultForTriggers(fields.triggers) }
                  : {}),
                ...(connections === undefined
                  ? { connections: [] }
                  : { connections }),
                ...(fields.harness === undefined
                  ? {}
                  : { harness: fields.harness }),
                ...(fields.model === undefined ? {} : { model: fields.model }),
              });
              if (row) rowRef.current = row;
              // A `{kind:'webhook'}` trigger that didn't exist before mints a
              // fresh secret server-side, returned once — same one-time
              // reveal `onRotateWebhook` uses below (webhookReveal.ts).
              if (webhook) {
                await openWebhookReveal(webhook, {
                  note: "Shown once — copy it now.",
                  title: "Webhook minted",
                });
              }
              showToast(`Saved · ${fields.name}`);
              return true;
            }
            const id = `automation-${Math.random().toString(36).slice(2, 8)}`;
            const { row, webhook } = await createAutomation({
              enabled: false,
              id,
              name: fields.name,
              prompt: fields.instructions,
              triggers: fields.triggers,
              ...(vaultForTriggers(fields.triggers)
                ? { vault: vaultForTriggers(fields.triggers) }
                : {}),
              ...(connections ? { connections } : {}),
              ...(fields.harness ? { harness: fields.harness } : {}),
              ...(fields.model ? { model: fields.model } : {}),
            });
            if (row) {
              rowRef.current = row;
              refIdRef.current = row.ref;
            }
            if (webhook) {
              await openWebhookReveal(webhook, {
                note: "Shown once — copy it now.",
                title: "Webhook minted",
              });
            }
            showToast(`Created · ${fields.name}`);
            return true;
          } catch (error) {
            showToast(
              `Could not save: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onCompile={async (enableOnSuccess) => {
          const ref = refIdRef.current;
          if (!ref) return null;
          try {
            // Returns the turn id and STAYS. The old version navigated to the
            // run screen, which is why a compile failure was only ever visible
            // as a red card in a list of runs it did not belong in.
            const { compileTurnId } = await compileAutomation({
              automationId: ref,
              enableOnSuccess,
            });
            return compileTurnId;
          } catch (error) {
            showToast(
              `Could not compile: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
          }
        }}
        loadCompileAttempts={async () => {
          const ref = refIdRef.current;
          return ref ? loadCompileAttempts(ref).catch(() => []) : [];
        }}
        loadTurnSteps={loadTurnSteps}
        watchTurnSteps={watchTurnSteps}
        onSearchEntities={async (term) => {
          // Anchor-grade references come first: the opaque token resolves
          // through core_link_anchor and compiles to a row + field mask.
          // Legacy type/instance tags remain available for deliberately
          // broad queries and non-anchored rows.
          if (entityTypeCache === null) {
            entityTypeCache = await listVaultEntityTypes().catch(() => []);
          }
          const q = term.toLowerCase();
          const typeHits = entityTypeCache
            .filter((name) => name.toLowerCase().includes(q))
            .slice(0, 6)
            .map((name) => ({
              id: "*",
              subtitle: "Domain model",
              title: name,
              type: name,
            }));
          const [anchorHits, instanceHits] = await Promise.all([
            searchVaultAnchors(term).catch(() => []),
            searchVaultEntities(term).catch(() => []),
          ]);
          return [...anchorHits, ...typeHits, ...instanceHits];
        }}
        loadEntityTypes={async () => {
          // Same cached gateway read the @-mention type search uses — the
          // data/condition trigger editors' `<datalist>` autocomplete.
          if (entityTypeCache === null) {
            entityTypeCache = await listVaultEntityTypes().catch(() => []);
          }
          return entityTypeCache;
        }}
        connectorsEnabled={connectors}
        {...(connectors
          ? {
              // Withdrawn, not merely hidden (C1): with the connectors
              // experiment off the vault connections + OAuth callback routes
              // are unmounted, so handing the screen loaders that can only
              // 404 would leave the failure to be discovered by request
              // instead of stated once by the capability.
              beginAuthorize: beginConnectionAuthorize,
              configureConnection: async (input) => {
                const result = await configureConnection({
                  allowedHosts: input.allowedHosts,
                  apiKey: input.apiKey,
                  authUrl: input.authUrl,
                  clientId: input.clientId,
                  clientSecret: input.clientSecret,
                  credKind: input.credKind,
                  kind: input.connectorKind,
                  label: input.label,
                  provider: input.providerId,
                  scopes: input.scopes,
                  tokenUrl: input.tokenUrl,
                });
                return { connectionId: result.connectionId };
              },
              loadConnectorCatalog: loadEditorConnectorCatalog,
            }
          : {})}
        showToast={showToast}
        onReadSource={async () => {
          const ref = refIdRef.current;
          if (!ref) return { manifest: null, handler: null };
          return readAutomationSource(ref);
        }}
        onTestRun={async () => {
          const ref = refIdRef.current;
          if (!ref) return null;
          try {
            // A test run stays on the compile screen so its steps land in the
            // same rail as the compile that produced the plan. Navigating to
            // the run viewer is an explicit "Full trace" click, not a side
            // effect of pressing Test.
            const { turnId } = await invokeAutomationAndAwait({
              automationId: ref,
            });
            return turnId;
          } catch (error) {
            showToast(
              `Run failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
          }
        }}
        onToggleEnabled={async (next) => {
          const ref = refIdRef.current;
          if (!ref) return false;
          try {
            await setAutomationEnabled({ automationId: ref, enabled: next });
            return true;
          } catch (error) {
            showToast(
              `Could not ${next ? "enable" : "disable"}: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onDecideConsent={async (kind, id, decision, alwaysAllow) => {
          try {
            return await decideConsentItem({
              decision,
              id,
              kind,
              ...(alwaysAllow === undefined ? {} : { alwaysAllow }),
            });
          } catch (error) {
            showToast(
              `Could not update: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onOpenRun={(runId) => {
          const ref = refIdRef.current;
          if (ref) navigate({ automationId: ref, kind: "run-view", runId });
        }}
        onOpenRuns={() => {
          const ref = refIdRef.current;
          if (ref) navigate({ automationId: ref, kind: "automation-view" });
        }}
        onCopyWebhook={(url) =>
          void navigator.clipboard
            .writeText(url)
            .then(() => showToast("Webhook URL copied"))
            .catch(() => showToast("Could not copy to clipboard"))
        }
        onRotateWebhook={async () => {
          const ref = refIdRef.current;
          if (!ref) return false;
          const ok = await confirm({
            confirmLabel: "Regenerate",
            danger: true,
            message:
              "This invalidates the current secret — any caller using it starts failing until updated. The webhook URL stays the same.",
            title: "Regenerate webhook secret?",
          });
          if (!ok) return false;
          try {
            const { webhook } = await rotateAutomationWebhookSecret({
              automationId: ref,
            });
            await openWebhookReveal(webhook, {
              note: "Shown once — update your caller now.",
              title: "New webhook secret",
            });
            showToast("Webhook secret regenerated");
            return true;
          } catch (error) {
            showToast(
              `Could not regenerate secret: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onDelete={async () => {
          const ref = refIdRef.current;
          const row = rowRef.current;
          if (!ref || !row) return false;
          const ok = await confirm({
            confirmLabel: "Delete",
            danger: true,
            message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
            title: "Delete automation?",
          });
          if (!ok) return false;
          try {
            await deleteAutomation({ automationId: ref });
            showToast(`Deleted "${row.name}"`);
            navigate({ kind: "automations" });
            return true;
          } catch (error) {
            showToast(
              `Could not delete: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }
        }}
        onCancel={() =>
          navigate(
            refIdRef.current
              ? { automationId: refIdRef.current, kind: "automation-view" }
              : { kind: "automations" }
          )
        }
      />
    </PageScroll>
  );
}
