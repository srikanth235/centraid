// Shared renderer types — appearance prefs, the route union, and the
// template/app metadata the React shell (react/shell/*) renders against. Once
// the seam between the vanilla app.ts shell and its route modules; after the
// full-React flip (#325) app.ts is gone and this is just the types.

// ── Appearance prefs (renderer-local; mirrored to the gateway) ──────────────
export type ThemeName = keyof typeof window.CentraidTokens.themes;
/** What the owner asked for. `system` tracks the OS appearance live. */
export type ThemeMode = ThemeName | "system";
export type TileVariant = "solid" | "gradient" | "glassy" | "flat";
export type CardVariant = "flat" | "outlined" | "elevated";

// A gateway profile as returned by the listGateways IPC.
export type GatewayProfile = Awaited<
  ReturnType<typeof window.CentraidApi.listGateways>
>[number];

/**
 * The renderer's appearance prefs.
 *
 * The Binding Layer retired both per-owner colour overrides (#707): the shell
 * spends no hue, so there is no accent to pick, and the dark ramp is a set of
 * literal surface tones rather than one `--bg-l` lightness anchor to slide.
 * `sidebarOpen` went with them: the stem never scrolls away and never changes
 * width, so there is no open state to remember. What is left is what an owner
 * can still meaningfully choose — light/dark, card treatment, tile finish.
 */
export interface AppearancePrefs {
  /** The owner's pick. `system` re-resolves on OS appearance changes. */
  themeMode: ThemeMode;
  /** The resolved theme actually applied — `themeMode` unless it is `system`. */
  theme: ThemeName;
  tileVariant: TileVariant;
  cardVariant: CardVariant;
}

// A shell route — the navigable surfaces of the home shell (apps and the
// builder route the user into other views). Drives the nav stack + `applyRoute`
// dispatcher in app.ts and the per-route refresh in the route modules.
export type ShellRoute =
  | { kind: "home" }
  // `page` deep-links into one Settings sub-page (e.g. `'storage'` from the
  // Gateway page's Storage card — issue #367 §D3); omitted, SettingsRoute
  // falls back to its own default (Appearance). Loosely typed as `string`
  // here (not SettingsRoute's own page union) to avoid a type-only import
  // cycle between this shared-types module and a screen route module —
  // SettingsRoute.tsx validates it against its known page ids itself.
  | { kind: "settings"; page?: string }
  // `conversationId` omitted = a fresh, not-yet-created conversation (the
  // composer creates one lazily on first send); set = the assistant surface's
  // own conversation ledger or a resumed session. See AssistantRoute.tsx.
  | { kind: "assistant"; conversationId?: string }
  | { kind: "insights" }
  | { kind: "starred" }
  | { kind: "automations" }
  // Vault data-source connections (Gmail, GitHub, …) — a launcher
  // destination; previously Settings → Account → Connections.
  | { kind: "connectors" }
  | { kind: "approvals" }
  | {
      kind: "gateway";
      tab?: "overview" | "components" | "storage" | "logs" | "alerts";
      focus?: "backups" | "capacity";
      cause?: "backup-alert";
    }
  // The people side of this installation (issue #599, Decision 14): the member
  // roster, the devices acting for each person, and every vault this member can
  // reach. A launcher destination beside Gateway — which it took People &
  // devices from, leaving Gateway purely about runtime health.
  | { kind: "household" }
  // Local disk footprint by component, the owner's disk budget, and the
  // offsite snapshot custody that used to be the whole page (issue #544 —
  // this was `backups`). A launcher destination beside Gateway; Settings →
  // Storage provider owns the connection itself.
  | { kind: "storage" }
  // Ontology-at-a-glance — the Kinds/Relations/Browse census over the vault
  // schema (issue #441 Part B). A launcher destination.
  | { kind: "atlas" }
  | { kind: "templates" }
  // Instructions-first create/edit form (Automations UI revamp). `automationId`
  // (a `ref`) is omitted for create mode; `templateId` seeds the form from a
  // template gallery entry (the automation gallery's "Use template" for an
  // automation). `watchEntity` (a logical entity KIND, `schema.table`) seeds a
  // create-mode data trigger watching that kind — the per-app "Automate this
  // data" deep-link (issue #446 follow-up 1). Like `templateId`, it only shapes
  // the initial DTO and is excluded from `routeKey`, so it never persists past
  // the first paint. Reached inside normal chrome, NOT full-bleed — unlike the
  // builder chat it replaces as the primary edit surface.
  | {
      kind: "automation-editor";
      automationId?: string;
      templateId?: string;
      watchEntity?: string;
    }
  | { automationId: string; kind: "automation-view" }
  | { automationId: string; kind: "run-view"; runId: string }
  | { id: string; kind: "app" }
  | {
      appContext?: AppMetaResolvedType;
      initialPrompt?: string;
      kind: "builder";
    }
  // `seedMessage`, when set, is the editor's "compile" handoff — a first
  // message posted into the builder chat on open (mirrors `builder`'s
  // `initialPrompt`). Optional because most automation-builder entries
  // (overview "New automation", thread's "Edit") open the chat cold.
  | { automationId: string; kind: "automation-builder"; seedMessage?: string };

// Compact summary of the active gateway, fed into the vault identity control.
export interface GatewaySummary {
  activeId: string;
  activeKind: "local" | "remote";
  activeLabel: string;
  activeDisplayName: string;
  activeAvatarColor: string;
}

// Renderer-side mirror of @centraid/blueprints' `TemplateMeta`. We don't
// import the package here — the IPC layer carries plain JSON. `kind` splits
// the catalog into the home Templates shelf (kind: 'app') and the Automations
// gallery (kind: 'automation'); the unified clone path handles both. The 'app'
// half is read-only since #708 — it names which ids are BUNDLED, and every
// bundled app is already installed.
export interface TemplateEntry {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: "app" | "automation";
  /** Whether this app-kind template is already installed in the addressed
   *  vault (issue #434). Always true for a mounted vault since #708 installs
   *  every bundled app at mount; kept because it is the gateway's own answer
   *  and an unmounted audience vault can still say `false`. */
  installed?: boolean;
  /** Requested vault access as the gateway declares it (issue #434). Read by
   *  the Privacy grants ledger; the install/consent sheet that used to render
   *  it retired with Discover (#708), since nothing asks to install any more. */
  vault?: TemplateVaultBlock;
  // automation-only display fields:
  emoji?: string;
  category?: string;
  triggerKind?: "cron" | "webhook" | "data" | "condition";
  triggerLabel?: string;
  integrations?: readonly string[];
}

/** A template's requested vault access (issue #434) — what the app declares it
 *  will touch. Mirrors the gateway's `TemplateVaultDTO`. */
export interface TemplateVaultBlock {
  purpose?: string;
  why?: string;
  scopes: Array<{
    schema: string;
    table?: string;
    verbs: string;
    rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
    fieldMask?: string[];
  }>;
}

// Per-automation run state, keyed by `${appId}:${name}`.
export type AutomationRunState =
  | { kind: "running" }
  | {
      kind: "done";
      ok: boolean;
      durationMs: number;
      error?: string;
      finishedAt: number;
    };

// ── Late-bound render registry ──────────────────────────────────────────────
// Populated by app.ts (for routes still living there) and by each module
// factory as it's extracted. Always fully populated before boot.
// ── The context handed to every route module ────────────────────────────────
