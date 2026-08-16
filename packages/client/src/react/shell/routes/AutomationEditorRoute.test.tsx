import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type {
  AutomationEditorBridgeProps,
  AutomationEditorData,
} from "../../screen-contracts.js";
import type * as TypeImport_ffl4ji from "../../screens/SettingsConnectionsScreen.js";
import type { ShellActions } from "../actions.js";
import type * as TypeImport_1f3slmz from "../webhookReveal.js";
import type * as TypeImport_1omb499 from "./automationEditorCreateData.js";
import type * as TypeImport_vtz3vd from "./automationEditorData.js";
import type * as TypeImport_fuav22 from "./automationEditorHarnessData.js";
import { automationRow } from "./automationEditorRoute.fixture.js";
import type * as TypeImport_17pturf from "./automationsData.js";
import type * as TypeImport_14phijm from "./automationThreadData.js";
import type * as TypeImport_buhgwd from "./settingsConnectionsData.js";
import type * as TypeImport_ym9bw8 from "./settingsHarnessesData.js";

const captured = vi.hoisted(() => ({
  props: null as AutomationEditorBridgeProps | null,
}));
const actions = vi.hoisted(() => ({
  confirm: vi.fn<ShellActions["confirm"]>(),
  navigate: vi.fn<ShellActions["navigate"]>(),
  showToast: vi.fn<ShellActions["showToast"]>(),
  // Unused by this suite, but required by the real `ShellActions` shape that
  // the typed `vi.mock(import(...))` factory below now checks against.
  openCommandPalette: vi.fn<ShellActions["openCommandPalette"]>(),
  openContextMenu: vi.fn<ShellActions["openContextMenu"]>(),
}));
const api = vi.hoisted(() => ({
  auth: vi.fn<typeof TypeImport_1gl5zx7.auth>(),
  compileAutomation: vi.fn<typeof TypeImport_1gl5zx7.compileAutomation>(),
  configureConnection: vi.fn<typeof TypeImport_1gl5zx7.configureConnection>(),
  createAutomation: vi.fn<typeof TypeImport_1gl5zx7.createAutomation>(),
  deleteAutomation: vi.fn<typeof TypeImport_1gl5zx7.deleteAutomation>(),
  getBlocking: vi.fn<typeof TypeImport_1gl5zx7.getBlocking>(),
  getUserPrefs: vi.fn<typeof TypeImport_1gl5zx7.getUserPrefs>(),
  invokeAutomationAndAwait:
    vi.fn<typeof TypeImport_1gl5zx7.invokeAutomationAndAwait>(),
  listAgents: vi.fn<typeof TypeImport_1gl5zx7.listAgents>(),
  listOutboxGrants: vi.fn<typeof TypeImport_1gl5zx7.listOutboxGrants>(),
  listTemplates: vi.fn<typeof TypeImport_1gl5zx7.listTemplates>(),
  listVaultEntityTypes: vi.fn<typeof TypeImport_1gl5zx7.listVaultEntityTypes>(),
  readAutomationSource: vi.fn<typeof TypeImport_1gl5zx7.readAutomationSource>(),
  rotateAutomationWebhookSecret:
    vi.fn<typeof TypeImport_1gl5zx7.rotateAutomationWebhookSecret>(),
  searchVaultAnchors: vi.fn<typeof TypeImport_1gl5zx7.searchVaultAnchors>(),
  searchVaultEntities: vi.fn<typeof TypeImport_1gl5zx7.searchVaultEntities>(),
  setAutomationEnabled: vi.fn<typeof TypeImport_1gl5zx7.setAutomationEnabled>(),
  updateAutomation: vi.fn<typeof TypeImport_1gl5zx7.updateAutomation>(),
}));
const helpers = vi.hoisted(() => ({
  beginAuthorize: vi.fn<typeof TypeImport_buhgwd.beginConnectionAuthorize>(),
  buildAgentData:
    vi.fn<typeof TypeImport_fuav22.buildAutomationHarnessEditorData>(),
  buildCreateData:
    vi.fn<typeof TypeImport_1omb499.buildCreateAutomationEditorData>(),
  buildFeatured: vi.fn<typeof TypeImport_ffl4ji.buildFeatured>(),
  decideConsent: vi.fn<typeof TypeImport_14phijm.decideConsentItem>(),
  deriveHero: vi.fn<typeof TypeImport_17pturf.deriveAutomationHero>(),
  filterConsent: vi.fn<typeof TypeImport_14phijm.filterConsentForAutomation>(),
  loadConnectionProviders:
    vi.fn<typeof TypeImport_buhgwd.loadConnectionProvidersData>(),
  loadConnections: vi.fn<typeof TypeImport_buhgwd.loadConnectionsData>(),
  loadEditor: vi.fn<typeof TypeImport_vtz3vd.loadAutomationEditorData>(),
  loadHarnesses: vi.fn<typeof TypeImport_ym9bw8.loadHarnesses>(),
  openWebhookReveal: vi.fn<typeof TypeImport_1f3slmz.openWebhookReveal>(),
}));

