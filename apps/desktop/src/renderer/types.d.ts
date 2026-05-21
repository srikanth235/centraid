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
    /** Light theme — kept as alias of `themes.light` for legacy call sites. */
    colors: Theme;
    /** Both themes; flip via `<html data-theme="light|dark">`. */
    themes: Record<ThemeName, Theme>;
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
     * Centraid project id (folder name under <projectsDir>) when reopening an
     * already-generated user app. Absent for fresh `initialPrompt` flows —
     * the builder generates an id and scaffolds a project itself.
     */
    projectId?: string;
    /**
     * Called after a successful publish of a fresh build. Receives the centraid
     * project id (used to look up the app on subsequent opens) plus the
     * suggested name/icon/color so the home screen can render a tile.
     */
    onAddToHome?: (input: {
      prompt?: string;
      projectId: string;
      name?: string;
      versionId?: string;
    }) => void;
    /**
     * Called when the user inline-edits the project title or description
     * in the builder topbar. The home screen uses this to update its
     * in-memory userApps entry (and its persisted localStorage copy) so
     * the tile reflects the new metadata without waiting for a re-publish.
     * Either `name` or `description` (or both) will be present.
     */
    onMetaChange?: (input: { projectId: string; name?: string; description?: string }) => void;
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
     * Sidebar drafts list — the user's other in-progress projects on disk
     * that the shell already knows about. Builder renders these under a
     * "Drafts" section so the user can switch between WIP apps without
     * exiting to home. Defaults to `[]` when omitted (older callers).
     */
    drafts?: ChromeSidebarApp[];
  }

  interface UserAppMeta extends AppMetaResolved {
    /** Centraid project id (uploaded-mode app on the gateway). */
    centraidProjectId?: string;
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
   * A project that exists on disk under `<projectsDir>/<id>/` but has not
   * been published or pinned to home yet. Rendered with a "DRAFT" badge —
   * clicking the tile opens the builder in update mode.
   */
  interface DraftAppMeta extends AppMetaResolved {
    /** True for drafts. The home grid's tile/menu logic keys off this. */
    __draft: true;
    /** Whether the project has an `index.html` (preview-ready). */
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
    /** Right-edge chrome cluster — project identity, Publish, brand chip, etc. */
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
    openBuilder: (opts: BuilderOptions) => () => void;
    AppChat: { mount: (opts: AppChatMountOptions) => () => void };
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
}
