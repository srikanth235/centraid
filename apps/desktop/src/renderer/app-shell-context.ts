// Shared contract between the app.ts shell and the route modules split out of
// it (app-insights, app-discover, app-automations, app-palette, app-cards,
// app-settings, …). app.ts owns the mutable shell state and the DOM/render
// primitives; each route module is a factory `createXModule(ctx)` that closes
// over this context and returns its render entry points.
//
// Two pieces:
//   • ShellContext — the live handle a module gets: render primitives, state
//     accessors (getters/setters, never captured-by-value so reassignments in
//     app.ts stay visible), and `shell`, the late-bound entry registry.
//   • ShellEntries — the registry of cross-module render entry points. app.ts
//     creates it empty, every factory populates its own slots, and modules call
//     siblings through `ctx.shell.renderSettings()` etc. This breaks the
//     otherwise-circular import graph (insights ↔ home ↔ settings ↔ palette).

// ── Appearance prefs (renderer-local; mirrored to the gateway) ──────────────
export type ThemeName = keyof typeof window.CentraidTokens.themes;
export type Density = 'compact' | 'regular' | 'comfy';
export type TileVariant = 'solid' | 'gradient' | 'glassy' | 'flat';
export type AccentKey = 'blue' | 'violet' | 'teal' | 'ochre' | 'rose';
export type CardVariant = 'flat' | 'outlined' | 'elevated';

// Accent key → resolved hex swatches (Centraid Redesign Tweaks panel). Shared
// between the appearance core in app.ts and the settings page in app-settings.
export const ACCENT_PALETTE: Record<AccentKey, { accent: string; light: string; deep: string }> = {
  blue: { accent: '#4950F6', light: '#6B72FF', deep: '#2D34D9' },
  ochre: { accent: '#B47B3F', light: '#CB9359', deep: '#92622F' },
  rose: { accent: '#E55772', light: '#EE7D92', deep: '#BF3E57' },
  teal: { accent: '#2EA098', light: '#4CBBB1', deep: '#218079' },
  violet: { accent: '#7C5BD9', light: '#9D80E6', deep: '#5D3EB3' },
};

// A gateway profile as returned by the listGateways IPC.
export type GatewayProfile = Awaited<ReturnType<typeof window.CentraidApi.listGateways>>[number];

export interface AppearancePrefs {
  theme: ThemeName;
  density: Density;
  tileVariant: TileVariant;
  sidebarOpen: boolean;
  /** Dark ramp lightness anchor (10–35). Drives `--bg-l`. */
  bgL: number;
  /** Hue 222 + 11% sat when true, neutral grey (hue 0, 0% sat) when false. */
  coolBlueCast: boolean;
  accent: AccentKey;
  cardVariant: CardVariant;
}

// A shell route — the navigable surfaces of the home shell (apps and the
// builder route the user into other views). Drives the nav stack + `applyRoute`
// dispatcher in app.ts and the per-route refresh in the route modules.
export type ShellRoute =
  | { kind: 'home' }
  | { kind: 'settings' }
  | { kind: 'insights' }
  | { kind: 'discover' }
  | { kind: 'starred' }
  | { kind: 'automations' }
  | { kind: 'templates' }
  | { automationId: string; kind: 'automation-view' }
  | { automationId: string; kind: 'run-view'; runId: string }
  | { id: string; kind: 'app' }
  | { appContext?: AppMetaResolvedType; initialPrompt?: string; kind: 'builder' }
  | { automationId: string; kind: 'automation-builder' };

// Compact summary of the active gateway, fed into the sidebar head row.
export interface GatewaySummary {
  activeId: string;
  activeKind: 'local' | 'remote';
  activeLabel: string;
  activeDisplayName: string;
  activeAvatarColor: string;
}

// Renderer-side mirror of @centraid/blueprints' `TemplateMeta`. We don't
// import the package here — the IPC layer carries plain JSON. `kind` splits
// the catalog into the home Templates shelf (kind: 'app') and the Automations
// gallery (kind: 'automation'); the unified clone path handles both. Shared
// across app.ts (cards/templates), app-automations.ts, and app-discover.ts.
export interface TemplateEntry {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: 'app' | 'automation';
  // automation-only display fields:
  emoji?: string;
  category?: string;
  triggerKind?: 'cron' | 'webhook';
  triggerLabel?: string;
  integrations?: readonly string[];
}

// Per-automation run state, keyed by `${appId}:${name}`.
export type AutomationRunState =
  | { kind: 'running' }
  | { kind: 'done'; ok: boolean; durationMs: number; error?: string; finishedAt: number };

