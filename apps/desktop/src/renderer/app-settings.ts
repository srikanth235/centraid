// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// Global Settings page (Appearance / Layout / Workspace / Agents / Profiles)
// and the app Share dialog. Extracted from app.ts. The page builds its own
// chrome window (window.Chrome) with a sidebar from ctx.buildHomeSidebar, and
// drives shell-owned state (prefs, profiles, the live sidebar setter) through
// the ShellContext accessors.
import { getAgentsStatus, getUserPrefs, listVaults, saveUserPrefs } from './gateway-client.js';
import { renderPhonePage } from './app-phone.js';
import { renderImportPage } from './app-import.js';
import { requireReactBridge } from './react/bridge.js';
import type { AccentKey, ShellContext, ThemeName } from './app-shell-context.js';
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

    // The Appearance + Layout pages render via the React screens, mounted into
    // their page hosts (like the Phone/Import panes). Each control calls
    // setPrefs, which re-themes the running app. The inner-sidebar nav + chrome
    // window stay vanilla (built below).
    const settingsBridge = requireReactBridge();
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
    const providersBridge = requireReactBridge();
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
        const toolsStatus = r.kind === 'codex' ? status.codexToolsStatus : status.claudeToolsStatus;
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

    // Spaces (#280: profiles are vaults) — full manage surface. Each space
    // is a VAULT: its own apps, transcripts, and data, all inside the vault
    // directory. Switching re-roots the shell. The sidebar-head switcher
    // (⌘⇧G or click the active space) is the other entry point.
    // Phase 3 (#325): render via the ported React screen when the bundle is
    // loaded (modals + gateway I/O stay vanilla in the callbacks); else vanilla.
    const profilesBridge = requireReactBridge();
    const pvs = vaultList.map((v) => toProfileView(v));
    const pvById = new Map(pvs.map((p) => [p.id, p]));
    registerCleanup(
      profilesBridge.mountSettingsProfiles(pageHosts.profiles, {
        connections: connectionList.map((g) => ({
          active: g.id === activeConnectionId,
          displayName: g.displayName,
          id: g.id,
          removable: g.id !== 'local',
          sub: g.kind === 'remote' ? (g.url ?? 'Remote gateway') : 'This computer',
        })),
        onAdd: () => openProfileModal('add'),
        onConnect: (id) => void window.CentraidApi.setActiveGateway({ id }),
        onDelete: (id) => {
          const p = pvById.get(id);
          if (p) requestDeleteProfile(p);
        },
        onEdit: (id) => {
          const p = pvById.get(id);
          if (p) openProfileModal('edit', p);
        },
        onRemoveConnection: (id) => void window.CentraidApi.removeGateway({ id }),
        onSwitch: (id) => void switchProfile(id),
        profiles: pvs.map((p) => {
          const lead = p.blurb.trim() || (p.kind === 'remote' ? 'Remote' : 'Local');
          const subLine =
            typeof p.appsCount === 'number'
              ? `${lead} · ${p.appsCount} app${p.appsCount === 1 ? '' : 's'}`
              : lead;
          return {
            active: p.id === activeVaultId,
            color: p.color,
            icon: p.icon,
            id: p.id,
            name: p.name,
            primordial: !!p.primordial,
            subLine,
          };
        }),
      }),
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
