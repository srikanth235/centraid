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
  const { connectors } = useShellCapabilities();
  const refIdRef = useRef<string | null>(automationId ?? null);
  const rowRef = useRef<CentraidAutomationRow | null>(null);

  return (
    <PageScroll>
      <AutomationEditorScreen
        loadData={async (): Promise<AutomationEditorData> => {
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
          if (entityTypeCache === null) {
            entityTypeCache = await listVaultEntityTypes().catch(() => []);
          }
          return entityTypeCache;
        }}
        connectorsEnabled={connectors}
        {...(connectors
          ? {
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