vi.mock(import("../../../gateway-client.js"), () => api);
vi.mock(import("../actions.js"), () => ({ useShellActions: () => actions }));
vi.mock(import("../PageScroll.js"), () => ({
  // Wrapped in a fragment (not returned bare) so this matches the real
  // `PageScroll`'s `JSX.Element` return type instead of `ReactNode`.
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock(import("../../screens/AutomationEditorScreen.js"), () => ({
  default: (props: AutomationEditorBridgeProps) => {
    captured.props = props;
    // An empty fragment renders nothing (same as `null` did), but matches the
    // real screen's `JSX.Element` return type.
    return <></>;
  },
}));
vi.mock(import("./automationEditorData.js"), () => ({
  loadAutomationEditorData: helpers.loadEditor,
}));
vi.mock(import("./automationEditorHarnessData.js"), () => ({
  buildAutomationHarnessEditorData: helpers.buildAgentData,
}));
vi.mock(import("./automationEditorCreateData.js"), () => ({
  buildCreateAutomationEditorData: helpers.buildCreateData,
}));
vi.mock(import("./automationsData.js"), () => ({
  deriveAutomationHero: helpers.deriveHero,
}));
vi.mock(import("./automationThreadData.js"), () => ({
  decideConsentItem: helpers.decideConsent,
  filterConsentForAutomation: helpers.filterConsent,
}));
vi.mock(import("./settingsConnectionsData.js"), () => ({
  beginConnectionAuthorize: helpers.beginAuthorize,
  loadConnectionProvidersData: helpers.loadConnectionProviders,
  loadConnectionsData: helpers.loadConnections,
}));
vi.mock(import("./settingsHarnessesData.js"), () => ({
  loadHarnesses: helpers.loadHarnesses,
}));
vi.mock(import("../webhookReveal.js"), () => ({
  openWebhookReveal: helpers.openWebhookReveal,
}));
vi.mock(import("../../screens/SettingsConnectionsScreen.js"), () => ({
  buildFeatured: helpers.buildFeatured,
}));

const { default: AutomationEditorRoute } =
  await import("./AutomationEditorRoute.js");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(props: {
  automationId?: string;
  templateId?: string;
  watchEntity?: string;
}): Promise<AutomationEditorBridgeProps> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationEditorRoute {...props} />);
  });
  if (!captured.props) throw new Error("editor bridge was not captured");
  return captured.props;
}

