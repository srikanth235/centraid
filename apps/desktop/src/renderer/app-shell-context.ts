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
  // `page` deep-links into one Settings sub-page (e.g. `'storage'` from the
  // Gateway page's Storage card — issue #367 §D3); omitted, SettingsRoute
  // falls back to its own default (Appearance). Loosely typed as `string`
  // here (not SettingsRoute's own page union) to avoid a type-only import
  // cycle between this shared-types module and a screen route module —
  // SettingsRoute.tsx validates it against its known page ids itself.
  | { kind: 'settings'; page?: string }
  | { kind: 'assistant' }
  | { kind: 'insights' }
  | { kind: 'discover' }
  | { kind: 'starred' }
  | { kind: 'automations' }
  | { kind: 'approvals' }
  | { kind: 'gateway' }
  | { kind: 'templates' }
  // Instructions-first create/edit form (Automations UI revamp). `automationId`
  // (a `ref`) is omitted for create mode; `templateId` seeds the form from a
  // template gallery entry (Discover/Templates "Use template" for an
  // automation). Reached inside normal chrome, NOT full-bleed — unlike the
  // builder chat it replaces as the primary edit surface.
  | { kind: 'automation-editor'; automationId?: string; templateId?: string }
  | { automationId: string; kind: 'automation-view' }
  | { automationId: string; kind: 'run-view'; runId: string }
  | { id: string; kind: 'app' }
  | { appContext?: AppMetaResolvedType; initialPrompt?: string; kind: 'builder' }
  // `seedMessage`, when set, is the editor's "compile" handoff — a first
  // message posted into the builder chat on open (mirrors `builder`'s
  // `initialPrompt`). Optional because most automation-builder entries
  // (overview "New automation", thread's "Edit") open the chat cold.
  | { automationId: string; kind: 'automation-builder'; seedMessage?: string };

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
  triggerKind?: 'cron' | 'webhook' | 'data' | 'condition';
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
