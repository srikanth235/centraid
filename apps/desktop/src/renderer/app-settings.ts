// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// Global Settings page (Appearance / Layout / Workspace / Agents / Profiles)
// and the app Share dialog. Extracted from app.ts. The page builds its own
// chrome window (window.Chrome) with a sidebar from ctx.buildHomeSidebar, and
// drives shell-owned state (prefs, profiles, the live sidebar setter) through
// the ShellContext accessors.
import { getAgentsStatus, getUserPrefs, listVaults, saveUserPrefs } from './gateway-client.js';
import { renderPhonePage } from './app-phone.js';
import { renderImportPage } from './app-import.js';
import { ACCENT_PALETTE } from './app-shell-context.js';
import type {
  AccentKey,
  CardVariant,
  Density,
  ShellContext,
  ThemeName,
  TileVariant,
} from './app-shell-context.js';
import type { AgentRunnerKind, AgentsStatusDTO } from './react/bridge.js';

export interface SettingsModule {
  renderSettings(initialPage?: string): void;
  openShareDialog(app: AppMetaResolvedType): void;
}

export function createSettingsModule(ctx: ShellContext): SettingsModule {
  const {
    el,
    teardownCurrent,
    isCurrentRender,
    chromeNav,
    recordRoute,
    registerCleanup,
    showToast,
    setPrefs,
    getPrefs,
    getGateway,
    getRenderSeq,
    root,
    setOnAppearanceApplied,
    setLastSettingsPage,
    setSidebarOpenSetter,
    toggleSidebar,
    buildHomeSidebar,
    toProfileView,
    switchProfile,
    openProfileModal,
    requestDeleteProfile,
  } = ctx;

  function renderSettings(initialPage?: string): void {
    void renderSettingsAsync(initialPage);
  }

  async function renderSettingsAsync(initialPage?: string): Promise<void> {
    recordRoute({ kind: 'settings' });
    // Keep the current view up while the gateways IPC resolves; clear() here
    // would blank the window until it returns (flicker). The shell is swapped
    // in atomically at the end.
    teardownCurrent();
    const seq = getRenderSeq();

    // Spaces are backed by VAULTS (#280) — fetch the registry so the
    // Account → Spaces manage page can render the cards. Connections
    // (gateway endpoints) render as their own group below.
    const vaultList = await listVaults()
      .then((v) => v ?? [])
      .catch(() => []);
    // The addressed vault is client-side state now (#289) — read it from the
    // gateway auth (the `x-centraid-vault` pointer), not a server flag.
    const activeVaultId = await window.CentraidApi.getGatewayAuth()
      .then((a) => a.vaultId ?? vaultList[0]?.vaultId ?? '')
      .catch(() => vaultList[0]?.vaultId ?? '');
    const connectionList = await window.CentraidApi.listGateways().catch(() => []);
    const activeConnectionId = getGateway()?.activeId ?? 'local';

    const main = el('div', { class: 'cd-settings-main' });

    // §C1 — break the Settings monolith into discrete inner-sidebar
    // pages. Each `drawerGroup` appends into its page host instead of
    // one continuous scroll; an inner sidebar (built at the end) swaps
    // which host is visible.
    type SettingsPageId =
      | 'appearance'
      | 'layout'
      | 'workspace'
      | 'profiles'
      | 'phone'
      | 'import'
      | 'providers';
    const pageHosts: Record<SettingsPageId, HTMLElement> = {
      appearance: el('div', { class: 'cd-settings-page' }),
      layout: el('div', { class: 'cd-settings-page' }),
      workspace: el('div', { class: 'cd-settings-page' }),
      profiles: el('div', { class: 'cd-settings-page' }),
      phone: el('div', { class: 'cd-settings-page' }),
      import: el('div', { class: 'cd-settings-page' }),
      providers: el('div', { class: 'cd-settings-page' }),
    };

    // ---- Theme group ----
    // VSCode-style preset picker — every entry in THEME_PRESETS gets a
    // card with a live mini-preview built from that theme's tokens. The
    // "Match system" button resolves OS `prefers-color-scheme` to the
    // matching Centraid theme; it's a one-shot, no new persisted state.
    const themePicker = makeThemePicker(
      () => getPrefs().theme,
      (v) => setPrefs({ theme: v }),
    );
    const matchSystemBtn = el('button', { class: 'cd-link-btn', type: 'button' }, 'Match system');
    matchSystemBtn.addEventListener('click', () => {
      const next: ThemeName = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
      setPrefs({ theme: next });
    });
    const coolCastSwitch = makeSwitch(getPrefs().coolBlueCast, (v) =>
      setPrefs({ coolBlueCast: v }),
    );
    const accentSwatches = makeSwatches(getPrefs().accent, (v) => setPrefs({ accent: v }));

    // ---- Layout group ----
    const densitySeg = makeSegmented<Density>(
      ['compact', 'regular', 'comfy'],
      getPrefs().density,
      (v) => setPrefs({ density: v }),
    );
    const cardsSeg = makeSegmented<CardVariant>(
      ['flat', 'outlined', 'elevated'],
      getPrefs().cardVariant,
      (v) => setPrefs({ cardVariant: v }),
    );
    const sidebarSwitch = makeSwitch(getPrefs().sidebarOpen, (v) => {
      setPrefs({ sidebarOpen: v });
      ctx.applySidebarOpen(v);
    });

    // ---- App tiles group ----
    const tileSeg = makeSegmented<TileVariant>(
      ['solid', 'gradient', 'glassy', 'flat'],
      getPrefs().tileVariant,
      (v) => {
        setPrefs({ tileVariant: v });
      },
    );

    // §C2 — live-preview tile. A 4-up grid of representative app tiles
    // (icon + name) that re-renders on every appearance change so the
    // user sees the theme / accent / tile-variant land on real tiles.
    const previewHost = el('div', { class: 'ap-preview-host' });
    const renderAppearancePreview = (): void => {
      const seeds: ReadonlyArray<{ color: string; icon: IconNameType; name: string }> = [
        { color: '#4E68DD', icon: 'Todo', name: 'Tasks' },
        { color: '#7C5BD9', icon: 'Journal', name: 'Journal' },
        { color: '#E55772', icon: 'Pencil', name: 'Notes' },
        { color: '#2EA098', icon: 'Habit', name: 'Weekly' },
      ];
      const tiles = seeds.map((s) => {
        const finish = window.CentraidTokens.tileFinish(s.color, getPrefs().tileVariant);
        const icon = el('div', {
          class: 'ap-preview-tile-icon',
          trustedHtml: Icon[s.icon]
            ? Icon[s.icon]({ size: 18, strokeWidth: 1.85 })
            : Icon.Folder({ size: 18 }),
        });
        icon.style.background = finish.background;
        icon.style.color = finish.glyphColor;
        if (finish.boxShadow) icon.style.boxShadow = finish.boxShadow;
        return el('div', { class: 'ap-preview-tile' }, [
          icon,
          el('span', { class: 'ap-preview-tile-name' }, s.name),
        ]);
      });
      previewHost.replaceChildren(el('div', { class: 'ap-preview' }, tiles));
    };
    // Phase 3 (#325): render the Appearance + Layout pages via the ported React
    // screens when the bundle is loaded (mounted into their page hosts, like the
    // Phone/Import panes). The rest of the settings route — inner-sidebar nav,
    // profiles, providers — stays vanilla. Each control calls setPrefs, which
    // re-themes the running app exactly as before.
    const settingsBridge = window.CentraidReact;
    if (settingsBridge?.mountSettingsAppearance && settingsBridge.mountSettingsLayout) {
      registerCleanup(
        settingsBridge.mountSettingsAppearance(pageHosts.appearance, {
          accent: getPrefs().accent,
          coolBlueCast: getPrefs().coolBlueCast,
          onMatchSystem: () => {
            const next: ThemeName = window.matchMedia('(prefers-color-scheme: light)').matches
              ? 'light'
              : 'dark';
            setPrefs({ theme: next });
            return next;
          },
          onSetAccent: (k) => setPrefs({ accent: k as AccentKey }),
          onSetCoolCast: (v) => setPrefs({ coolBlueCast: v }),
          onSetTheme: (t) => setPrefs({ theme: t as ThemeName }),
          onSetTile: (v) => setPrefs({ tileVariant: v }),
          theme: getPrefs().theme,
          tileVariant: getPrefs().tileVariant,
        }),
      );
      registerCleanup(
        settingsBridge.mountSettingsLayout(pageHosts.layout, {
          cardVariant: getPrefs().cardVariant,
          density: getPrefs().density,
          onSetCards: (v) => setPrefs({ cardVariant: v }),
          onSetDensity: (v) => setPrefs({ density: v }),
          onSetSidebar: (v) => {
            setPrefs({ sidebarOpen: v });
            ctx.applySidebarOpen(v);
          },
          sidebarOpen: getPrefs().sidebarOpen,
        }),
      );
    } else {
      renderAppearancePreview();
      // Chain both refresh hooks behind `onAppearanceApplied` so a setPrefs
      // call from elsewhere (e.g. Match-system) keeps the theme picker's
      // active highlight in lockstep with the live tile preview.
      const refreshPicker = (themePicker as HTMLElement & { _refresh?: () => void })._refresh;
      setOnAppearanceApplied(() => {
        renderAppearancePreview();
        refreshPicker?.();
      });
      registerCleanup(() => {
        setOnAppearanceApplied(null);
      });

      pageHosts.appearance.append(
        drawerGroup('Theme', [
          drawerRowH(
            'Color theme',
            'Pick a preset for the Centraid shell. Apps stay in their own light/dark palette.',
            themePicker,
            true,
          ),
          drawerRowH(
            'Match system',
            'Snap the theme to your OS appearance right now.',
            matchSystemBtn,
          ),
          drawerRowH(
            'Cool blue cast',
            'Tint dark surfaces toward blue. Off = neutral graphite. Centraid Dark only.',
            coolCastSwitch,
          ),
        ]),
        drawerGroup('Accent', [
          drawerRowH(
            'Color',
            'Used for the build button, sparkle, focus rings, and version badges.',
            accentSwatches,
          ),
        ]),
        drawerGroup('App tiles', [
          drawerRowH('Treatment', 'How icon tiles on the home grid look.', tileSeg),
          drawerRowH(
            'Preview',
            'How the home grid looks with your current choices.',
            previewHost,
            true,
          ),
        ]),
      );
      pageHosts.layout.append(
        drawerGroup('Density', [
          drawerRowH(
            'Spacing',
            'Affects row height, type sizes, and spacing across all apps.',
            densitySeg,
          ),
        ]),
        drawerGroup('Cards', [
          drawerRowH(
            'Surface',
            'Affects every card-shaped surface — app tiles, message rows, settings groups.',
            cardsSeg,
          ),
        ]),
        drawerGroup('Sidebar', [
          drawerRowH('Show sidebar', 'Toggle the apps + chats panel.', sidebarSwitch),
        ]),
      );
    }

    // Gateway selection + lifecycle (add / rename / remove) lives on the
    // Profiles page (profiles are backed by gateways). Paths are fixed under
    // userData and are not user-configurable, so there's no separate runtime
    // page.

    // The in-app chat's model picker used to live here, as a single global
    // "Model" dropdown. It moved into the chat composer as a coupled
    // Agent · Model control (app-chat.ts) so the model reads as a property of
    // the active agent — see issue #188. Storage is now per-runner
    // (`chatModelByRunner`); there is no global model setting to surface here.

    // ---- Agents (Claude Code / Codex credential status) ----
    // Centraid's coding agent runs the user's installed CLIs in place:
    // codex app-server reads `~/.codex/auth.json` (set up by `codex login`)
    // and the Claude Agent SDK reads `ANTHROPIC_API_KEY`. Detection lives on
    // the gateway (`GET /centraid/_agents/status`) — it's colocated with the
    // runner, so a remote gateway reports its own host's agents. This panel
    // just reads that snapshot and shows which backends are ready.
    // Phase 3 (#325): render the Providers (agents) console via the ported
    // React screen when the bundle is loaded; gateway I/O stays vanilla in the
    // callbacks. The vanilla builder below is the fallback.
    const providersBridge = window.CentraidReact;
    if (providersBridge?.mountSettingsProviders) {
      const RUNNER_META = [
        { kind: 'codex', title: 'Codex', bin: 'codex', accent: '#10b981' },
        { kind: 'claude-code', title: 'Claude Code', bin: 'claude', accent: '#a855f7' },
      ] as const;
      type Snap = Awaited<ReturnType<typeof getAgentsStatus>>;
      const toDTO = (
        status: Snap,
        kind: AgentRunnerKind,
        modelMap: Record<string, string>,
      ): AgentsStatusDTO => ({
        anyLoading: [
          status.codexModelsStatus,
          status.claudeModelsStatus,
          status.codexToolsStatus,
          status.claudeToolsStatus,
        ].some((s) => s === 'loading'),
        cards: RUNNER_META.map((r) => {
          const available = r.kind === 'codex' ? status.codexAvailable : status.claudeAvailable;
          const ver = r.kind === 'codex' ? status.codexVersion : status.claudeVersion;
          const models = (r.kind === 'codex' ? status.codexModels : status.claudeModels) ?? [];
          const tools = (r.kind === 'codex' ? status.codexTools : status.claudeTools) ?? [];
          const modelsStatus =
            r.kind === 'codex' ? status.codexModelsStatus : status.claudeModelsStatus;
          const toolsStatus =
            r.kind === 'codex' ? status.codexToolsStatus : status.claudeToolsStatus;
          return {
            accent: r.accent,
            connected: available,
            kind: r.kind,
            models: models.map((m) => ({
              default: m.default,
              id: m.id,
              name: m.name,
              tier: m.tier,
            })),
            modelsLoading: modelsStatus === 'loading' && models.length === 0,
            subtitle: available ? (ver ?? `${r.bin} · detected`) : `${r.bin} CLI not found on PATH`,
            title: r.title,
            tools: tools.map((t) => ({
              description: t.description,
              hasArgs: t.inputSchema !== undefined,
              name: t.name,
              server: t.server,
              source: t.source,
            })),
            toolsLoading: toolsStatus === 'loading' && tools.length === 0,
          };
        }),
        savedModelByKind: modelMap,
        selectedKind: kind,
      });
      const loadProviders = async (opts?: {
        refresh?: boolean;
        refreshTools?: boolean;
      }): Promise<AgentsStatusDTO> => {
        const [status, kindRaw, modelMap] = await Promise.all([
          getAgentsStatus(opts).catch(
            () => ({ codexAvailable: false, claudeAvailable: false }) as Snap,
          ),
          getUserPrefs()
            .then((p) => p['agent.runner.kind'])
            .catch(() => undefined),
          window.CentraidApi.getSettings()
            .then((s) => s.chatModelByRunner)
            .catch(() => undefined),
        ]);
        return toDTO(status, kindRaw === 'claude-code' ? 'claude-code' : 'codex', modelMap ?? {});
      };
      registerCleanup(
        providersBridge.mountSettingsProviders(pageHosts.providers, {
          activateRunner: async (kind) => {
            try {
              await saveUserPrefs({ 'agent.runner.kind': kind });
              showToast(
                kind === 'codex'
                  ? 'Codex is now the active agent'
                  : 'Claude Code is now the active agent',
              );
              return true;
            } catch (err) {
              showToast(`Couldn’t switch agent: ${String(err)}`);
              return false;
            }
          },
          loadStatus: () => loadProviders(),
          refreshModels: () => loadProviders({ refresh: true }),
          refreshTools: () => loadProviders({ refreshTools: true }),
          setAgentModel: (kind, v) => {
            void window.CentraidApi.saveSettings({ chatModelByRunner: { [kind]: v } });
          },
        }),
      );
    } else {
      const authStatusHost = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      });

      type AuthStatusSnapshot = Awaited<ReturnType<typeof getAgentsStatus>>;
      // Which CLI the gateway actually drives, mirroring the gateway pref
      // `agent.runner.kind` (default `codex` when unset — see build-gateway's
      // prefs loader). Switching writes that pref back; the badges below
      // reflect THIS selection, not a hardcoded codex-first ordering.
      type ActiveRunnerKind = 'codex' | 'claude-code';
      type AgentTool = NonNullable<AuthStatusSnapshot['claudeTools']>[number];
      let selectedRunnerKind: ActiveRunnerKind = 'codex';
      let lastStatus: AuthStatusSnapshot | null = null;
      let switchingRunner = false;
      // Which agents' tool lists are expanded — kept across re-renders so a
      // Refresh doesn't collapse an open panel.
      const toolsOpen = new Set<ActiveRunnerKind>();

      // Persist the picked agent and re-render. Optimistic: flip the local
      // selection first so the badges move immediately, revert on failure.
      const activateRunner = async (kind: ActiveRunnerKind): Promise<void> => {
        if (kind === selectedRunnerKind || switchingRunner) return;
        const prev = selectedRunnerKind;
        selectedRunnerKind = kind;
        switchingRunner = true;
        renderAuthStatus(lastStatus);
        try {
          await saveUserPrefs({ 'agent.runner.kind': kind });
          showToast(
            kind === 'codex'
              ? 'Codex is now the active agent'
              : 'Claude Code is now the active agent',
          );
        } catch (err) {
          selectedRunnerKind = prev;
          showToast(`Couldn’t switch agent: ${String(err)}`);
        } finally {
          switchingRunner = false;
          renderAuthStatus(lastStatus);
        }
      };

      const RUNNERS: ReadonlyArray<{
        kind: ActiveRunnerKind;
        title: string;
        bin: string;
        accent: string;
        available: (s: AuthStatusSnapshot) => boolean;
        version: (s: AuthStatusSnapshot) => string | undefined;
      }> = [
        {
          kind: 'codex',
          title: 'Codex',
          bin: 'codex',
          accent: '#10b981',
          available: (s) => s.codexAvailable,
          version: (s) => s.codexVersion,
        },
        {
          kind: 'claude-code',
          title: 'Claude Code',
          bin: 'claude',
          accent: '#a855f7',
          available: (s) => s.claudeAvailable,
          version: (s) => s.claudeVersion,
        },
      ];

      // Per-agent default model. Each agent's models come from the agents-status
      // snapshot (`codexModels` / `claudeModels`); the choice is stored per-runner
      // in `chatModelByRunner` and is independent of which agent is active — you
      // can set each agent's default without switching the active one.
      const MODEL_TIER_ORDER = ['smart', 'balanced', 'fast'] as const;
      const MODEL_TIER_LABEL: Record<(typeof MODEL_TIER_ORDER)[number], string> = {
        smart: 'Most capable',
        balanced: 'Balanced',
        fast: 'Fastest',
      };
      type AgentModelOpt = {
        id: string;
        name?: string;
        default?: boolean;
        tier?: 'smart' | 'balanced' | 'fast';
      };
      let agentModelByRunner: Record<string, string> = {};

      // Active-agent switch — the single, obvious control for which agent runs.
      // Built once and updated in place (not recreated on each render) so the
      // accent pill SLIDES under the active segment instead of jumping.
      const RUNNER_INDEX: Record<ActiveRunnerKind, number> = { codex: 0, 'claude-code': 1 };
      const agentSwitchInd = el('span', { class: 'agent-switch-ind' });
      const agentSwitchSegs = {} as Record<ActiveRunnerKind, HTMLButtonElement>;
      for (const runner of RUNNERS) {
        agentSwitchSegs[runner.kind] = el(
          'button',
          {
            class: 'agent-switch-seg',
            type: 'button',
            role: 'tab',
            title: `Make ${runner.title} the active agent`,
            onClick: () => void activateRunner(runner.kind),
          },
          [
            el('span', { class: 'agent-switch-dot', style: { background: runner.accent } }),
            el('span', {}, runner.title),
          ],
        ) as HTMLButtonElement;
      }
      const agentSwitch = el(
        'div',
        { class: 'agent-switch', role: 'tablist', 'aria-label': 'Active agent' },
        [agentSwitchInd, agentSwitchSegs.codex, agentSwitchSegs['claude-code']],
      );
      const updateAgentSwitch = (status: AuthStatusSnapshot | null): void => {
        const activeAccent =
          RUNNERS.find((r) => r.kind === selectedRunnerKind)?.accent ?? 'var(--accent)';
        agentSwitch.style.setProperty('--seg-accent', activeAccent);
        agentSwitch.dataset.activeIndex = String(RUNNER_INDEX[selectedRunnerKind]);
        for (const runner of RUNNERS) {
          const seg = agentSwitchSegs[runner.kind];
          const available = status ? runner.available(status) : false;
          const active = runner.kind === selectedRunnerKind;
          seg.dataset.active = active ? 'true' : '';
          seg.dataset.unavail = available ? '' : 'true';
          seg.setAttribute('aria-selected', active ? 'true' : 'false');
          // Only an available, non-active agent is switchable.
          if (available && !active) seg.removeAttribute('disabled');
          else seg.setAttribute('disabled', '');
        }
      };

      // The agent cards (status + per-agent model picker) live in their own host
      // so renderAuthStatus can rebuild them without recreating the switch above.
      const agentCardsHost = el('div', { class: 'agents-panel' });
      authStatusHost.append(
        el(
          'div',
          { class: 'settings-note' },
          'Switch the active agent above; set each agent’s default model below. Detection is CLI-only — the gateway ran `<bin> --version`; Centraid doesn’t inspect how each agent authenticates.',
        ),
        agentSwitch,
        agentCardsHost,
      );

      const renderAuthStatus = (status: AuthStatusSnapshot | null): void => {
        lastStatus = status;
        updateAgentSwitch(status);
        if (!status) {
          agentCardsHost.replaceChildren(
            el('div', { class: 'settings-note' }, 'Reading credential status…'),
          );
          return;
        }
        // Each agent is a row in the panel: accent dot + name/version on the left,
        // its OWN default-model picker on the right. Activation is the switch
        // above — the row isn't clickable, so the select never fights a tap.
        // Group an agent's tools into a "Built-in" group then one group per MCP
        // server (servers sorted), each a labelled list of name + optional args
        // chip + description. Returns the group elements (empty array → caller
        // shows the empty state).
        const renderToolGroups = (tools: readonly AgentTool[]): HTMLElement[] => {
          const native = tools.filter((t) => t.source === 'native');
          const mcp = new Map<string, AgentTool[]>();
          for (const t of tools) {
            if (t.source !== 'mcp') continue;
            const server = t.server ?? 'mcp';
            const list = mcp.get(server) ?? [];
            list.push(t);
            mcp.set(server, list);
          }
          const groups: Array<{ label: string; items: AgentTool[] }> = [];
          if (native.length) groups.push({ label: 'Built-in', items: native });
          for (const server of [...mcp.keys()].sort((a, b) => a.localeCompare(b))) {
            groups.push({ label: server, items: mcp.get(server) ?? [] });
          }
          return groups.map((g) => {
            const items = g.items
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) =>
                el('div', { class: 'tool-item' }, [
                  el('div', { class: 'tool-item-head' }, [
                    el('span', { class: 'tool-name' }, t.name),
                    t.inputSchema !== undefined
                      ? el('span', { class: 'tool-args', title: 'Takes JSON arguments' }, 'args')
                      : false,
                  ]),
                  t.description ? el('span', { class: 'tool-desc' }, t.description) : false,
                ]),
              );
            return el('div', { class: 'tools-group' }, [
              el('div', { class: 'tools-group-head' }, [
                el('span', { class: 'tools-group-label' }, g.label),
                el('span', { class: 'tools-group-count' }, String(g.items.length)),
              ]),
              el('div', { class: 'tools-list' }, items),
            ]);
          });
        };

        const providerCard = (params: {
          kind: ActiveRunnerKind;
          title: string;
          subtitle: string;
          connected: boolean;
          active: boolean;
          accent: string;
          models: AgentModelOpt[];
          tools: AgentTool[];
          modelsStatus?: AuthStatusSnapshot['codexModelsStatus'];
          toolsStatus?: AuthStatusSnapshot['codexToolsStatus'];
        }): HTMLElement => {
          const modelsLoading = params.modelsStatus === 'loading' && params.models.length === 0;
          const toolsLoading = params.toolsStatus === 'loading' && params.tools.length === 0;
          const dotColor = params.connected ? params.accent : 'var(--ink-4, var(--ink-3))';

          // Default-model select for THIS agent — populated from its own catalog
          // (agents-status), saved to chatModelByRunner[kind]. A pinned id the
          // agent no longer offers is kept visible, flagged "· unavailable".
          const select = el('select', {
            class: 'agent-model-select',
            'aria-label': `Default model for ${params.title}`,
          }) as HTMLSelectElement;
          const saved = agentModelByRunner[params.kind] ?? '';
          select.append(el('option', { value: '' }, 'Gateway default') as HTMLOptionElement);
          if (saved && !params.models.some((m) => m.id === saved)) {
            select.append(
              el('option', { value: saved }, `${saved} · unavailable`) as HTMLOptionElement,
            );
          }
          const mkOpt = (m: AgentModelOpt): HTMLOptionElement =>
            el(
              'option',
              { value: m.id },
              (m.name ?? m.id) + (m.default ? ' · default' : ''),
            ) as HTMLOptionElement;
          if (params.models.some((m) => m.tier)) {
            for (const tier of MODEL_TIER_ORDER) {
              const inTier = params.models.filter((m) => m.tier === tier);
              if (inTier.length) {
                select.append(el('optgroup', { label: MODEL_TIER_LABEL[tier] }, inTier.map(mkOpt)));
              }
            }
            const untiered = params.models.filter((m) => !m.tier);
            if (untiered.length) {
              select.append(el('optgroup', { label: 'Other' }, untiered.map(mkOpt)));
            }
          } else {
            for (const m of params.models) select.append(mkOpt(m));
          }
          // Still discovering the runner's catalog (the seed is gone). Show a
          // disabled hint option; Gateway default above stays selectable.
          if (modelsLoading) {
            select.append(
              el(
                'option',
                { value: '__loading', disabled: '' },
                'Discovering models…',
              ) as HTMLOptionElement,
            );
          }
          select.value = saved;
          if (!params.connected) select.setAttribute('disabled', '');
          select.addEventListener('change', () => {
            const v = select.value;
            const nextMap = { ...agentModelByRunner };
            if (v) nextMap[params.kind] = v;
            else delete nextMap[params.kind];
            agentModelByRunner = nextMap;
            // Patch just this runner's entry; '' clears it (back to Gateway default).
            void window.CentraidApi.saveSettings({ chatModelByRunner: { [params.kind]: v } });
          });

          // Tools disclosure — a quiet "N tools" affordance that expands a
          // grouped list under the row. Open state persists across re-renders.
          const isOpen = toolsOpen.has(params.kind);
          const toolCount = params.tools.length;
          const toggle = el('button', {
            class: 'agent-tools-toggle',
            type: 'button',
            'aria-expanded': isOpen ? 'true' : 'false',
            title: 'Show tools this agent exposes (builtins + MCP)',
          }) as HTMLButtonElement;
          toggle.innerHTML =
            Icon.Code({ size: 12 }) +
            `<span class="agent-tools-count">${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}</span>` +
            `<span class="agent-tools-chev">${Icon.ChevronDown({ size: 12 })}</span>`;

          const groups = renderToolGroups(params.tools);
          const panel = el('div', { class: 'agent-tools', hidden: isOpen ? null : 'true' }, [
            groups.length
              ? el('div', { class: 'tools-groups' }, groups)
              : el(
                  'div',
                  { class: 'agent-tools-empty' },
                  toolsLoading
                    ? 'Scanning tools…'
                    : toolCount === 0
                      ? 'No tools scanned yet — use Refresh tools below.'
                      : 'No tools to show.',
                ),
          ]) as HTMLElement;

          const row = el(
            'div',
            {
              class: 'agent-row',
              'data-active': params.active ? 'true' : '',
              'data-unavail': params.connected ? '' : 'true',
            },
            [
              el('span', { class: 'agent-row-dot', style: { background: dotColor } }),
              el('div', { class: 'agent-row-meta' }, [
                el('div', { class: 'agent-row-name' }, [
                  params.title,
                  params.active ? el('span', { class: 'agent-row-active' }, 'Active') : false,
                ]),
                el('span', { class: 'agent-row-sub' }, params.subtitle),
              ]),
              el('div', { class: 'agent-row-tools' }, [toggle]),
              el('div', { class: 'agent-row-model' }, [select]),
            ],
          );

          const entry = el(
            'div',
            { class: 'agent-entry', 'data-tools-open': isOpen ? 'true' : '' },
            [row, panel],
          );
          entry.style.setProperty('--row-accent', params.accent);

          toggle.addEventListener('click', () => {
            const next = !toolsOpen.has(params.kind);
            if (next) toolsOpen.add(params.kind);
            else toolsOpen.delete(params.kind);
            toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
            if (next) panel.removeAttribute('hidden');
            else panel.setAttribute('hidden', 'true');
            entry.dataset.toolsOpen = next ? 'true' : '';
          });

          return entry;
        };

        const cards = RUNNERS.map((runner) => {
          const available = runner.available(status);
          const isActive = runner.kind === selectedRunnerKind;
          const ver = runner.version(status);
          const subtitle = available
            ? (ver ?? `${runner.bin} · detected`)
            : `${runner.bin} CLI not found on PATH`;
          const models = (runner.kind === 'codex' ? status.codexModels : status.claudeModels) ?? [];
          const tools = (runner.kind === 'codex' ? status.codexTools : status.claudeTools) ?? [];
          const modelsStatus =
            runner.kind === 'codex' ? status.codexModelsStatus : status.claudeModelsStatus;
          const toolsStatus =
            runner.kind === 'codex' ? status.codexToolsStatus : status.claudeToolsStatus;
          return providerCard({
            kind: runner.kind,
            title: runner.title,
            subtitle,
            connected: available,
            active: isActive,
            accent: runner.accent,
            models,
            tools,
            modelsStatus,
            toolsStatus,
          });
        });
        agentCardsHost.replaceChildren(...cards);
      };

      // Poll the agents snapshot while any surface is still being enumerated, so
      // a Refresh (or a cold boot) fills the picker in / swaps in the fresh list
      // without the user re-clicking. Bounded by `agentsPollDeadline`.
      let agentsPollTimer: ReturnType<typeof setTimeout> | undefined;
      let agentsPollDeadline = 0;
      const anyAgentSurfaceLoading = (s: AuthStatusSnapshot | null): boolean =>
        !!s &&
        [s.codexModelsStatus, s.claudeModelsStatus, s.codexToolsStatus, s.claudeToolsStatus].some(
          (st) => st === 'loading',
        );
      const pollAgentsUntilSettled = (): void => {
        if (agentsPollTimer) {
          clearTimeout(agentsPollTimer);
          agentsPollTimer = undefined;
        }
        if (!anyAgentSurfaceLoading(lastStatus) || Date.now() >= agentsPollDeadline) return;
        agentsPollTimer = setTimeout(() => {
          void getAgentsStatus()
            .then((s) => {
              renderAuthStatus(s);
              pollAgentsUntilSettled();
            })
            .catch(() => {});
        }, 800);
      };

      // Two independent refreshes. Models (?refresh=1) is a zero-token CLI
      // self-report — fast. Tools (?refreshTools=1) re-probes each agent's tool
      // surface by spawning the CLI against a mock server, so it's slower and
      // kept on its own button. Both re-render the panel in place.
      const refreshModelsBtn = el('button', {
        class: 'btn btn-soft',
        type: 'button',
      }) as HTMLButtonElement;
      refreshModelsBtn.innerHTML = Icon.Reset({ size: 13 }) + '<span>Refresh models</span>';
      refreshModelsBtn.addEventListener('click', () => {
        void (async () => {
          refreshModelsBtn.setAttribute('disabled', '');
          try {
            // Fire-and-forget: the gateway kicks the warm and returns `loading`;
            // we render that (keeping any current list visible) and poll it in.
            agentsPollDeadline = Date.now() + 30_000;
            renderAuthStatus(await getAgentsStatus({ refresh: true }));
            pollAgentsUntilSettled();
          } catch (err) {
            showToast(`Refresh failed: ${String(err)}`);
            renderAuthStatus({
              codexAvailable: false,
              claudeAvailable: false,
            });
          } finally {
            refreshModelsBtn.removeAttribute('disabled');
          }
        })();
      });

      const refreshToolsBtn = el('button', {
        class: 'btn btn-soft',
        type: 'button',
      }) as HTMLButtonElement;
      refreshToolsBtn.innerHTML = Icon.Refresh({ size: 13 }) + '<span>Refresh tools</span>';
      refreshToolsBtn.addEventListener('click', () => {
        void (async () => {
          refreshToolsBtn.setAttribute('disabled', '');
          refreshToolsBtn.innerHTML = Icon.Refresh({ size: 13 }) + '<span>Scanning tools…</span>';
          try {
            // Keep the current snapshot visible (don't blank the panel) — tools can
            // take a few seconds to probe; only the tool lists change. The gateway
            // returns `loading`; we poll the result in.
            agentsPollDeadline = Date.now() + 30_000;
            renderAuthStatus(await getAgentsStatus({ refreshTools: true }));
            pollAgentsUntilSettled();
          } catch (err) {
            showToast(`Tool refresh failed: ${String(err)}`);
          } finally {
            refreshToolsBtn.removeAttribute('disabled');
            refreshToolsBtn.innerHTML = Icon.Refresh({ size: 13 }) + '<span>Refresh tools</span>';
          }
        })();
      });

      pageHosts.providers.append(
        drawerGroup('Connected', [authStatusHost]),
        el('div', { class: 'sheet-actions' }, [refreshModelsBtn, refreshToolsBtn]),
      );

      // Initial load — read the active-runner pref, the agents snapshot (now
      // carrying each agent's models), and the persisted per-runner model map so
      // the first render shows the right "Active" badge and each agent's saved
      // default model.
      renderAuthStatus(null);
      void Promise.all([
        getAgentsStatus().catch(
          () => ({ codexAvailable: false, claudeAvailable: false }) as AuthStatusSnapshot,
        ),
        getUserPrefs()
          .then((p) => p['agent.runner.kind'])
          .catch(() => undefined),
        window.CentraidApi.getSettings()
          .then((s) => s.chatModelByRunner)
          .catch(() => undefined),
      ]).then(([status, kindRaw, modelMap]) => {
        selectedRunnerKind = kindRaw === 'claude-code' ? 'claude-code' : 'codex';
        agentModelByRunner = modelMap ?? {};
        agentsPollDeadline = Date.now() + 30_000;
        renderAuthStatus(status);
        pollAgentsUntilSettled();
      });
    }

    // Spaces (#280: profiles are vaults) — full manage surface. Each space
    // is a VAULT: its own apps, transcripts, and data, all inside the vault
    // directory. Switching re-roots the shell. The sidebar-head switcher
    // (⌘⇧G or click the active space) is the other entry point.
    pageHosts.profiles.append(
      drawerGroup('Spaces', [
        el(
          'div',
          { class: 'settings-note' },
          'Each space is a vault — its own apps, chats, and data, deny-by-default to every app until you grant access. Switch from here or from the switcher at the top of the sidebar (⌘⇧G).',
        ),
        window.Profiles.buildManageBody({
          profiles: vaultList.map((v) => toProfileView(v)),
          activeId: activeVaultId,
          onSwitch: (id) => void switchProfile(id),
          onEdit: (p) => openProfileModal('edit', p),
          onDelete: (p) => requestDeleteProfile(p),
          onAdd: () => openProfileModal('add'),
        }),
      ]),
    );

    // Connections — the gateway endpoints hosting vault registries (#280
    // demoted gateways to plumbing). Switching one swaps the whole world;
    // the primordial local connection can't be removed.
    const connectionRows = connectionList.map((g) => {
      const isActive = g.id === activeConnectionId;
      const row = el('div', { class: 'cd-prof-row', 'data-active': isActive ? 'true' : 'false' }, [
        el('div', { class: 'cd-prof-row-text' }, [
          el('div', { class: 'cd-prof-row-titlerow' }, [
            el('span', { class: 'cd-prof-row-name' }, g.displayName),
            ...(isActive ? [el('span', { class: 'cd-prof-row-badge' }, 'Connected')] : []),
          ]),
          el(
            'div',
            { class: 'cd-prof-row-sub' },
            g.kind === 'remote' ? (g.url ?? 'Remote gateway') : 'This computer',
          ),
        ]),
        el('div', { class: 'cd-prof-row-actions' }, [
          ...(isActive
            ? []
            : [
                el(
                  'button',
                  {
                    class: 'cd-chip cd-prof-row-switch',
                    type: 'button',
                    onClick: () => {
                      void window.CentraidApi.setActiveGateway({ id: g.id });
                    },
                  },
                  'Connect',
                ),
              ]),
          ...(g.id !== 'local'
            ? [
                el('button', {
                  class: 'cd-icon-btn cd-prof-row-del',
                  type: 'button',
                  title: 'Remove connection',
                  'aria-label': `Remove ${g.displayName}`,
                  trustedHtml: Icon.Trash({ size: 13 }),
                  onClick: () => {
                    void window.CentraidApi.removeGateway({ id: g.id });
                  },
                }),
              ]
            : []),
        ]),
      ]);
      return row;
    });
    pageHosts.profiles.append(
      drawerGroup('Connections', [
        el(
          'div',
          { class: 'settings-note' },
          'Gateways this desktop can talk to. Each connection hosts its own set of spaces.',
        ),
        el('div', { class: 'cd-prof-manage-list' }, connectionRows),
      ]),
    );

    // Phone (issue #263) — the "Connect phone" pairing QR + paired-device
    // allowlist over the iroh tunnel. Rendered on page SHOW like Vaults:
    // it fetches status each time, so revocations/pairings made elsewhere
    // (another window) show up on re-entry.
    const phoneHost = el('div', { class: 'cd-phone-page' });
    pageHosts.phone.append(drawerGroup('Phone', [phoneHost]));

    // Import (issue #290 phase 2) — populated on page show, like Phone.
    const importHost = el('div', { class: 'cd-import-page' });
    pageHosts.import.append(drawerGroup('Import', [importHost]));

    // §C1 — inner-sidebar shell modelled on RefinedSettingsV2. A grouped
    // category nav (Workspace / Models / Runtime) — each entry an icon +
    // label + optional mono hint — sits beside a scrolling content pane
    // that shows exactly one page (a PageHead + its controls) at a time.
    interface SettingsPageDef {
      id: SettingsPageId;
      label: string;
      section: string;
      icon: IconNameType;
      hint?: string;
      subtitle: string;
    }
    const settingsPages: ReadonlyArray<SettingsPageDef> = [
      {
        id: 'appearance',
        label: 'Appearance',
        section: 'Workspace',
        icon: 'Mood',
        subtitle: 'Visual treatment for Centraid chrome and the app tiles on your home screen.',
      },
      {
        id: 'layout',
        label: 'Layout',
        section: 'Workspace',
        icon: 'Code',
        subtitle: 'Density and surface treatment across every Centraid screen.',
      },
      {
        id: 'workspace',
        label: 'Workspace',
        section: 'Workspace',
        icon: 'Folder',
        subtitle: 'Sidebar and navigation.',
      },
      {
        id: 'profiles',
        label: 'Spaces',
        section: 'Account',
        icon: 'Users',
        subtitle:
          'Separate spaces — each one a vault with its own apps, chats, and data. Switch, add, rename, recolor, or remove spaces; manage the connections that host them.',
      },
      {
        id: 'phone',
        label: 'Phone',
        section: 'Account',
        icon: 'Phone',
        subtitle:
          'Use your published apps from your phone — anywhere, over an end-to-end encrypted tunnel. Pair with a one-time QR; revoke a device any time.',
      },
      {
        id: 'import',
        label: 'Import',
        section: 'Account',
        icon: 'Save',
        subtitle:
          'Bring your existing data into the vault — calendars, contacts, mail, bank statements, or a whole Google Takeout. Everything stages for review before it lands.',
      },
      {
        id: 'providers',
        label: 'Agents',
        section: 'Models',
        icon: 'Sparkle',
        subtitle:
          'The coding-agent CLIs the gateway can drive. Detection checks whether each CLI is runnable on the gateway’s host — Centraid is agnostic to how they authenticate.',
      },
    ];

    const innerNav = el('aside', { class: 'cd-settings-nav' });
    const contentArea = el('section', { class: 'cd-settings-content' });
    innerNav.append(
      el('div', { class: 'cd-settings-nav-head' }, [
        el('div', { class: 'cd-settings-nav-eyebrow' }, 'Settings'),
        el('div', { class: 'cd-settings-nav-title' }, 'Personal'),
      ]),
    );

    // §C4 — pages whose controls persist on change carry an "Auto-saved"
    // marker; the Agents page is read-only status with an explicit Refresh
    // button and so gets no marker.
    const autoSavePages = new Set<SettingsPageId>(['appearance', 'layout', 'workspace']);

    const navButtons = new Map<SettingsPageId, HTMLElement>();
    const showSettingsPage = (id: SettingsPageId): void => {
      setLastSettingsPage(id);
      const def = settingsPages.find((p) => p.id === id);
      for (const [pid, btn] of navButtons) {
        btn.dataset.active = String(pid === id);
      }
      const titleRow = el('div', { class: 'cd-settings-page-titlerow' }, [
        el('h1', { class: 'cd-settings-page-title' }, def ? def.label : 'Settings'),
        ...(autoSavePages.has(id)
          ? [
              el('span', {
                class: 'cd-settings-autosaved',
                trustedHtml: `${Icon.Check({ size: 10, strokeWidth: 2.5 })}<span>Auto-saved</span>`,
              }),
            ]
          : []),
      ]);
      const head = el('header', { class: 'cd-settings-page-head' }, [
        titleRow,
        ...(def ? [el('p', { class: 'cd-settings-page-sub' }, def.subtitle)] : []),
      ]);
      contentArea.replaceChildren(head, pageHosts[id]);
      contentArea.scrollTop = 0;
      // The Vaults page fetches on every show: its host must be CONNECTED
      // (renderVaultsPage no-ops on a detached one), and re-showing picks up
      // registry changes made elsewhere (another window, the gateway CLI).
      if (id === 'phone') void renderPhonePage({ el, host: phoneHost, showToast });
      // The Import page fetches on every show — a publish elsewhere (another
      // window) must not leave a stale draft here.
      if (id === 'import') void renderImportPage({ el, host: importHost, showToast });
    };
    let lastSection = '';
    for (const p of settingsPages) {
      if (p.section !== lastSection) {
        innerNav.append(el('div', { class: 'cd-settings-nav-section' }, p.section));
        lastSection = p.section;
      }
      const btnChildren: HTMLElement[] = [
        el('span', {
          class: 'cd-settings-nav-icon',
          trustedHtml: Icon[p.icon] ? Icon[p.icon]({ size: 14 }) : Icon.Folder({ size: 14 }),
        }),
        el('span', { class: 'cd-settings-nav-label' }, p.label),
      ];
      if (p.hint) btnChildren.push(el('span', { class: 'cd-settings-nav-hint' }, p.hint));
      const btn = el(
        'button',
        { class: 'cd-settings-nav-item', type: 'button', onClick: () => showSettingsPage(p.id) },
        btnChildren,
      );
      navButtons.set(p.id, btn);
      innerNav.append(btn);
    }
    innerNav.append(
      el('div', { class: 'cd-settings-nav-foot' }, [
        el('span', { class: 'cd-settings-nav-ver' }, 'v0.5.2'),
      ]),
    );

    const settingsShell = el('div', { class: 'cd-settings-shell' }, [innerNav, contentArea]);
    main.append(settingsShell);
    const startPage: SettingsPageId = settingsPages.some((p) => p.id === initialPage)
      ? (initialPage as SettingsPageId)
      : 'appearance';
    if (!isCurrentRender(seq)) return;
    showSettingsPage(startPage);

    const sidebar = buildHomeSidebar({ page: 'settings' });
    const { root: shell, setSidebarOpen } = window.Chrome.buildWindow({
      ...chromeNav(),
      main,
      onNewChat: () => ctx.shell.openNewAppSheet(),
      onToggleSidebar: toggleSidebar,
      showNewChat: true,
      sidebar,
      sidebarOpen: getPrefs().sidebarOpen,
    });
    setSidebarOpenSetter(setSidebarOpen);
    // Atomic swap — replaces the old view in one mutation, no blank frame.
    root.replaceChildren(shell);
  }

  // §C — RefinedSettingsV2 `Sec`: a titled section — a plain bold heading
  // above a body of rows that sits under a hairline rule.
  function drawerGroup(label: string, rows: HTMLElement[]): HTMLElement {
    return el('div', { class: 'drawer-group' }, [
      el('div', { class: 'drawer-group-label' }, label),
      el('div', { class: 'drawer-group-body' }, rows),
    ]);
  }
  // §C — RefinedSettingsV2 `Row`: a two-column grid — a label + hint
  // stack on the left, the control on the right. `full` stacks the
  // control below the label across the whole row width.
  function drawerRowH(
    label: string,
    hint: string,
    control: HTMLElement,
    full = false,
  ): HTMLElement {
    return el(
      'div',
      { class: full ? 'drawer-row drawer-row-full' : 'drawer-row drawer-row-grid' },
      [
        el('div', { class: 'drawer-row-head' }, [
          el('span', { class: 'drawer-row-label' }, label),
          el('span', { class: 'drawer-row-hint' }, hint),
        ]),
        el('div', { class: 'drawer-row-control' }, [control]),
      ],
    );
  }
  function makeSwitch(initial: boolean, onChange: (next: boolean) => void): HTMLElement {
    let on = initial;
    const btn = el('button', {
      'aria-checked': String(on),
      class: 'cd-switch',
      'data-on': String(on),
      role: 'switch',
      type: 'button',
    });
    btn.append(el('span', { class: 'cd-switch-thumb' }));
    btn.addEventListener('click', () => {
      on = !on;
      btn.dataset.on = String(on);
      btn.setAttribute('aria-checked', String(on));
      onChange(on);
    });
    return btn;
  }
  // §C — RefinedSettingsV2 accent picker: a labelled swatch card per
  // accent (a color bar + a name caption); the active card wears an ink
  // border. Names match the proposal copy (Electric / Violet / …).
  function makeSwatches(selected: AccentKey, onSelect: (value: AccentKey) => void): HTMLElement {
    const order: ReadonlyArray<{ key: AccentKey; name: string }> = [
      { key: 'teal', name: 'Teal' },
      { key: 'blue', name: 'Electric' },
      { key: 'violet', name: 'Violet' },
      { key: 'ochre', name: 'Ochre' },
      { key: 'rose', name: 'Rose' },
    ];
    const wrap = el('div', { class: 'cd-swatches', role: 'radiogroup', 'aria-label': 'Accent' });
    for (const { key, name } of order) {
      const swatch = ACCENT_PALETTE[key];
      const btn = el(
        'button',
        {
          'aria-checked': String(key === selected),
          'aria-label': name,
          class: 'cd-swatch',
          'data-active': String(key === selected),
          role: 'radio',
          type: 'button',
        },
        [
          el('span', { class: 'cd-swatch-chip', style: { background: swatch.accent } }),
          el('span', { class: 'cd-swatch-name' }, name),
        ],
      );
      btn.addEventListener('click', () => {
        for (const child of wrap.children) {
          (child as HTMLElement).dataset.active = 'false';
          child.setAttribute('aria-checked', 'false');
        }
        btn.dataset.active = 'true';
        btn.setAttribute('aria-checked', 'true');
        onSelect(key);
      });
      wrap.append(btn);
    }
    return wrap;
  }

  // VSCode-style theme picker. One card per THEME_PRESETS entry; each
  // card paints a 3-stripe preview (bg / sidebar / accent) sampled from
  // that theme's own tokens, so the user can see what they're picking
  // without applying it. The element exposes a `_refresh()` method on
  // itself so external setPrefs() calls (e.g. Match-system) can update
  // the active highlight without rebuilding the whole DOM.
  function makeThemePicker(
    getCurrent: () => ThemeName,
    onSelect: (value: ThemeName) => void,
  ): HTMLElement {
    const wrap = el('div', {
      class: 'cd-theme-picker',
      role: 'radiogroup',
      'aria-label': 'Color theme',
    });
    const cardByName = new Map<ThemeName, HTMLElement>();

    for (const preset of window.CentraidTokens.themePresets) {
      const theme = window.CentraidTokens.themes[preset.name];
      // Surfaces under `hsl(... var(--bg-l))` aren't resolvable outside
      // the theme's own document scope — fall back to a literal swatch
      // so the preview still paints when bgL is referenced (Centraid Dark).
      const previewBg = theme.bgL ? `hsl(222 11% ${theme.bgL.replace('%', '')}%)` : theme.bg;
      const previewElev = theme.bgL
        ? `hsl(222 11% calc(${theme.bgL.replace('%', '')}% + 4.5%))`
        : theme.bgElev;
      const card = el(
        'button',
        {
          class: 'cd-theme-card',
          'data-name': preset.name,
          'data-active': String(preset.name === getCurrent()),
          'aria-checked': String(preset.name === getCurrent()),
          'aria-label': preset.label,
          role: 'radio',
          type: 'button',
        },
        [
          el('div', { class: 'cd-theme-card-preview', style: { background: previewBg } }, [
            el('span', {
              class: 'cd-theme-card-bar',
              style: { background: previewElev },
            }),
            el('span', {
              class: 'cd-theme-card-dot',
              style: { background: theme.accent },
            }),
          ]),
          el('div', { class: 'cd-theme-card-foot' }, [
            el('span', { class: 'cd-theme-card-label' }, preset.label),
            el('span', { class: 'cd-theme-card-kind' }, preset.kind),
          ]),
        ],
      );
      card.addEventListener('click', () => onSelect(preset.name));
      cardByName.set(preset.name, card);
      wrap.append(card);
    }

    const refresh = (): void => {
      const current = getCurrent();
      for (const [name, card] of cardByName) {
        const active = name === current;
        card.dataset.active = String(active);
        card.setAttribute('aria-checked', String(active));
      }
    };
    (wrap as HTMLElement & { _refresh?: () => void })._refresh = refresh;
    return wrap;
  }

  function makeSegmented<T extends string>(
    options: readonly T[],
    selected: T,
    onSelect: (value: T) => void,
  ): HTMLElement {
    const wrap = el('div', { class: 'seg', role: 'tablist' });
    for (const opt of options) {
      const btn = el(
        'button',
        {
          'data-active': String(opt === selected),
          onClick: () => {
            for (const child of wrap.children) {
              (child as HTMLElement).dataset.active = 'false';
            }
            btn.dataset.active = 'true';
            onSelect(opt);
          },
          role: 'tab',
        },
        opt,
      );
      wrap.append(btn);
    }
    return wrap;
  }

  // ---------- Share dialog ----------
  // Centered modal with a read-only share link + access radios. Link is a
  // local fake (centraid.app/s/...) — wire to real share URLs once the
  // gateway exposes a share endpoint.
  function openShareDialog(app: AppMetaResolvedType): void {
    const slug = app.name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    const link = `centraid.app/s/${app.id}-${slug}`;
    let access: 'private' | 'link' | 'public' = 'link';
    // ^ also declared as `Access` below; the union keeps both call sites narrow.

    const backdrop = el('div', { class: 'modal-backdrop' });
    const card = el('div', {
      class: 'share-card',
      role: 'dialog',
      'aria-label': `Share ${app.name}`,
    });
    const close = (): void => {
      backdrop.remove();
      card.remove();
    };
    backdrop.addEventListener('click', close);

    const closeBtn = el('button', {
      'aria-label': 'Close',
      class: 'btn-icon',
      trustedHtml: Icon.X({ size: 16 }),
      onClick: close,
    });

    card.append(
      el('div', { class: 'flex between' }, [
        el('div', {}, [
          el('h3', {}, `Share ${app.name}`),
          el('p', { class: 'share-sub' }, 'Anyone with the link can open a read-only copy.'),
        ]),
        closeBtn,
      ]),
    );

    const linkInput = el('input', {
      class: 'share-link-input',
      readonly: '',
      value: link,
    }) as HTMLInputElement;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const copyBtn = el(
      'button',
      {
        class: 'btn btn-primary',
        onClick: () => {
          void navigator.clipboard
            .writeText(link)
            .then(() => {
              copyBtn.textContent = 'Copied';
              if (copyTimer) clearTimeout(copyTimer);
              copyTimer = setTimeout(() => {
                copyBtn.textContent = 'Copy';
              }, 1400);
            })
            .catch(() => showToast('Could not copy to clipboard'));
        },
        style: { minWidth: '80px' },
      },
      'Copy',
    );
    card.append(el('div', { class: 'share-link-row' }, [linkInput, copyBtn]));

    type Access = 'private' | 'link' | 'public';
    const options: { id: Access; label: string; hint: string }[] = [
      { hint: 'App is private. No one else can open it.', id: 'private', label: 'Only me' },
      {
        hint: 'Read-only. They can fork it into their own Centraid.',
        id: 'link',
        label: 'Anyone with the link',
      },
      { hint: 'Listed in Centraid Discover.', id: 'public', label: 'Public' },
    ];
    const accessWrap = el('div', { class: 'share-access' });
    const rows: HTMLElement[] = [];
    for (const o of options) {
      const radio = el('input', {
        type: 'radio',
        name: 'share-access',
        checked: o.id === access ? '' : null,
      }) as HTMLInputElement;
      const row = el(
        'label',
        {
          class: 'share-access-row',
          'data-active': String(o.id === access),
          onClick: () => {
            access = o.id;
            for (const r of rows) r.dataset.active = 'false';
            row.dataset.active = 'true';
            radio.checked = true;
          },
        },
        [
          radio,
          el('span', {}, [
            el('div', { class: 'label' }, o.label),
            el('div', { class: 'hint' }, o.hint),
          ]),
        ],
      );
      rows.push(row);
      accessWrap.append(row);
    }
    card.append(accessWrap);

    const doneBtn = el('button', { class: 'btn btn-soft', onClick: close }, 'Done');
    card.append(el('div', { class: 'share-actions' }, [doneBtn]));

    document.body.append(backdrop);
    document.body.append(card);
    setTimeout(() => linkInput.select(), 30);
  }

  return { renderSettings, openShareDialog };
}