describe("AutomationEditorRoute", () => {
  beforeEach(() => {
    captured.props = null;
    actions.confirm.mockReset().mockResolvedValue(true);
    actions.navigate.mockReset();
    actions.showToast.mockReset();

    const row = automationRow();
    api.auth.mockReset().mockResolvedValue({ baseUrl: "https://gateway.test" });
    api.compileAutomation
      .mockReset()
      .mockResolvedValue({ compileTurnId: "compile-1" });
    api.configureConnection.mockReset().mockResolvedValue({
      connectionId: "connection-1",
      credKind: "oauth",
      status: "connected",
    });
    api.createAutomation.mockReset().mockResolvedValue({
      row,
      webhook: {
        id: "hook-1",
        secret: "new-secret",
        url: "https://gateway.test/hook-1",
      },
    });
    api.deleteAutomation.mockReset().mockResolvedValue({ ok: true });
    api.getBlocking.mockReset().mockResolvedValue({
      outbox: [],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    });
    api.getUserPrefs.mockReset().mockResolvedValue({});
    api.listAgents.mockReset().mockResolvedValue([
      {
        agentId: "agent-1",
        enrollmentKey: "daily",
        partyId: "party-1",
        name: "Daily",
        modelRef: "gpt-5",
        enrolledAt: "2026-07-28T00:00:00.000Z",
        grants: [],
      },
    ]);
    api.listOutboxGrants.mockReset().mockResolvedValue([]);
    api.listTemplates.mockReset().mockResolvedValue([
      {
        id: "template-1",
        name: "Template",
        desc: "A test template",
        colorKey: "blue",
        iconKey: "bolt",
        version: "1.0.0",
      },
    ]);
    api.listVaultEntityTypes
      .mockReset()
      .mockResolvedValue(["business.invoice", "core.transaction"]);
    api.readAutomationSource
      .mockReset()
      .mockResolvedValue({ manifest: "{}", handler: "export default {}" });
    api.rotateAutomationWebhookSecret.mockReset().mockResolvedValue({
      webhook: {
        id: "hook-1",
        secret: "rotated",
        url: "https://gateway.test/hook-1",
      },
    });
    api.invokeAutomationAndAwait.mockReset().mockResolvedValue({
      turnId: "turn-1",
      result: { turnId: "turn-1", outcome: { ok: true } },
    });
    api.searchVaultAnchors.mockReset().mockResolvedValue([
      {
        type: "core.link_anchor",
        id: "anchor-1",
        status: "active",
        title: "Invoice amount",
        subtitle: null,
        thumbnail_content_id: null,
        sourceType: "business.invoice",
        sourceId: "invoice-1",
        sourceField: "amount",
      },
    ]);
    api.searchVaultEntities.mockReset().mockResolvedValue([
      {
        type: "business.invoice",
        id: "invoice-1",
        status: "active",
        title: "Invoice 1",
        subtitle: null,
        thumbnail_content_id: null,
      },
    ]);
    api.setAutomationEnabled.mockReset().mockResolvedValue({ ok: true });
    api.updateAutomation.mockReset().mockResolvedValue({
      row,
      webhook: {
        id: "hook-1",
        secret: "minted",
        url: "https://gateway.test/hook-1",
      },
    });

    helpers.beginAuthorize.mockReset().mockResolvedValue("https://auth.test");
    helpers.buildAgentData.mockReset().mockReturnValue({
      harnesses: [],
      defaultModel: null,
      defaultHarnessKind: "codex",
    });
    helpers.buildCreateData.mockReset().mockReturnValue({
      automationId: null,
      consent: { grants: [], outbox: [], parked: [] },
      enabled: false,
      instructions: "",
      mode: "create",
      name: "",
      triggers: [],
      webhook: null,
    } satisfies AutomationEditorData);
    helpers.buildFeatured.mockReset().mockReturnValue([
      {
        key: "github",
        kind: "github",
        meta: {
          name: "GitHub",
          short: "Code",
          blurb: "GitHub connector",
          accessTitle: "GitHub access",
          accessDesc: "Connect GitHub.",
          tone: "blue",
          letter: "G",
        },
        provider: {
          id: "github-cloud",
          allowedHosts: ["github.com"],
          authUrl: "https://github.com/login/oauth",
          credKind: "oauth2",
          name: "GitHub",
          scopes: "repo",
          setup: ["Authorize"],
          tokenUrl: "https://github.com/login/oauth/access_token",
          connectors: [],
          capabilities: { actions: [], syncs: [] },
        },
        providerId: "github-cloud",
        scope: "repo",
        templateId: "github",
      },
    ]);
    helpers.decideConsent.mockReset().mockResolvedValue(true);
    helpers.deriveHero.mockReset().mockReturnValue({
      cronExprs: [],
      nextRuns: [],
      webhook: { pending: false, url: "https://gateway.test/hook-1" },
      dataDetail: null,
      conditionDetail: null,
      kindEyebrow: "Automation",
      heroIcon: "bolt",
      when: "Manual",
    });
    helpers.filterConsent
      .mockReset()
      .mockReturnValue({ grants: [], outbox: [], parked: [] });
    helpers.loadConnectionProviders.mockReset().mockResolvedValue([]);
    helpers.loadConnections.mockReset().mockResolvedValue([
      {
        connectionId: "connection-1",
        health: "ok",
        kind: "github",
        label: "Work",
        principal: "octocat",
        credKind: "oauth2",
        provider: "github-cloud",
        authNote: null,
        lastRunAt: null,
      },
    ]);
    helpers.loadHarnesses.mockReset().mockResolvedValue({
      selectedKind: "codex",
      cards: [],
      anyLoading: false,
      savedModelByKind: {},
      subsystemModelByKind: {},
      defaultConfigPinsByKind: {},
      subsystemConfigPinsByKind: {},
      diagnosticsJson: "{}",
      subsystemHarnessByKey: {},
      subsystemHarnessLadders: {},
    });
    helpers.openWebhookReveal.mockReset().mockResolvedValue(undefined);
    helpers.loadEditor.mockReset().mockResolvedValue({
      connectors: {
        connector: null,
        mcps: [],
        secrets: [],
        vaultPurpose: null,
        vaultScopes: [],
      },
      instructions: "Run daily.",
      model: "openai/gpt-test",
      name: "Daily",
      onFailure: "notify",
      row,
      rowId: "row-1",
      harness: "codex",
      triggers: row.triggers,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe("AutomationEditorRoute", () => {
    it("loads edit data and drives every editor bridge action", async () => {
      const bridge = await mount({ automationId: "daily/daily" });
      const data = await bridge.loadData();
      expect(data).toMatchObject({
        automationId: "daily/daily",
        enabled: true,
        mode: "edit",
        harness: "codex",
      });
      expect(data.triggers.map((trigger) => trigger.kind)).toStrictEqual([
        "webhook",
        "cron",
        "data",
        "condition",
        "event",
      ]);

      await expect(
        bridge.onSave({
          connections: [
            { connectionId: "connection-1", kind: "github", label: "Work" },
          ],
          instructions: "Run every weekday.",
          model: null,
          name: "Daily revised",
          harness: null,
          triggers: [{ kind: "data", entities: ["business.invoice"] }],
        })
      ).resolves.toBe(true);
      expect(api.updateAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: "daily/daily",
          connections: [
            { connectionId: "connection-1", kind: "github", label: "Work" },
          ],
          model: null,
          harness: null,
          vault: expect.objectContaining({
            scopes: [{ schema: "business", table: "invoice", verbs: "read" }],
          }),
        })
      );
      expect(helpers.openWebhookReveal).toHaveBeenCalledWith(
        { id: "hook-1", secret: "minted", url: "https://gateway.test/hook-1" },
        {
          note: "This secret is shown once. Copy it now — you won't see it again.",
          title: "Webhook minted",
        }
      );

      await expect(bridge.onCompile(true)).resolves.toBe("compile-1");
      await expect(bridge.onSearchEntities("invoice")).resolves.toHaveLength(3);
      await expect(bridge.loadEntityTypes?.()).resolves.toContain(
        "business.invoice"
      );
      const catalog = await bridge.loadConnectorCatalog?.();
      expect(catalog?.[0]?.connection?.connectionId).toBe("connection-1");
      await expect(
        bridge.configureConnection?.({
          allowedHosts: ["github.com"],
          apiKey: "",
          authUrl: "https://github.com/login/oauth",
          clientId: "client",
          clientSecret: "secret",
          connectorKind: "github",
          credKind: "oauth2",
          label: "Work",
          providerId: "github-cloud",
          scopes: "repo",
          tokenUrl: "https://github.com/login/oauth/access_token",
        })
      ).resolves.toStrictEqual({ connectionId: "connection-1" });
      await expect(bridge.onReadSource()).resolves.toStrictEqual({
        manifest: "{}",
        handler: "export default {}",
      });

      // A test run returns its turn id and stays put — no navigation.
      await expect(bridge.onTestRun()).resolves.toBe("turn-1");
      // No `onAssist`: the compile screen exposes exactly one editable surface
      // (the instructions field), so there is no conversational edit path here.
      expect("onAssist" in bridge).toBe(false);
      await expect(bridge.onToggleEnabled(false)).resolves.toBe(true);
      await expect(
        bridge.onDecideConsent("outbox", "item-1", "approve", true)
      ).resolves.toBe(true);
      bridge.onOpenRun("turn-1");
      bridge.onCopyWebhook("https://gateway.test/hook-1");
      await vi.waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          "https://gateway.test/hook-1"
        )
      );
      await expect(bridge.onRotateWebhook()).resolves.toBe(true);
      await expect(bridge.onDelete()).resolves.toBe(true);

      expect(actions.navigate).toHaveBeenCalledWith({ kind: "automations" });
    });

    it("builds create-mode data and persists the first automation", async () => {
      helpers.loadEditor.mockResolvedValueOnce({
        connectors: {
          connector: null,
          mcps: [],
          secrets: [],
          vaultPurpose: null,
          vaultScopes: [],
        },
        instructions: "Template instructions",
        model: null,
        name: "From template",
        onFailure: null,
        row: null,
        rowId: null,
        harness: null,
        triggers: [],
      });
      const bridge = await mount({
        templateId: "template-1",
        watchEntity: "business.invoice",
      });
      await bridge.loadData();
      expect(helpers.buildCreateData).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: "Template instructions",
          template: expect.objectContaining({ id: "template-1" }),
          watchEntity: "business.invoice",
        })
      );
      await expect(
        bridge.onSave({
          connections: [],
          instructions: "Create it",
          model: "openai/gpt-test",
          name: "Created",
          harness: "codex",
          triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        })
      ).resolves.toBe(true);
      expect(api.createAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          model: "openai/gpt-test",
          name: "Created",
          harness: "codex",
        })
      );
    });
  });
});
