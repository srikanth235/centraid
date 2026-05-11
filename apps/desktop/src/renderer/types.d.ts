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
    openSettings: () => void | Promise<void>;
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
  }

  interface UserAppMeta extends AppMetaResolved {
    /** Centraid project id (uploaded-mode app on the gateway). */
    centraidProjectId?: string;
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

  interface Window {
    CentraidTokens: CentraidTokensBridge;
    Icon: Record<IconName, IconRenderer>;
    ICON_PALETTE: Palette;
    Store: CentraidStore;
    DateUtil: CentraidDateUtil;
    Centraid: CentraidRoot;
    openBuilder: (opts: BuilderOptions) => () => void;
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
