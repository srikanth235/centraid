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

  /**
   * Where the home/sidebar context menu should anchor. `point` is a raw
   * cursor location (right-click); `rect` is a trigger element's bounding
   * box (the hover-revealed `•••` button) so the menu drops below it with
   * predictable edge-flipping. Shared across `app.ts` and `chrome.ts` so
   * the sidebar can hand the right-click event off to the home shell.
   */
  type MenuAnchor = { kind: 'point'; x: number; y: number } | { kind: 'rect'; rect: DOMRect };

  type SidebarPage =
    | 'home'
    | 'assistant'
    | 'insights'
    | 'discover'
    | 'starred'
    | 'automations'
    | 'settings';

  interface Window {
    CentraidTokens: CentraidTokensBridge;
    Icon: Record<IconName, IconRenderer>;
    ICON_PALETTE: Palette;
    Store: CentraidStore;
    DateUtil: CentraidDateUtil;
    Centraid: CentraidRoot;
  }

  // Convenience type aliases reachable inside renderer scripts.
  type IconNameType = IconName;
  type AppMetaResolvedType = AppMetaResolved;
  type ColorHexType = ColorHex;
  type ColorKeyType = ColorKey;

  // Convenience values — set by store.ts / icons.ts on the window. Declared
  // as `var` so renderer scripts can reference them unprefixed.
  var Icon: Record<IconName, IconRenderer>;
  var ICON_PALETTE: Palette;
  var Store: CentraidStore;
  var DateUtil: CentraidDateUtil;
  var Centraid: CentraidRoot;
}
