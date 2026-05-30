// Global window type declarations for the renderer.
// All renderer .ts files are IIFE-style scripts (no imports/exports) and
// communicate via window.* properties — these declarations let tsc
// type-check those interactions.

import type {
  Palette,
  IconName,
  AppMetaResolved,
  ColorHex,
  ColorKey,
  Theme,
  ThemeName,
  ThemePreset,
  TileVariant,
  TileFinish,
} from '@centraid/design-tokens';

// Make this file a module so `declare global` augments globals.

declare global {
  interface IconOptions {
    size?: number;
    strokeWidth?: number;
  }
  type IconRenderer = (opts?: IconOptions) => string;

  interface CentraidTokensBridge {
    /** Generated CSS — `:root` + theme + density blocks. Injected at boot. */
    cssText: string;
    /** Every registered theme; flip via `<html data-theme="<name>">`. */
    themes: Record<ThemeName, Theme>;
    /** Ordered presets the Settings → Appearance picker renders. */
    themePresets: ReadonlyArray<ThemePreset>;
    palette: Palette;
    icons: Record<IconName, readonly { d: string; fill?: 'currentColor' }[]>;
    apps: AppMetaResolved[];
    spacing: Record<string, number>;
    radii: Record<string, number>;
    fonts: Record<string, string>;
    type: Record<string, { size: number; lineHeight: number; family: string; weight: string }>;
    /**
     * Computes a tile's visual treatment for a given hue + variant.
     * Pure; safe to call on every tile render.
     */
    tileFinish: (color: string, variant: TileVariant) => TileFinish;
  }

  interface CentraidStore {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
  }

  interface CentraidDateUtil {
    todayKey(): string;
    daysAgoKey(n: number): string;
    dayOfWeek(): number;
    formatDate(d: string, opts?: Intl.DateTimeFormatOptions): string;
    formatShort(d: string): string;
  }

  type ElAttrValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | EventListenerOrEventListenerObject
    | Partial<CSSStyleDeclaration>;
  type ElAttrs = Record<string, ElAttrValue> & {
    style?: Partial<CSSStyleDeclaration>;
    trustedHtml?: string;
  };
  type ElChild = Node | string | null | false | undefined;
  type ElHelper = (tag: string, attrs?: ElAttrs, children?: ElChild | ElChild[]) => HTMLElement;

  interface CentraidRoot {
    el: ElHelper;
    openApp: (id: string) => void;
    renderHome: () => void;
    openBuilder: () => void;
    openShare: (app: AppMetaResolved) => void;
    openSettings: () => void | Promise<void>;
    /**
     * Opens the per-app actions menu from outside `app.ts` (e.g. the
     * builder's sidebar rows). Resolves the id against the home shell's
     * known apps/drafts, so the verb set is identical to what users see
     * on the home grid.
     */
    openAppContext: (id: string, anchor: MenuAnchor) => void;
    /** Navigate to the Insights (usage analytics) page. */
    openInsights: () => void;
    /** Navigate to the Discover (templates) page. */
    openDiscover: () => void;
    /** Navigate to the Starred apps page. */
    openStarred: () => void;
    /** Navigate to the Automations page. */
    openAutomations: () => void;
    /** Open the ⌘K command palette. */
    openSearch: () => void;
    /**
     * Current runtime mode ('local' or 'remote'), or undefined before the
     * first settings fetch resolves.
     */
    getRuntimeMode: () => 'local' | 'remote' | undefined;
  }

  interface BuilderOptions {
    root: HTMLElement;
    el: ElHelper;
    onExit: () => void;
    initialPrompt?: string;
    appContext?: AppMetaResolved;
    /**
     * Centraid app id (folder name under <appsDir>) when reopening an
     * already-generated user app. Absent for fresh `initialPrompt` flows —
     * the builder generates an id and scaffolds an app itself.
     */
    appId?: string;
    /**
     * App kind. `'app'` (default) is the standard chat-driven app
     * builder; `'automation'` swaps the right pane for a read-only
     * automation config view + test-run pane. Automation mode always
     * receives a pre-scaffolded draft via `appId`.
     */
    appKind?: 'app' | 'automation';
    /**
     * Called after a successful publish of a fresh build. Receives the centraid
     * app id (used to look up the app on subsequent opens) plus the
     * suggested name/icon/color so the home screen can render a tile.
     */
    onAddToHome?: (input: {
      prompt?: string;
      appId: string;
      name?: string;
      versionId?: string;
    }) => void;
    /**
     * Called when the user inline-edits the app title or description
     * in the builder topbar. The home screen uses this to update its
     * in-memory userApps entry (and its persisted localStorage copy) so
     * the tile reflects the new metadata without waiting for a re-publish.
     * Either `name` or `description` (or both) will be present.
     */
    onMetaChange?: (input: { appId: string; name?: string; description?: string }) => void;
    canGoBack?: boolean;
    canGoForward?: boolean;
    onBack?: () => void;
    onForward?: () => void;
    /**
     * When true, focus the inline title and select its text on mount so the
     * user is dropped straight into renaming. Used by the template-clone
     * flow (Notion-style: duplicate inherits the template name but lands
     * in rename mode immediately).
     */
    focusName?: boolean;
    /**
     * Sidebar drafts list — the user's other in-progress apps on disk
     * that the shell already knows about. Builder renders these under a
     * "Drafts" section so the user can switch between WIP apps without
     * exiting to home. Defaults to `[]` when omitted (older callers).
     */
    drafts?: ChromeSidebarApp[];
  }

  interface UserAppMeta extends AppMetaResolved {
    /** Centraid app id (uploaded-mode app on the gateway). */
    centraidAppId?: string;
    /**
     * Last-modified timestamp (ISO 8601). Stamped when the app is created,
     * republished, or its name/description edited inline from the builder.
     * Renders as "Edited X ago" in the home tile.
     */
    updatedAt?: string;
    /**
     * Creation timestamp (ISO 8601). Stamped once when the app first lands
     * on home and never rewritten — so the §A3 "NEW" badge reflects true
     * app age rather than last-edit recency. Backfilled from `updatedAt`
     * for apps that predate this field.
     */
    createdAt?: string;
  }

  /**
   * An app that exists on disk under `<appsDir>/<id>/` but has not
   * been published or pinned to home yet. Rendered with a "DRAFT" badge —
   * clicking the tile opens the builder in update mode.
   */
  interface DraftAppMeta extends AppMetaResolved {
    /** True for drafts. The home grid's tile/menu logic keys off this. */
    __draft: true;
    /** Whether the app has an `index.html` (preview-ready). */
    hasIndex: boolean;
  }

  interface ChromeSidebarApp {
    id: string;
    name: string;
    iconKey: IconName;
    color: string;
    status?: 'new' | 'draft' | 'live' | null;
  }

  /**
   * Where the home/sidebar context menu should anchor. `point` is a raw
   * cursor location (right-click); `rect` is a trigger element's bounding
   * box (the hover-revealed `•••` button) so the menu drops below it with
   * predictable edge-flipping. Shared across `app.ts` and `chrome.ts` so
   * the sidebar can hand the right-click event off to the home shell.
   */
  type MenuAnchor = { kind: 'point'; x: number; y: number } | { kind: 'rect'; rect: DOMRect };

  interface ChromeBuildWindowOpts {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    sidebar: HTMLElement;
    main: HTMLElement;
    /** Right-edge chrome cluster — app identity, Publish, brand chip, etc. */
    titlebarRight?: HTMLElement | null;
    /** Center chrome cluster — mode tabs, device pill, etc. Sits between
     *  the back/forward nav and the trailing flex spacer. */
    titlebarCenter?: HTMLElement | null;
    /** Lead chrome element — placed in `.cd-tl-nav` right after the
     *  forward button, hugging the back/forward arrows. Builder identity. */
    titlebarLead?: HTMLElement | null;
    showNewChat?: boolean;
    onNewChat?: () => void;
    canGoBack?: boolean;
    canGoForward?: boolean;
    onBack?: () => void;
    onForward?: () => void;
    /** When true, a chat-pane toggle is rendered at the trailing edge of
     *  `.cd-tl-nav` (the chat-pane/canvas boundary). Builder-only today. */
    showChatToggle?: boolean;
    chatPaneOpen?: boolean;
    onToggleChat?: () => void;
  }

  type SidebarPage = 'home' | 'insights' | 'discover' | 'starred' | 'automations' | 'settings';

  interface ChromeBuildSidebarOpts {
    /** App id of the app/builder currently in focus — highlights its row. */
    activeId?: string;
    /** Which top-level page is current — drives the active highlight. */
    activePage?: SidebarPage;
    apps: ChromeSidebarApp[];
    drafts: ChromeSidebarApp[];
    /**
     * Arbitrary element rendered at the very top of the sidebar, above
     * "Build new", followed by a hairline divider. Used to mount the
     * profile switcher head row. Omit to skip the head slot (test
     * harnesses).
     */
    headSlot?: HTMLElement;
    onHome: () => void;
    onNewApp: () => void;
    /** New-chat action wired to the Chats section `+`. Falls back to
     *  `onNewApp` when there is no dedicated chat-creation entry point. */
    onNewChat?: () => void;
    onSearch?: () => void;
    onInsights?: () => void;
    onDiscover?: () => void;
    onStarred?: () => void;
    onAutomations?: () => void;
    onAppClick: (id: string) => void;
    onSettings: () => void;
    /**
     * Opens the per-app actions menu (Rename · Reveal in Finder · Delete
     * etc.) from a sidebar row. Wired to the same handler the home grid
     * uses so both surfaces stay in lockstep. Omit to skip the `•••`
     * affordance entirely (e.g. test harnesses).
     */
    onAppContext?: (id: string, anchor: MenuAnchor) => void;
  }

  /**
   * Renderer-facing profile record fed into the profile switcher's
   * presentation layer (`window.Profiles`). A profile IS a gateway:
   * `name`/`color`/`kind` come from the gateway backend (displayName /
   * avatarColor / kind), while `icon`/`blurb` are Centraid-owned
   * metadata persisted client-side via `window.Store`. `appsCount` is
   * known only for the active profile (others omit it).
   */
  interface ProfileView {
    id: string;
    name: string;
    /** `#RRGGBB` avatar color (maps to gateway `avatarColor`). */
    color: string;
    icon: IconName;
    blurb: string;
    kind: 'local' | 'remote';
    /** True for the primordial `'local'` gateway — cannot be deleted. */
    primordial: boolean;
    /** App count, when known (active profile only). */
    appsCount?: number;
  }

  /**
   * Profile switcher presentation API (apps/desktop/src/renderer/profiles.ts).
   * Owns the avatar, sidebar-head switcher, dropdown, add/edit modal,
   * delete dialog, toast, and the Settings manage body. All data + IPC
   * wiring stays in app.ts, which feeds `ProfileView` records in and
   * receives plain callbacks out.
   */
  interface ProfilesApi {
    readonly PROFILE_COLORS: readonly string[];
    readonly PROFILE_ICONS: readonly IconName[];
    readonly DEFAULT_ICON: IconName;
    /** Read the client-side icon/description metadata for a profile id. */
    metaFor: (id: string) => { icon: IconName; blurb: string };
    /** Persist icon/description metadata for a profile id. */
    saveMeta: (id: string, patch: { icon?: IconName; blurb?: string }) => void;
    /** Drop stored metadata for a removed profile. */
    forgetMeta: (id: string) => void;
    avatar: (profile: { icon: IconName; color: string }, size?: number) => HTMLElement;
    buildSwitcherHeader: (opts: {
      active: ProfileView;
      open?: boolean;
      onToggle: (anchor: DOMRect) => void;
    }) => HTMLElement;
    openDropdown: (opts: {
      anchor: DOMRect;
      profiles: ProfileView[];
      activeId: string;
      onSwitch: (id: string) => void;
      onEdit: (p: ProfileView) => void;
      onAdd: () => void;
      onManage: () => void;
    }) => { close: () => void };
    openModal: (opts: {
      mode: 'add' | 'edit';
      initial: { name?: string; icon?: IconName; color?: string; blurb?: string };
      onCommit: (data: { name: string; icon: IconName; color: string; blurb: string }) => void;
      onCancel: () => void;
      onDelete?: (() => void) | null;
    }) => { close: () => void };
    openDeleteDialog: (opts: {
      profile: ProfileView;
      onConfirm: () => void;
      onCancel: () => void;
    }) => { close: () => void };
    toast: (opts: { msg: string; kind?: 'ok' | 'del' }) => void;
    buildManageBody: (opts: {
      profiles: ProfileView[];
      activeId: string;
      onSwitch: (id: string) => void;
      onEdit: (p: ProfileView) => void;
      onDelete: (p: ProfileView) => void;
      onAdd: () => void;
    }) => HTMLElement;
  }

  interface ChromeApi {
    buildWindow: (opts: ChromeBuildWindowOpts) => {
      root: HTMLElement;
      setSidebarOpen: (open: boolean) => void;
      setChatPaneOpen: (open: boolean) => void;
    };
    buildSidebar: (opts: ChromeBuildSidebarOpts) => HTMLElement;
    tbBtn: (opts: {
      icon: string;
      title?: string;
      shortcut?: string;
      onClick?: () => void;
      disabled?: boolean;
      ariaLabel?: string;
    }) => HTMLElement;
    glyphs: Record<string, (size?: number) => string>;
  }

  interface AppChatMountOptions {
    view: HTMLElement;
    app: AppMetaResolved;
    appId: string;
    el: ElHelper;
  }

  interface Window {
    CentraidTokens: CentraidTokensBridge;
    Icon: Record<IconName, IconRenderer>;
    ICON_PALETTE: Palette;
    Store: CentraidStore;
    DateUtil: CentraidDateUtil;
    Centraid: CentraidRoot;
    Chrome: ChromeApi;
    Profiles: ProfilesApi;
    openBuilder: (opts: BuilderOptions) => () => void;
    AppChat: { mount: (opts: AppChatMountOptions) => () => void };
    /**
     * First-run onboarding. Mounted by app.ts when settings.onboardingCompletedAt
     * is absent. The host owns the root element and a completion callback that
     * fires after the user's profile is saved.
     */
    Onboarding: {
      mount: (opts: {
        root: HTMLElement;
        /** Resolves with the chosen displayName + avatarColor once the user submits. */
        onComplete: (input: { displayName: string; avatarColor: string }) => Promise<void> | void;
      }) => () => void;
    };
  }

  // Convenience type aliases reachable inside renderer scripts.
  type IconNameType = IconName;
  type AppMetaResolvedType = AppMetaResolved;
  type ColorHexType = ColorHex;
  type ColorKeyType = ColorKey;

  // Convenience values — set by store.ts / icons.ts on the window.
  // Declared as `var` so renderer scripts can reference them unprefixed.
  var Icon: Record<IconName, IconRenderer>;
  var ICON_PALETTE: Palette;
  var Store: CentraidStore;
  var DateUtil: CentraidDateUtil;
  var Centraid: CentraidRoot;
  var Profiles: ProfilesApi;
}
