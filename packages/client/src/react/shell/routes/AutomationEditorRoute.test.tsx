import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationEditorBridgeProps, AutomationEditorData } from '../../screen-contracts.js';
import type { ConnectionRowDTO } from '../../screens/SettingsConnectionsScreen.js';

const captured = vi.hoisted(() => ({
  props: null as AutomationEditorBridgeProps | null,
}));
const actions = vi.hoisted(() => ({
  confirm: vi.fn(),
  navigate: vi.fn(),
  showToast: vi.fn(),
  // Unused by this suite, but required by the real `ShellActions` shape that
  // the typed `vi.mock(import(...))` factory below now checks against.
  builderEnabled: false,
  enterBuilder: vi.fn(),
  openNewAppSheet: vi.fn(),
  openCommandPalette: vi.fn(),
  openContextMenu: vi.fn(),
}));
const api = vi.hoisted(() => ({
  auth: vi.fn(),
  compileAutomation: vi.fn(),
  configureConnection: vi.fn(),
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getBlocking: vi.fn(),
  getUserPrefs: vi.fn(),
  listAgents: vi.fn(),
  listOutboxGrants: vi.fn(),
  listTemplates: vi.fn(),
  listVaultEntityTypes: vi.fn(),
  readAutomationSource: vi.fn(),
  rotateAutomationWebhookSecret: vi.fn(),
  runAutomationNow: vi.fn(),
  searchVaultAnchors: vi.fn(),
  searchVaultEntities: vi.fn(),
  setAutomationEnabled: vi.fn(),
  updateAutomation: vi.fn(),
}));
const helpers = vi.hoisted(() => ({
  beginAuthorize: vi.fn(),
  buildAgentData: vi.fn(),
  buildCreateData: vi.fn(),
  buildFeatured: vi.fn(),
  decideConsent: vi.fn(),
  deriveHero: vi.fn(),
  filterConsent: vi.fn(),
  loadConnectionProviders: vi.fn(),
  loadConnections: vi.fn(),
  loadEditor: vi.fn(),
  loadProviders: vi.fn(),
  openWebhookReveal: vi.fn(),
}));

