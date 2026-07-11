// Shared renderer types — appearance prefs, the accent palette, the route
// union, and the template/app metadata the React shell (react/shell/*) renders
// against. Once the seam between the vanilla app.ts shell and its route modules;
// after the full-React flip (#325) app.ts is gone and this is just the types +
// the ACCENT_PALETTE the appearance code shares.

// ── Appearance prefs (renderer-local; mirrored to the gateway) ──────────────
export type ThemeName = keyof typeof window.CentraidTokens.themes;
export type Density = 'compact' | 'regular' | 'comfy';
export type TileVariant = 'solid' | 'gradient' | 'glassy' | 'flat';
export type AccentKey = 'blue' | 'violet' | 'teal' | 'ochre' | 'rose';
export type CardVariant = 'flat' | 'outlined' | 'elevated';

// Accent key → resolved hex swatches (Centraid Redesign Tweaks panel). Shared
// between the appearance core in app.ts and the settings page in app-settings.
// `teal` is the brand accent — its ramp matches @centraid/design-tokens'
// ACCENT / ACCENT_LIGHT / ACCENT_DEEP (and the `--brand` logo hue), so the
// default swatch and the token default paint identically.
export const ACCENT_PALETTE: Record<AccentKey, { accent: string; light: string; deep: string }> = {
  blue: { accent: '#4950F6', light: '#6B72FF', deep: '#2D34D9' },
  ochre: { accent: '#B47B3F', light: '#CB9359', deep: '#92622F' },
  rose: { accent: '#E55772', light: '#EE7D92', deep: '#BF3E57' },
  teal: { accent: '#3EC8B4', light: '#62D6C6', deep: '#2AA593' },
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
  | { kind: 'assistant' }
  | { kind: 'insights' }
  | { kind: 'discover' }
  | { kind: 'starred' }
  | { kind: 'automations' }
  | { kind: 'approvals' }
  | { kind: 'gateway' }
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
// ── The context handed to every route module ────────────────────────────────