// ── Late-bound render registry ──────────────────────────────────────────────
// Populated by app.ts (for routes still living there) and by each module
// factory as it's extracted. Always fully populated before boot.
export interface ShellEntries {
  renderHome(): void;
  renderInsights(): void;
  renderDiscover(): void;
  renderStarred(): void;
  renderAutomations(): void;
  renderAutomationView(automationId: string): void;
  renderRunView(automationId: string, runId: string): void;
  renderAutomationTemplates(): void;
  renderSettings(initialPage?: string): void;
  openApp(id: string): void;
  openNewAppSheet(): void;
  openShareDialog(app: AppMetaResolvedType): void;
  openTemplatePreview(tmpl: TemplateEntry): void;
  openTemplateContextMenu(tmpl: TemplateEntry, anchor: MenuAnchor): void;
  openAutomationTemplatePreview(tmpl: TemplateEntry): void;
  openCommandPalette(): void;
  openContextMenu(app: AppMetaResolvedType, anchor: MenuAnchor): void;
  enterBuilder(opts: { appContext?: AppMetaResolvedType; initialPrompt?: string }): void;
  enterAutomationBuilder(input: { automationId: string }): void;
  createAndOpenAutomationBuilder(): Promise<void>;
}

// ── The context handed to every route module ────────────────────────────────
export interface ShellContext {
  readonly root: HTMLElement;

  // DOM + render primitives (owned by app.ts)
  el: ElHelper;
  clear(): void;
  /** Run the current page's cleanup without blanking `root` (avoids flicker). */
  teardownCurrent(): void;
  showToast(message: string): void;
  registerCleanup(fn: () => void): void;
  mountShellPage(page: SidebarPage, main: HTMLElement, seq?: number): void;
  pageScroll(title: string, subtitle: string): { main: HTMLElement; scroll: HTMLElement };
  /** A centered empty-state block with a single message line. */
  renderSimpleEmpty(message: string): HTMLElement;

  // Navigation
  recordRoute(route: ShellRoute): void;
  applyRoute(route: ShellRoute): void;
  /** Back/forward chrome wiring for the window header (canGoBack/onBack/…). */
  chromeNav(): Pick<ChromeBuildWindowOpts, 'canGoBack' | 'canGoForward' | 'onBack' | 'onForward'>;

  // Modal primitive — resolves true on confirm, false on cancel/backdrop/Esc.
  openConfirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }): Promise<boolean>;

  // Appearance core (owned by app.ts) — the app view re-applies/iframes theme.
  iframeThemeKind(): 'light' | 'dark';
  applyPrefs(): void;

  // Card actions (live in app-cards.ts) the app-settings menu reuses.
  revealApp(app: AppMetaResolvedType): Promise<void>;
  handleDeleteApp(app: AppMetaResolvedType): Promise<void>;

  // Shared state — accessors, never captured by value (app.ts reassigns these)
  getPrefs(): AppearancePrefs;
  setPrefs(patch: Partial<AppearancePrefs>): void;
  getApps(): AppMetaResolvedType[];
  getAppsWithDrafts(): AppMetaResolvedType[];
  findApp(id: string): AppMetaResolvedType | undefined;
  findUserApp(id: string): UserAppMeta | undefined;
  /** The live home userApps array (mutate in place via push, or replace via setUserApps). */
  getUserApps(): UserAppMeta[];
  setUserApps(next: UserAppMeta[]): void;
  /** Write the userApps store to disk (Store). */
  persist(): void;
  /** Refresh the drafts cache from disk (reads each app.json). */
  hydrateDrafts(): Promise<void>;
  getDrafts(): DraftAppMeta[];
  isDraft(app: AppMetaResolvedType): app is DraftAppMeta;
  recentApps(): AppMetaResolvedType[];
  /** App slice of the template catalog (non-automation). */
  loadAvailableTemplates(): Promise<TemplateEntry[]>;
  /** Automation slice of the template catalog. */
  loadAutomationTemplates(): Promise<TemplateEntry[]>;
  /** A row of integration dots for a template/automation card. */
  integrationDots(names: readonly string[]): HTMLElement;
  getRuntimeMode(): 'local' | 'remote' | undefined;
  getGateway(): GatewaySummary | undefined;
  /** Current render generation. Capture AFTER `clear()`, re-check with `isCurrentRender`. */
  getRenderSeq(): number;
  isCurrentRender(seq: number): boolean;

  // Stars + recents
  isStarred(id: string): boolean;
  toggleStar(id: string): void;
  recordRecent(id: string): void;

  // Cross-cluster render lifecycle handle (automations + template/openApp)
  getCurrentCleanup(): (() => void) | null;
  setCurrentCleanup(fn: (() => void) | null): void;

  // Shared in-place container (automations + automations-in-settings)
  automationRunState: Map<string, AutomationRunState>;

  // Settings-only cross refs
  getLastSettingsPage(): string | undefined;
  setLastSettingsPage(page: string | undefined): void;
  setOnAppearanceApplied(fn: (() => void) | null): void;
  setSidebarOpenSetter(fn: ((open: boolean) => void) | null): void;
  /** Drive the live sidebar open/closed setter if one is registered. */
  applySidebarOpen(open: boolean): void;

  // Profiles + sidebar (shell-owned; the settings page drives them)
  toggleSidebar(): void;
  buildHomeSidebar(active?: { page?: SidebarPage; appId?: string }): HTMLElement;
  toProfileView(p: GatewayProfile, activeId: string): ProfileView;
  switchProfile(id: string): Promise<void>;
  openProfileModal(mode: 'add' | 'edit', profile?: ProfileView): void;
  requestDeleteProfile(profile: ProfileView): void;

  // Late-bound entry points other modules invoke
  shell: ShellEntries;
}