vi.mock(import('../../../gateway-client.js'), () => api);
vi.mock(import('../actions.js'), () => ({ useShellActions: () => actions }));
vi.mock(import('../PageScroll.js'), () => ({
  // Wrapped in a fragment (not returned bare) so this matches the real
  // `PageScroll`'s `JSX.Element` return type instead of `ReactNode`.
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock(import('../../screens/AutomationEditorScreen.js'), () => ({
  default: (props: AutomationEditorBridgeProps) => {
    captured.props = props;
    // An empty fragment renders nothing (same as `null` did), but matches the
    // real screen's `JSX.Element` return type.
    return <></>;
  },
}));
vi.mock(import('./automationEditorData.js'), () => ({
  loadAutomationEditorData: helpers.loadEditor,
}));
vi.mock(import('./automationEditorAgentData.js'), () => ({
  buildAutomationAgentEditorData: helpers.buildAgentData,
}));
vi.mock(import('./automationEditorCreateData.js'), () => ({
  buildCreateAutomationEditorData: helpers.buildCreateData,
}));
vi.mock(import('./automationsData.js'), () => ({ deriveAutomationHero: helpers.deriveHero }));
vi.mock(import('./automationThreadData.js'), () => ({
  decideConsentItem: helpers.decideConsent,
  filterConsentForAutomation: helpers.filterConsent,
}));
vi.mock(import('./settingsConnectionsData.js'), () => ({
  beginConnectionAuthorize: helpers.beginAuthorize,
  loadConnectionProvidersData: helpers.loadConnectionProviders,
  loadConnectionsData: helpers.loadConnections,
}));
vi.mock(import('./settingsProvidersData.js'), () => ({ loadProviders: helpers.loadProviders }));
vi.mock(import('../webhookReveal.js'), () => ({ openWebhookReveal: helpers.openWebhookReveal }));
vi.mock(import('../../screens/SettingsConnectionsScreen.js'), () => ({
  buildFeatured: helpers.buildFeatured,
}));

const {
  default: AutomationEditorRoute,
  matchEditorConnection,
  vaultForTriggers,
} = await import('./AutomationEditorRoute.js');

function automationRow(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest['triggers'] = [
    { kind: 'webhook', id: 'hook-1' },
    { kind: 'cron', expr: '0 9 * * *' },
    { kind: 'data', entities: ['business.invoice'], every: '5m' },
    {
      kind: 'condition',
      entity: 'business.invoice',
      every: '10m',
      where: [{ column: 'status', op: 'eq', value: 'open' }],
    },
    {
      kind: 'event',
      connectorKind: 'github',
      event: 'issues.opened',
      filter: { label: 'bug' },
      every: '15m',
    },
  ];
  return {
    id: 'daily',
    dir: '/apps/daily',
    name: 'Daily',
    triggers,
    enabled: true,
    ownerApp: 'daily',
    ref: 'daily/daily',
    manifest: {
      name: 'Daily',
      version: '0.1.0',
      enabled: true,
      prompt: 'Run daily.',
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: 'agent', at: '2026-07-25T00:00:00.000Z' },
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(props: {
  automationId?: string;
  templateId?: string;
  watchEntity?: string;
}): Promise<AutomationEditorBridgeProps> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationEditorRoute {...props} />);
  });
  if (!captured.props) throw new Error('editor bridge was not captured');
  return captured.props;
}

describe('AutomationEditorRoute', () => {
  beforeEach(() => {
    captured.props = null;
    actions.confirm.mockReset().mockResolvedValue(true);
    actions.navigate.mockReset();
    actions.showToast.mockReset();

    const row = automationRow();
    api.auth.mockReset().mockResolvedValue({ baseUrl: 'https://gateway.test' });
    api.compileAutomation.mockReset().mockResolvedValue({ compileTurnId: 'compile-1' });
    api.configureConnection.mockReset().mockResolvedValue({ connectionId: 'connection-1' });
    api.createAutomation.mockReset().mockResolvedValue({
      row,
      webhook: { id: 'hook-1', secret: 'new-secret', url: 'https://gateway.test/hook-1' },
    });
    api.deleteAutomation.mockReset().mockResolvedValue({ ok: true });
    api.getBlocking.mockReset().mockResolvedValue({});
    api.getUserPrefs.mockReset().mockResolvedValue({});
    api.listAgents.mockReset().mockResolvedValue([{ agentId: 'agent-1', hostKey: 'daily' }]);
    api.listOutboxGrants.mockReset().mockResolvedValue([]);
    api.listTemplates.mockReset().mockResolvedValue([{ id: 'template-1', name: 'Template' }]);
    api.listVaultEntityTypes
      .mockReset()
      .mockResolvedValue(['business.invoice', 'core.transaction']);
    api.readAutomationSource
      .mockReset()
      .mockResolvedValue({ manifest: '{}', handler: 'export default {}' });
    api.rotateAutomationWebhookSecret.mockReset().mockResolvedValue({
      webhook: { id: 'hook-1', secret: 'rotated', url: 'https://gateway.test/hook-1' },
    });
    api.runAutomationNow.mockReset().mockResolvedValue({ turnId: 'turn-1' });
    api.searchVaultAnchors.mockReset().mockResolvedValue([
      {
        type: 'core.link_anchor',
        id: 'anchor-1',
        status: 'active',
        title: 'Invoice amount',
        subtitle: null,
        thumbnail_content_id: null,
        sourceType: 'business.invoice',
        sourceId: 'invoice-1',
        sourceField: 'amount',
      },
    ]);
    api.searchVaultEntities.mockReset().mockResolvedValue([
      {
        type: 'business.invoice',
        id: 'invoice-1',
        status: 'active',
        title: 'Invoice 1',
        subtitle: null,
        thumbnail_content_id: null,
      },
    ]);
    api.setAutomationEnabled.mockReset().mockResolvedValue({ ok: true });
    api.updateAutomation.mockReset().mockResolvedValue({
      row,
      webhook: { id: 'hook-1', secret: 'minted', url: 'https://gateway.test/hook-1' },
    });

    helpers.beginAuthorize.mockReset().mockResolvedValue({ url: 'https://auth.test' });
    helpers.buildAgentData.mockReset().mockReturnValue({ agentChoices: [] });
    helpers.buildCreateData.mockReset().mockReturnValue({
      automationId: null,
      consent: { grants: [], outbox: [], parked: [] },
      enabled: false,
      instructions: '',
      mode: 'create',
      name: '',
      triggers: [],
      webhook: null,
    } satisfies AutomationEditorData);
    helpers.buildFeatured.mockReset().mockReturnValue([
      {
        key: 'github',
        kind: 'github',
        meta: { name: 'GitHub', tone: 'blue' },
        provider: {
          allowedHosts: ['github.com'],
          authUrl: 'https://github.com/login/oauth',
          credKind: 'oauth2',
          name: 'GitHub',
          scopes: 'repo',
          setup: ['Authorize'],
          tokenUrl: 'https://github.com/login/oauth/access_token',
        },
        providerId: 'github-cloud',
        scope: 'repo',
        templateId: 'github',
      },
    ]);
    helpers.decideConsent.mockReset().mockResolvedValue(true);
    helpers.deriveHero.mockReset().mockReturnValue({ webhook: 'https://gateway.test/hook-1' });
    helpers.filterConsent.mockReset().mockReturnValue({ grants: [], outbox: [], parked: [] });
    helpers.loadConnectionProviders.mockReset().mockResolvedValue([]);
    helpers.loadConnections.mockReset().mockResolvedValue([
      {
        connectionId: 'connection-1',
        health: 'active',
        kind: 'github',
        label: 'Work',
        principal: 'octocat',
        provider: 'github-cloud',
      },
    ]);
    helpers.loadProviders.mockReset().mockResolvedValue([]);
    helpers.openWebhookReveal.mockReset().mockResolvedValue(undefined);
    helpers.loadEditor.mockReset().mockResolvedValue({
      connectors: [],
      instructions: 'Run daily.',
      model: 'openai/gpt-test',
      name: 'Daily',
      onFailure: 'notify',
      row,
      rowId: 'row-1',
      runner: 'codex',
      triggers: row.triggers,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe('AutomationEditorRoute', () => {
    it('loads edit data and drives every editor bridge action', async () => {
      const bridge = await mount({ automationId: 'daily/daily' });
      const data = await bridge.loadData();
      expect(data).toMatchObject({
        automationId: 'daily/daily',
        enabled: true,
        mode: 'edit',
        runner: 'codex',
      });
      expect(data.triggers.map((trigger) => trigger.kind)).toStrictEqual([
        'webhook',
        'cron',
        'data',
        'condition',
        'event',
      ]);

      await expect(
        bridge.onSave({
          connections: [{ connectionId: 'connection-1', kind: 'github', label: 'Work' }],
          instructions: 'Run every weekday.',
          model: null,
          name: 'Daily revised',
          runner: null,
          triggers: [{ kind: 'data', entities: ['business.invoice'] }],
        }),
      ).resolves.toBe(true);
      expect(api.updateAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          automationId: 'daily/daily',
          connections: [{ connectionId: 'connection-1', kind: 'github', label: 'Work' }],
          model: null,
          runner: null,
          vault: expect.objectContaining({
            scopes: [{ schema: 'business', table: 'invoice', verbs: 'read' }],
          }),
        }),
      );
      expect(helpers.openWebhookReveal).toHaveBeenCalledWith(
        { id: 'hook-1', secret: 'minted', url: 'https://gateway.test/hook-1' },
        {
          note: "This secret is shown once. Copy it now — you won't see it again.",
          title: 'Webhook minted',
        },
      );

      await expect(bridge.onCompile(true)).resolves.toBe('compile-1');
      await expect(bridge.onSearchEntities('invoice')).resolves.toHaveLength(3);
      await expect(bridge.loadEntityTypes?.()).resolves.toContain('business.invoice');
      const catalog = await bridge.loadConnectorCatalog?.();
      expect(catalog?.[0]?.connection?.connectionId).toBe('connection-1');
      await expect(
        bridge.configureConnection?.({
          allowedHosts: ['github.com'],
          apiKey: '',
          authUrl: 'https://github.com/login/oauth',
          clientId: 'client',
          clientSecret: 'secret',
          connectorKind: 'github',
          credKind: 'oauth2',
          label: 'Work',
          providerId: 'github-cloud',
          scopes: 'repo',
          tokenUrl: 'https://github.com/login/oauth/access_token',
        }),
      ).resolves.toStrictEqual({ connectionId: 'connection-1' });
      await expect(bridge.onReadSource()).resolves.toStrictEqual({
        manifest: '{}',
        handler: 'export default {}',
      });

      // A test run returns its turn id and stays put — no navigation.
      await expect(bridge.onTestRun()).resolves.toBe('turn-1');
      // No `onAssist`: the compile screen exposes exactly one editable surface
      // (the instructions field), so there is no conversational edit path here.
      expect('onAssist' in bridge).toBe(false);
      await expect(bridge.onToggleEnabled(false)).resolves.toBe(true);
      await expect(bridge.onDecideConsent('outbox', 'item-1', 'approve', true)).resolves.toBe(true);
      bridge.onOpenRun('turn-1');
      bridge.onCopyWebhook('https://gateway.test/hook-1');
      await vi.waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://gateway.test/hook-1'),
      );
      await expect(bridge.onRotateWebhook()).resolves.toBe(true);
      await expect(bridge.onDelete()).resolves.toBe(true);

      expect(actions.navigate).toHaveBeenCalledWith({ kind: 'automations' });
    });

    it('builds create-mode data and persists the first automation', async () => {
      helpers.loadEditor.mockResolvedValueOnce({
        connectors: [],
        instructions: 'Template instructions',
        model: undefined,
        name: 'From template',
        onFailure: undefined,
        row: null,
        rowId: undefined,
        runner: undefined,
        triggers: [],
      });
      const bridge = await mount({
        templateId: 'template-1',
        watchEntity: 'business.invoice',
      });
      await bridge.loadData();
      expect(helpers.buildCreateData).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: 'Template instructions',
          template: expect.objectContaining({ id: 'template-1' }),
          watchEntity: 'business.invoice',
        }),
      );
      await expect(
        bridge.onSave({
          connections: [],
          instructions: 'Create it',
          model: 'openai/gpt-test',
          name: 'Created',
          runner: 'codex',
          triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
        }),
      ).resolves.toBe(true);
      expect(api.createAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          model: 'openai/gpt-test',
          name: 'Created',
          runner: 'codex',
        }),
      );
    });

    it('derives narrow trigger scopes and exact multi-account connector matches', () => {
      expect(
        vaultForTriggers([
          { kind: 'data', entities: ['business.invoice', 'business.invoice', 'core.transaction'] },
        ]),
      ).toStrictEqual({
        purpose: 'dpv:ServiceProvision',
        why: 'Evaluate automation triggers.',
        scopes: [
          { schema: 'business', table: 'invoice', verbs: 'read' },
          { schema: 'core', table: 'transaction', verbs: 'read' },
        ],
      });
      expect(vaultForTriggers([{ kind: 'cron', expr: '* * * * *' }])).toBeUndefined();

      const connections: ConnectionRowDTO[] = [
        {
          authNote: null,
          connectionId: 'one',
          credKind: 'oauth2',
          health: 'ok',
          kind: 'github',
          label: 'One',
          lastRunAt: null,
          principal: null,
          provider: 'github-cloud',
        },
        {
          authNote: null,
          connectionId: 'two',
          credKind: 'oauth2',
          health: 'ok',
          kind: 'github',
          label: 'Two',
          lastRunAt: null,
          principal: null,
          provider: 'github-cloud',
        },
      ];
      expect(matchEditorConnection(connections, 'github-cloud', 'github')).toMatchObject({
        match: null,
        matches: connections,
      });
      expect(
        matchEditorConnection(connections.slice(0, 1), 'github-cloud', 'github'),
      ).toMatchObject({
        match: connections[0],
      });
    });
  });
});
