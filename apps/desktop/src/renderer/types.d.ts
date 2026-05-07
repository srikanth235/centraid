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
} from '@centraid/design-tokens';

// Make this file a module so `declare global` augments globals.

declare global {
  interface IconOptions {
    size?: number;
    strokeWidth?: number;
  }
  type IconRenderer = (opts?: IconOptions) => string;

  interface CentraidTokensBridge {
    colors: Record<string, string | Palette>;
    palette: Palette;
    icons: Record<IconName, readonly { d: string; fill?: 'currentColor' }[]>;
    apps: AppMetaResolved[];
    spacing: Record<string, number>;
    radii: Record<string, number>;
    fonts: Record<string, string>;
    type: Record<string, { size: number; lineHeight: number; family: string; weight: string }>;
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

  interface CentraidAppDef {
    mount: (root: HTMLElement, ctx?: { app: AppMetaResolved; el: ElHelper }) => (() => void) | void;
  }

  interface CentraidRoot {
    el: ElHelper;
    openApp: (id: string) => void;
    renderHome: () => void;
    openBuilder: () => void;
  }

  interface BuilderOptions {
    root: HTMLElement;
    el: ElHelper;
    onExit: () => void;
    initialPrompt?: string;
    appContext?: AppMetaResolved;
    onAddToHome?: (input: { prompt?: string }) => void;
  }

  interface Window {
    CentraidTokens: CentraidTokensBridge;
    Icon: Record<IconName, IconRenderer>;
    ICON_PALETTE: Palette;
    Store: CentraidStore;
    DateUtil: CentraidDateUtil;
    CentraidApps: Record<string, CentraidAppDef>;
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
  var CentraidApps: Record<string, CentraidAppDef>;
  var Centraid: CentraidRoot;
}
