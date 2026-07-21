// governance: allow-repo-hygiene file-size-limit (#363) single source of truth for every renderer screen's prop-type contract (issue #325); splitting would scatter one cohesive DTO surface across files that all need to change together
// Screen prop-type contracts (issue #325).
//
// The DTOs below are the typed props each React screen renders against — the
// shape of the data a route derives (in react/shell/routes/*Data.ts) and hands
// its screen. They began life as the vanilla↔React handoff seam (a
// `window.CentraidReact` bridge between two module graphs); after the full-React
// flip that runtime bridge is gone and these are just the screens' contracts,
// kept as explicit DTOs so a route's derivation and its screen agree field for
// field. The `*BridgeProps` names are retained only to avoid churning ~50
// import sites.

import type { TileVariant } from '@centraid/design-tokens';

// The bridge is intentionally self-contained — it must not import the vanilla
// shell modules, whose ambient globals aren't in the React island's tsconfig.
// `DiscoverTemplate` mirrors `TemplateEntry` (app-shell-context.ts) field for
// field so the vanilla side's `TemplateEntry` values pass through unchanged.
export interface DiscoverTemplate {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: 'app' | 'automation';
  /** App-kind template already installed in the addressed vault (issue #434) —
   *  the card shows Open instead of Install. */
  installed?: boolean;
  /** Requested vault access, for the install/consent sheet (issue #434). */
  vault?: {
    purpose?: string;
    why?: string;
    scopes: Array<{ schema: string; table?: string; verbs: string }>;
  };
  emoji?: string;
  category?: string;
  triggerKind?: 'cron' | 'webhook' | 'data' | 'condition';
  triggerLabel?: string;
  integrations?: readonly string[];
}

/** Right-click anchor passed back to the shell's template context menu. */
export interface DiscoverMenuAnchor {
  kind: 'point';
  x: number;
  y: number;
}

/** Everything the React Discover screen needs from the vanilla shell. */
export interface DiscoverBridgeProps {
  appTemplates: readonly DiscoverTemplate[];
  automationTemplates: readonly DiscoverTemplate[];
  tileVariant: TileVariant;
  onOpenTemplate: (t: DiscoverTemplate) => void;
  onOpenAutomationTemplate: (t: DiscoverTemplate) => void;
  onTemplateContext: (t: DiscoverTemplate, anchor: DiscoverMenuAnchor) => void;
}

// ── Insights ────────────────────────────────────────────────────────────────
// DTOs mirror CentraidInsightsSummary & friends (centraid-api.d.ts) field for
// field, so the vanilla side's fetched summary passes through unchanged without
// the island tsconfig needing the ambient global types.
export interface InsightsKpis {
  totalTokens: number;
  totalCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  appsTouched: number;
  quotaTokens: number;
  /** Finished runs left unpriced by a then-unknown model (#445). */
  unpricedRuns: number;
}
export interface InsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}
export interface InsightsAutomationRow {
  key: string;
  label: string;
  kind: string;
  runs: number;
  tokens: number;
  costUsd: number;
}
export interface InsightsModelRow {
  model: string;
  runs: number;
  tokens: number;
  costUsd: number;
}
export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  costUsd: number;
}
export interface InsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  byAutomation: InsightsAutomationRow[];
  byModel: InsightsModelRow[];
  recent: InsightsActivityRow[];
}
export interface InsightsBridgeProps {
  summary: InsightsSummary;
}

// ── Vault pane ────────────────────────────────────────────────────────────
// DTOs mirror the gateway-client-vault.ts types so the React island stays
// decoupled from the vanilla client module (and its ambient globals).
export interface VaultScopeDTO {
  schema: string;
  table?: string | null;
  verbs: string;
}
export interface VaultGrantDTO {
  grantId: string;
  purposeConceptId: string;
  purpose: string | null;
  expiresAt: string | null;
  scopes: VaultScopeDTO[];
}
export interface VaultParkedDTO {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: 'app' | 'agent' | 'assistant' | 'owner-device';
  caller: string | null;
  input: Record<string, unknown>;
}
export interface VaultDemoDTO {
  appId: string;
  rows: number;
  seedable: boolean;
}
export interface VaultBlockDTO {
  purpose: string;
  why: string;
  scopes: VaultScopeDTO[];
}
/** Loaded snapshot; `null` from `loadData` = no vault plane is mounted. */
export interface VaultData {
  vaultName: string;
  grants: VaultGrantDTO[];
  parked: VaultParkedDTO[];
  demo?: VaultDemoDTO;
}
export interface VaultBridgeProps {
  block: VaultBlockDTO;
  /** Re-fetch the consent surface (gateway I/O lives on the vanilla side). */
  loadData: () => Promise<VaultData | null>;
  grant: () => Promise<void>;
  revoke: (grantId: string) => Promise<void>;
  confirm: (invocationId: string, approve: boolean) => Promise<void>;
  demoLoad: () => Promise<void>;
  demoPurge: () => Promise<void>;
  showToast?: (message: string) => void;
  onAccessChanged?: () => void;
  onParkedCount?: (count: number) => void;
}

// ── Automation templates gallery ────────────────────────────────────────────
export interface AutomationTemplatesBridgeProps {
  templates: readonly DiscoverTemplate[];
  /** Subtitle under the self-painted "Templates" header (issue: automations UX pass). */
  subtitle?: string;
  /** Open the vanilla preview drawer (kept vanilla — a body-level modal). */
  onPreview: (t: DiscoverTemplate) => void;
  /** "Start from scratch" → the conversational automation builder. */
  onStartFromScratch: () => void;
}

// ── Command palette (⌘K) ────────────────────────────────────────────────────
// The vanilla side owns the data + actions: it computes the grouped rows for a
// query (`buildGroups`) with pre-rendered icon SVG + resolved tile paint and a
// `run` closure per row. React owns the overlay chrome, the search field, and
// keyboard navigation.
export interface PaletteTileDTO {
  background: string;
  glyphColor: string;
  boxShadow?: string;
}
export interface PaletteRowDTO {
  label: string;
  sub?: string;
  /** Pre-rendered icon SVG markup (from the vanilla `Icon` set). */
  iconHtml: string;
  variant: 'action' | 'app' | 'chat';
  /** For `variant: 'app'` — the gradient tile paint. */
  tile?: PaletteTileDTO;
  meta?: string;
  kbd?: string;
  accent?: boolean;
  run: () => void;
}
export interface PaletteGroupDTO {
  group: string;
  items: PaletteRowDTO[];
}
export interface PaletteBridgeProps {
  /** Recompute the grouped results for the current query. */
  buildGroups: (query: string) => PaletteGroupDTO[];
  onClose: () => void;
  /**
   * Handed a `refresh` fn on mount — the vanilla side calls it when
   * async data (templates) arrives so `buildGroups` re-runs.
   */
  onReady?: (refresh: () => void) => void;
}

// ── Phone settings pane ─────────────────────────────────────────────────────
export interface PhoneDeviceDTO {
  deviceId: string;
  name: string;
  platform: string;
  endpointId: string;
  addedAt: string;
}
export interface PhoneStatusDTO {
  running: boolean;
  error?: string;
  devices: PhoneDeviceDTO[];
}
export interface PhonePairingDTO {
  qrDataUrl: string;
  expiresAt: number;
}
export interface PhoneBridgeProps {
  /** Read the tunnel status + paired devices. `null` = could not read. */
  loadStatus: () => Promise<PhoneStatusDTO | null>;
  /**
   * Begin pairing; `onPaired` fires with the device name when a phone
   * completes. Resolves to pairing info + a `cancel` fn, or `null` on failure.
   */
  beginPairing: (
    onPaired: (deviceName: string) => void,
  ) => Promise<{ info: PhonePairingDTO; cancel: () => void } | null>;
  revoke: (deviceId: string) => Promise<boolean>;
  showToast?: (message: string) => void;
}

// ── Import pane ─────────────────────────────────────────────────────────────
export interface ImportBatchDTO {
  batchId: string;
  status: 'draft' | 'published' | 'discarded';
  createdAt: string;
  summary: Record<string, number>;
  kind: string | null;
  label: string | null;
}
export interface ImportConnectionDTO {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: 'active' | 'needs-auth' | 'failing' | 'paused';
  lastRunAt: string | null;
  lastRunError: string | null;
}
export interface ImportRowDTO {
  entityType: string;
  externalId: string;
  disposition: 'create' | 'update' | 'skip' | 'merge-candidate';
  note: string | null;
}
export interface ImportData {
  vaultName: string;
  batches: ImportBatchDTO[];
  connections: ImportConnectionDTO[];
}
export interface ImportStagePayload {
  filename: string;
  text?: string;
  base64?: string;
}
export interface ImportBridgeProps {
  /** Read the import surface. `null` = no vault plane mounted. */
  loadData: () => Promise<ImportData | null>;
  /** Stage a dropped file; resolves to the staged row count. */
  stage: (payload: ImportStagePayload) => Promise<number>;
  /** Load a bounded row preview for a draft batch. */
  loadRows: (batchId: string) => Promise<ImportRowDTO[]>;
  publish: (batchId: string) => Promise<void>;
  discard: (batchId: string) => Promise<void>;
  setConnectionStatus: (connectionId: string, status: 'active' | 'paused') => Promise<void>;
  showToast?: (message: string) => void;
}

// ── Automations overview ────────────────────────────────────────────────────
// The vanilla side derives every display value (hue, glyph, trigger + status
// labels, formatted run meta) so the React screen needs no app-format /
// automation-identity imports.
export type AuStatusKind = 'active' | 'paused' | 'draft' | 'running' | 'success' | 'failed';
export interface AuOverviewRowDTO {
  ref: string;
  id: string;
  name: string;
  hue: string;
  glyphIcon: string;
  triggerIcon: string;
  triggerLabel: string;
  integrations: string[];
  lastRunLabel: string;
  statusKind: AuStatusKind;
  statusLabel: string;
  /** Whether the automation's most recent run succeeded — `null` when it has
   *  never run (the "fleet" row's last-run status dot, additive field for
   *  the Automations UI revamp — see receipts/issue-387-automations-ui-revamp.md). */
  lastRunOk: boolean | null;
  /** Relative label for the next cron fire ("in 2h"), `null` when the
   *  automation has no cron trigger. */
  nextRunLabel: string | null;
  /** Count of this automation's pending parked invocations + staged outbox
   *  items (the fleet row's amber attention badge) — see
   *  `filterConsentForAutomation` (automationThreadData.ts) for the
   *  actor-matching rule the caller uses to compute this. */
  attentionCount: number;
}
export interface AuOverviewRunDTO {
  runId: string;
  automationId: string;
  ok: boolean;
  name: string;
  summary: string;
  whenLabel: string;
  metaLabel: string;
  /** Raw fire time (ms epoch) — the "Recent activity" list's date-group
   *  separators are derived from this client-side. */
  startedAt: number;
}
export interface AuOverviewData {
  rows: AuOverviewRowDTO[];
  runs: AuOverviewRunDTO[];
  health: { active: number; paused: number; drafts: number; attention: number };
  subtitle: string;
}
export interface AutomationsOverviewBridgeProps {
  loadData: () => Promise<AuOverviewData>;
  onOpenAutomation: (ref: string) => void;
  onOpenRun: (automationId: string, runId: string) => void;
  onBrowseTemplates: () => void;
  onNewAutomation: () => void;
}

// ── Automation trigger hero details (thread header + editor) ───────────────
/** A `data` trigger's hero detail — the entities it watches, and an optional
 *  polling cadence. */
export interface AuViewDataDetailDTO {
  entities: string[];
  everyLabel: string | null;
}
/** A `condition` trigger's hero detail — the entity it watches plus the
 *  actual `where` clause, pre-rendered readably (pretty-printed JSON for a
 *  structured value, plain text otherwise) so a user can see WHAT it checks
 *  without opening raw JSON. */
export interface AuViewConditionDetailDTO {
  entity: string;
  whereText: string;
  everyLabel: string | null;
}
// ── Automations UI revamp: consent DTOs (shared by editor + thread) ────────
// Automations redesign (owner-approved architecture, see
// receipts/issue-387-automations-ui-revamp.md): consent is configured at edit time (Behavior tab)
// and reviewed inline in the thread — never a runtime dialog. Both surfaces
// read the same three consent lists, pre-filtered to ONE automation's actor
// by the route layer (`automationThreadData.ts`), so these DTOs carry no
// actor/actorKind field — filtering already happened before the screen sees
// them.
export type ConsentKind = 'outbox' | 'parked' | 'grant';
export type ConsentDecision = 'approve' | 'discard' | 'revoke';
/** A Tier 3/4 invocation parked for owner confirmation (vault write above
 *  the automation's install-time ceiling). */
export interface ParkedItemDTO {
  invocationId: string;
  command: string;
  parkedAt: string;
  input: Record<string, unknown>;
}
/** A staged external write (outbox item) awaiting owner decision or already
 *  decided/drained — the thread shows both so a past send stays legible. */
export interface OutboxItemDTO {
  itemId: string;
  connectionKind: string;
  connectionLabel: string;
  verb: string;
  target: string;
  artifact: Record<string, unknown>;
  status: string;
  stagedAt: string;
  canEdit: boolean;
  note: string | null;
}
/** A standing "always allow" rule minted from a past outbox decision. */
export interface GrantDTO {
  grantId: string;
  verb: string;
  target: string;
  createdAt: string;
  revokedAt: string | null;
}
export interface AuConsentDTO {
  parked: ParkedItemDTO[];
  outbox: OutboxItemDTO[];
  grants: GrantDTO[];
}

// ── Automation editor (instructions-first create/edit form) ────────────────
// Name, Instructions (manifest `prompt` — the source of intent the builder
// compiles into `handler.js`), a trigger picker, and Connectors / Behavior /
// Notifications tabs. `AuEditorTriggerDTO` is the LOAD/display shape (webhook
// carries its minted id + pending flag so the Connectors tab can show the
// URL); `AuEditorTriggerInput` is the narrower SAVE shape `updateAutomation`
// accepts (gateway-client-editing.ts `CentraidCreateTrigger` — a webhook
// entry carries no fields, minting happens server-side).
export type AuEditorTriggerDTO =
  | { kind: 'cron'; expr: string }
  | { kind: 'webhook'; id: string | null; pending: boolean }
  | { kind: 'condition'; entity: string; where?: unknown; every?: string }
  | { kind: 'data'; entities: string[]; every?: string };
export type AuEditorTriggerInput =
  | { kind: 'cron'; expr: string }
  | { kind: 'webhook' }
  | { kind: 'condition'; entity: string; where?: unknown; every?: string }
  | { kind: 'data'; entities: string[]; every?: string };
/** Connectors tab: manifest `requires`/`connector`/`vault`, resolved to
 *  display-ready chip lists (see `automationEditorData.ts`'s
 *  `deriveConnectors`) so the tab can render real chips instead of a fixed
 *  explainer. Names only — no secret values cross this DTO. */
export interface AuEditorConnectorsDTO {
  mcps: string[];
  secrets: string[];
  connector: string | null;
  vaultPurpose: string | null;
  /** One compact string per `manifest.vault.scopes[]` entry (e.g.
   *  `"core.event read"`) — see `automationEditorData.ts`'s
   *  `vaultScopeLabel` for the exact format, shared with the
   *  Approvals/Vault screens' scope-summary convention. */
  vaultScopes: string[];
}
export interface AutomationEditorData {
  mode: 'create' | 'edit';
  /** The `ref` once the automation exists on the gateway; `null` for a
   *  not-yet-scaffolded create flow. */
  automationId: string | null;
  /** `row.id` — the identity key `hueForId`/`glyphForId` use elsewhere
   *  (Overview, Thread). Distinct from `automationId` (`row.ref`, a
   *  `<ownerApp>/<id>` handle) — keying identity on the wrong one makes the
   *  editor's hue/glyph mismatch the rest of the app. `null` for a
   *  not-yet-scaffolded create flow. Optional/additive: a `loadData` that
   *  predates this field still typechecks; the screen falls back to
   *  `automationId`. */
  rowId?: string | null;
  name: string;
  /** Manifest `prompt` — the natural-language instructions the builder
   *  compiles. Empty string for a fresh create. */
  instructions: string;
  triggers: AuEditorTriggerDTO[];
  enabled: boolean;
  webhook: { pending: boolean; url: string | null } | null;
  /** Behavior tab: this automation's current standing consent — same shape
   *  the thread shows, so "what can it do without asking" reads identically
   *  in both places. */
  consent: AuConsentDTO;
  /** Connectors tab data. `null`/absent in create mode (nothing is
   *  compiled yet) or when the load layer hasn't populated it — the screen
   *  treats both as "show the explainer/empty state". Optional/additive,
   *  same rationale as `rowId`. */
  connectors?: AuEditorConnectorsDTO | null;
  /** Notifications tab: manifest `onFailure` — another automation's ref
   *  this one hands off to when a run fails. Optional/additive. */
  onFailure?: string | null;
  /** Notifications tab: manifest `requires.model` (falling back to
   *  `costEstimate.model`) — the model the compiled plan runs on.
   *  Optional/additive. */
  model?: string | null;
}
export interface AutomationEditorSaveFields {
  name: string;
  instructions: string;
  triggers: AuEditorTriggerInput[];
}
export interface AutomationEditorBridgeProps {
  /** Load the form. For create mode (no `automationId` in the route),
   *  resolves to defaults (`mode: 'create'`, empty name/instructions/triggers). */
  loadData: () => Promise<AutomationEditorData>;
  /** Persist Name/Instructions/triggers (manifest-only edit + publish —
   *  `updateAutomation`); resolves true on success. */
  onSave: (fields: AutomationEditorSaveFields) => Promise<boolean>;
  /** Start a hidden compile after the manifest save. */
  onCompile: (enableOnSuccess?: boolean) => Promise<boolean>;
  onSearchEntities: (
    term: string,
  ) => Promise<Array<{ type: string; id: string; title: string | null; subtitle: string | null }>>;
  /** Canonical vault entity-type names (e.g. `core.transaction`) for the
   *  data/condition trigger editors' `<datalist>` autocomplete. Fetched
   *  lazily the first time a data/condition trigger is present. Optional so a
   *  `loadData`-only host still typechecks; absent ⇒ no autocomplete. */
  loadEntityTypes?: () => Promise<string[]>;
  /** The compiled plan (automation.json + handler.js) for the read-only viewer. */
  onReadSource: () => Promise<{ manifest: string | null; handler: string | null }>;
  /** Internal-only builder handoff retained for a future surface; hidden in v0. */
  onOpenBuilder: (seedMessage?: string) => void;
  onRunNow: () => Promise<boolean>;
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  /** Behavior tab consent review — same decision surface the thread uses. */
  onDecideConsent: (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean,
  ) => Promise<boolean>;
  onOpenRun: (runId: string) => void;
  onCopyWebhook: (url: string) => void;
  onRotateWebhook: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onCancel: () => void;
}

// ── Automation thread (one long-lived conversation per automation) ─────────
// Every fire is a run appended to the thread; the header carries the same
// identity + trigger-hero fields `AutomationHeroDTO` carries (this screen
// supersedes `AutomationViewScreen`) plus `consent`, read inline instead of
// behind a separate Approvals detour.
export interface AutomationThreadHeaderDTO {
  id: string;
  ref: string;
  name: string;
  glyphIcon: string;
  hue: string;
  statusKind: AuStatusKind;
  statusLabel: string;
  enabled: boolean;
  description: string | null;
  kindEyebrow: string;
  heroIcon: string;
  triggerSummary: string;
  webhook: { pending: boolean; url: string | null } | null;
  nextRuns: string[];
  /** Stable manifest tokens shown as entity chips. */
  entityTags: Array<{ type: string; id: string }>;
}
export type ThreadRunStatus = 'ok' | 'fail' | 'running' | 'pending';
export interface ThreadRunDTO {
  runId: string;
  status: ThreadRunStatus;
  originLabel: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  summary: string;
  costUsd: number | null;
  /** Small-caps mono date separator label ("Today" / "Yesterday" / "Mon, Jul 6"). */
  dateGroup: string;
}
export interface AutomationThreadData {
  header: AutomationThreadHeaderDTO;
  consent: AuConsentDTO;
  runs: ThreadRunDTO[];
}
export interface AutomationThreadBridgeProps {
  /** Load the automation + its runs + its consent surface. `null` = not found. */
  loadData: () => Promise<AutomationThreadData | null>;
  onBack: () => void;
  /** Open the instructions-first editor for this automation. */
  onEdit: () => void;
  /** Retry the hidden compiler after a failed compile turn. */
  onRetryCompile: () => Promise<boolean>;
  onOpenRun: (runId: string) => void;
  onRunNow: () => Promise<boolean>;
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  onDecideConsent: (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean,
  ) => Promise<boolean>;
  /** Internal-only conversational revision callback retained but hidden in v0. */
  onSendMessage: (text: string) => void;
  onCopyWebhook: (url: string) => void;
  onRotateWebhook: () => Promise<boolean>;
  /** Confirm + delete; resolves true when deleted (thread is navigating away). */
  onDelete: () => Promise<boolean>;
}

// ── Settings: appearance + layout pages ─────────────────────────────────────
export type SettingsTileVariant = 'solid' | 'gradient' | 'glassy' | 'flat';
export interface SettingsAppearanceBridgeProps {
  theme: string;
  coolBlueCast: boolean;
  accent: string;
  tileVariant: SettingsTileVariant;
  onSetTheme: (theme: string) => void;
  onSetCoolCast: (on: boolean) => void;
  onSetAccent: (key: string) => void;
  onSetTile: (v: SettingsTileVariant) => void;
  /** Resolve the OS appearance to a theme name + apply it; returns the name. */
  onMatchSystem: () => string;
}
export interface SettingsLayoutBridgeProps {
  density: 'compact' | 'regular' | 'comfy';
  cardVariant: 'flat' | 'outlined' | 'elevated';
  sidebarOpen: boolean;
  onSetDensity: (v: 'compact' | 'regular' | 'comfy') => void;
  onSetCards: (v: 'flat' | 'outlined' | 'elevated') => void;
  onSetSidebar: (open: boolean) => void;
}

// ── Settings: providers (agents console) ────────────────────────────────────
/**
 * A runner kind as it arrives on the wire. Deliberately an OPEN string rather
 * than a closed union: the gateway derives the list from its own runner
 * registry, and a gateway newer than this client will name kinds this build
 * has never heard of. Narrowing here would make those unparseable — the exact
 * failure docs/protocol.md C1a forbids. The client renders whatever the
 * gateway lists, using the wire `label`, and only consults `AGENT_RUNNER_KINDS`
 * for cosmetic polish it happens to have on hand.
 */
export type AgentRunnerKind = string;
export interface AgentModelDTO {
  id: string;
  name?: string;
  default?: boolean;
  tier?: 'smart' | 'balanced' | 'fast';
}
export interface AgentCardDTO {
  kind: AgentRunnerKind;
  title: string;
  accent: string;
  subtitle: string;
  connected: boolean;
  models: AgentModelDTO[];
  modelsLoading: boolean;
}
/**
 * The chat/agent subsystems that can each pin their own model, independent
 * of the runner's default (issue: model config → gateway prefs store).
 * Mirrors the gateway prefs keys `model.<runnerKind>.<subsystem>`.
 */
export type ModelSubsystem = 'assistant' | 'ask' | 'builder' | 'automations';
export interface AgentsStatusDTO {
  /** The DEFAULT agent (`agent.runner.kind`) — the runner every subsystem
   *  without its own pin inherits. */
  selectedKind: AgentRunnerKind;
  cards: AgentCardDTO[];
  anyLoading: boolean;
  savedModelByKind: Record<string, string>;
  /** Per-runner subsystem model overrides, keyed by runner kind then subsystem. */
  subsystemModelByKind: Record<string, Partial<Record<ModelSubsystem, string>>>;
  /**
   * Per-subsystem runner pins (`runner.<subsystem>`). An ABSENT subsystem
   * inherits `selectedKind` — the map only carries explicit pins, so a
   * missing entry and "pinned to the default agent" stay distinguishable.
   */
  subsystemRunnerByKey: Partial<Record<ModelSubsystem, AgentRunnerKind>>;
}
export interface SettingsProvidersBridgeProps {
  loadStatus: () => Promise<AgentsStatusDTO>;
  refreshModels: () => Promise<AgentsStatusDTO>;
  /** Switch the DEFAULT agent — the fallback every unpinned subsystem
   *  inherits; resolves true on success. */
  activateRunner: (kind: AgentRunnerKind) => Promise<boolean>;
  /** Persist this agent's default model ('' = clears back to the backend default). */
  setAgentModel: (kind: AgentRunnerKind, modelId: string) => void;
  /** Persist this agent's per-subsystem model override ('' = clears back to the default model). */
  setSubsystemModel: (kind: AgentRunnerKind, subsystem: ModelSubsystem, modelId: string) => void;
  /**
   * Pin this subsystem to a runner, independent of the default agent.
   * `''` clears the pin, so the subsystem inherits `selectedKind` again.
   */
  setSubsystemRunner: (subsystem: ModelSubsystem, kind: AgentRunnerKind | '') => void;
}

// ── Settings: Space (issue #382) ─────────────────────────────────────────────
// The cross-vault "Spaces" list + gateway "Connections" group DTOs
// (ProfileRowDTO/ConnectionRowDTO/SettingsProfilesBridgeProps) retired with
// SettingsProfilesScreen.tsx — that surface moved to the switcher, which is
// the (gateway, vault) pair manager now. The Settings "Space" page's own
// shape is `ActiveSpaceData` (shell/routes/settingsAccountData.ts), scoped
// to the active vault only.

// ── Home ────────────────────────────────────────────────────────────────────
export interface HomeMenuAnchor {
  kind: 'point' | 'rect';
  x?: number;
  y?: number;
  rect?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
}
export interface HomeTileDTO {
  background: string;
  glyphColor: string;
  boxShadow?: string;
}
export interface HomeAppItemDTO {
  id: string;
  name: string;
  desc: string;
  iconKey: string;
  tile: HomeTileDTO;
  tone: 'new' | 'draft' | null;
  stamp: string;
  starred: boolean;
  draft: boolean;
}
export interface HomeAutoItemDTO {
  ref: string;
  name: string;
  blurb: string;
  glyphIcon: string;
  hue: string;
  statusKind: AuStatusKind;
  statusLabel: string;
  triggerIcon: string;
  triggerLabel: string;
  integrations: string[];
  footTimeLabel: string;
  footOk: boolean;
  starred: boolean;
}
export interface HomeBridgeProps {
  /** Dev flag (issue #434, Phase 3) — when false the builder is hidden, so the
   *  "What should we build?" composer hero + its suggestions don't render and
   *  the empty states drop their "describe an app" build prompt. */
  builderEnabled: boolean;
  suggestions: string[];
  dateLabel: string;
  appItems: HomeAppItemDTO[];
  automationItems: HomeAutoItemDTO[];
  counts: { all: number; apps: number; automations: number };
  attention: number;
  onBuild: (prompt: string) => void;
  onOpenApp: (id: string) => void;
  onEnterDraft: (id: string) => void;
  onAppContext: (id: string, anchor: HomeMenuAnchor) => void;
  onOpenAutomation: (ref: string) => void;
  onAutomationMenu: (ref: string, anchor: HomeMenuAnchor) => void;
  onBrowseTemplates: () => void;
}

// ── Automation run-viewer (SSE, live) ───────────────────────────────────────
// The vanilla side owns the SSE stream + node model and derives a fully-display
// snapshot on each event; React renders it (timeline / log). React never sees
// the stream — same split as every other screen.
export interface RunNodeDTO {
  ordinal: number;
  status: 'running' | 'ok' | 'fail';
  typeIcon: string;
  name: string;
  kind: string;
  meta: string;
  error?: string;
  response?: string;
  input?: string;
  output?: string;
  liveText?: string;
  streaming: boolean;
}
export interface RunLogRowDTO {
  time: string;
  tone: string;
  label: string;
  sub?: string;
  input?: string;
  output?: string;
  error?: string;
  response?: string;
}
export interface RunViewSnapshot {
  crumbName: string;
  glyphIcon: string;
  hue: string;
  headerName: string;
  startedLabel: string;
  model: string;
  statusKind: AuStatusKind;
  statusLabel: string;
  inFlight: boolean;
  /** True when the run's parent automation no longer exists (deleted after
   * the run happened). The Automations overview keeps orphaned runs visible
   * with a raw-ref fallback name, so the run viewer must be able to render
   * them too instead of stranding on a bare loading state. */
  deleted: boolean;
  triggerLabel: string;
  triggersSummary: string;
  triggerHeroIcon: string;
  promptInstr: string;
  nodes: RunNodeDTO[];
  final: {
    kind: 'pending' | 'ok' | 'fail';
    model: string;
    summary?: string;
    output?: string;
    error?: string;
  };
  side: {
    outcomeKind: AuStatusKind;
    outcomeLabel: string;
    trigger: string;
    duration: string;
    started: string;
    runId: string;
    tokens: string;
    cost: string;
    steps: string;
    model: string;
  };
  logKpi: {
    triggerIcon: string;
    triggerLabel: string;
    tokens: string;
    cost: string;
    duration: string;
  };
  logRows: RunLogRowDTO[];
}
export interface RunViewBridgeProps {
  initialMode: 'timeline' | 'log';
  /** Handed an `update` fn on mount; the vanilla side calls it per stream event. */
  onReady: (update: (snap: RunViewSnapshot | null) => void) => void;
  onBack: () => void;
  onOpenAutomation: () => void;
  onRunAgain: () => void;
  onSetMode: (m: 'timeline' | 'log') => void;
}

// ── Assistant (streaming copilot) ───────────────────────────────────────────
// AssistantRoute owns the stream (streamAssistantTurn), the message model,
// and the rich-answer renderer; it pushes a snapshot to React on each change.
// Final AI answers carry pre-rendered HTML (from the vanilla `richAnswer`);
// React injects it and re-hydrates the interactive vault refs via `hydrateRefs`.
// The conversation LIST + selection now live in the shell sidebar (App.tsx +
// Sidebar.tsx) — AssistantScreen renders a single, full-width conversation
// only, so there's no `threads`/`onSelectThread`/`onDeleteThread` here.
export interface AsstToolCallDTO {
  tool: string;
  sql?: string;
  state: 'run' | 'ok' | 'error';
  meta: string;
}
/** A file attached to a sent (or historical) user message. */
export interface AsstAttachmentDTO {
  hash: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}
/** Retry pager position on an AI answer whose turn has siblings (issue #420). */
export interface AsstRetryDTO {
  /** 1-based position of the shown attempt. */
  index: number;
  /** Total attempts in this turn's family. */
  count: number;
}
/** Per-turn token/cost usage surfaced under an answer (issue #420, Wave 2). */
export interface AsstUsageDTO {
  inputTokens?: number;
  outputTokens?: number;
  /** USD cost — frozen from the ledger on reload, or a client estimate live. */
  costUsd?: number;
  /** True when `costUsd` is a live client-side estimate (ledger cost is exact). */
  estimated?: boolean;
  model?: string;
}
export type AsstMsgDTO =
  | { kind: 'user'; text: string; attachments?: AsstAttachmentDTO[]; createdAt?: number }
  | { kind: 'tools'; label: string; calls: AsstToolCallDTO[] }
  /** A live streaming reasoning/thinking row (issue #420, Wave 2). Live-only —
   *  reasoning is not persisted in the ledger, so it never comes back on reload. */
  | { kind: 'thinking'; text: string; streaming: boolean }
  /** A non-fatal runner notice (issue #420) — e.g. "this model can't read PDF
   *  attachments". Live-only; not persisted, so it never replays on reload. */
  | { kind: 'notice'; level: 'warn' | 'info'; text: string }
  | { kind: 'ai'; streaming: true; text: string; catchingUp?: boolean }
  | {
      kind: 'ai';
      streaming: false;
      html: string;
      error: boolean;
      /** Source text for "copy message" (issue #420). */
      copyText: string;
      /** Token/cost usage for the answer's turn (issue #420, Wave 2). */
      usage?: AsstUsageDTO;
      /** ms epoch of the answer, for the hover timestamp. */
      createdAt?: number;
      /** Turn id — the feedback/regenerate target; absent for a just-streamed
       *  answer not yet reloaded from the ledger, or an error bubble. */
      turnId?: string;
      /** Reader 👍/👎 on this answer, if set. */
      feedback?: 'up' | 'down' | null;
      /** Retry pager, present when the turn has been regenerated. */
      retry?: AsstRetryDTO;
      /** Only the last non-error answer — gates the Regenerate control. */
      canRegenerate?: boolean;
      /** An error bubble whose failed message can be retried (issue #420). */
      canRetry?: boolean;
      /** The failed send happened while the browser was offline (issue #420). */
      offline?: boolean;
    };
/** A file the composer has uploaded (or is uploading) ahead of the next send. */
export interface AsstPendingAttachmentDTO {
  id: string;
  filename: string;
  sizeBytes: number;
  state: 'uploading' | 'ready' | 'error';
  errorText?: string;
  /** MIME type — drives the composer image thumbnail (issue #420, Wave 2). */
  mime?: string;
  /** Local object-URL preview for an image attachment (issue #420, Wave 2). */
  previewUrl?: string;
}
export interface AssistantSnapshot {
  empty: boolean;
  busy: boolean;
  messages: AsstMsgDTO[];
  pendingAttachments: AsstPendingAttachmentDTO[];
}
/**
 * The composer's inline model picker (subsystem `assistant`, active runner
 * only) — mirrors the same `model.<runnerKind>.assistant` gateway pref the
 * Settings → Models → Agents "Chat & agent subsystems" group reads/writes
 * (settingsProvidersData.ts), so both surfaces always agree. `models` is the
 * active runner's catalog; `selectedModelId` is `''` when the subsystem has
 * no override (falls through to `defaultModelName`, the runner's own default
 * — either its saved default model or its catalog-marked default).
 */
export interface AsstModelOptionDTO {
  id: string;
  name?: string;
  default?: boolean;
}
export interface AsstModelPickerDTO {
  connected: boolean;
  models: AsstModelOptionDTO[];
  defaultModelName: string;
  selectedModelId: string;
}
export interface AssistantBridgeProps {
  suggestions: string[];
  /** The open conversation id — keys per-thread scroll restore + draft
   *  persistence (issue #420). `undefined` for a fresh, uncreated thread. */
  conversationId?: string;
  onReady: (update: (s: AssistantSnapshot) => void) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Upload one or more just-picked/dropped/pasted files ahead of the next send. */
  onAttachFiles: (files: File[]) => void;
  onRemovePendingAttachment: (id: string) => void;
  /** Wire the interactive vault refs inside a just-rendered answer node. */
  hydrateRefs: (node: HTMLElement) => void;
  /** Wire code-block "Copy" buttons inside a just-rendered answer node (#420). */
  wireCodeCopy: (node: HTMLElement) => void;
  /** Fetch an image attachment's bytes (auth-aware) as an object URL for an
   *  inline transcript thumbnail; revoke it on cleanup (issue #420, Wave 2). */
  loadAttachmentImage: (hash: string, mime: string) => Promise<string>;
  /** Copy a message's source text to the clipboard (issue #420). */
  onCopyMessage: (text: string) => void;
  /** Set 👍/👎 on an answer turn (toggles off when re-clicking the same). */
  onFeedback: (turnId: string, value: 'up' | 'down') => void;
  /** Regenerate the last answer (re-runs the last user message as a retry). */
  onRegenerate: () => void;
  /** Retry the failed message behind the error bubble at `messageIndex`. */
  onRetryError: (messageIndex: number) => void;
  /** Flip the retry pager on the AI message at `messageIndex` by `delta`. */
  onPagerNav: (messageIndex: number, delta: number) => void;
  /** Read the assistant model picker's current state (fetched on mount). */
  loadModelPicker: () => Promise<AsstModelPickerDTO>;
  /** Persist the subsystem model override ('' clears back to the default model). */
  onSetModel: (modelId: string) => void;
  /** Composer entity-mention search (issue #420). Absent = mentions disabled. */
  searchEntities?: (term: string) => Promise<AsstComposerEntity[]>;
  /** Slash-command menu shown on a leading `/` (issue #420). */
  slashCommands?: AsstSlashCommand[];
  /** Run a chosen slash command by id (wired to existing shell actions). */
  onRunSlash?: (id: string) => void;
}

/** A vault entity offered by the composer @-mention picker (issue #420). */
export interface AsstComposerEntity {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
}

/** A composer slash command (issue #420). */
export interface AsstSlashCommand {
  id: string;
  label: string;
  hint?: string;
  enabled?: boolean;
}

// ── App-view settings popover ────────────────────────────────────────────────
// The app-view keeps the sandboxed iframe host, the chrome window, and the
// per-app chat vanilla; only the gear popover is React. The vanilla side owns
// all gateway I/O — knob persistence + the live iframe postMessage push, the
// automation run/toggle streams — and the two deep sub-trees the popover embeds
// (the lazy run-history timeline and the vault consent pane), which it injects
// into React-provided host divs via `onMountRuns` / `onMountVault`.
export interface AppKnobDTO {
  key: string;
  label: string;
  type: 'segmented' | 'swatch';
  value: string;
  options: { value: string; label: string }[];
}
export interface AppOrderRunDTO {
  kind: 'idle' | 'running' | 'done';
  ok?: boolean;
  /** e.g. "Ran in 1.2s" / "Failed: …" — present only when `kind === 'done'`. */
  label?: string;
}
export interface AppOrderDTO {
  id: string;
  ref: string;
  name: string;
  schedule: string;
  prompt: string;
  appsLabel: string;
  enabled: boolean;
  run: AppOrderRunDTO;
}
export interface AppSettingsSnapshot {
  appName: string;
  iconSvg: string;
  /** Gradient tile finish for the header app icon. */
  iconBg: string;
  iconColor: string;
  iconShadow: string | null;
  accent: string;
  vaultVisible: boolean;
  automationsBadge: number | null;
  vaultBadge: number | null;
  /** Resolved appearance knobs; `null` while loading or when the app has none. */
  knobs: AppKnobDTO[] | null;
  orders: AppOrderDTO[];
}
export interface AppSettingsBridgeProps {
  onReady: (update: (s: AppSettingsSnapshot) => void) => void;
  onClose: () => void;
  onKnobCommit: (key: string, value: string) => void;
  onRunOrder: (ref: string) => void;
  onToggleOrder: (ref: string, enabled: boolean) => void;
  onOpenOrder: (ref: string) => void;
  onOpenAutomations: () => void;
  onRename: () => void;
  onShare: () => void;
  onReveal: () => void;
  onDelete: () => void;
  /**
   * Whether this app is a bundled install serving in place (issue #434). Its
   * danger-zone action is Uninstall (revoke access, data stays), not Delete
   * (wipe local files) — code-store apps keep Delete.
   */
  bundled?: boolean;
  /** Fill the per-order run-history host — vanilla owns the deep timeline. */
  onMountRuns: (ref: string, host: HTMLElement) => void;
  /** Fill the vault consent pane host — vanilla `renderVaultPane`. */
  onMountVault: (host: HTMLElement) => void;
}

// ── Builder chat pane ────────────────────────────────────────────────────────
// The builder's right pane (preview / code / cloud / config / runs / flow) stays
// vanilla — iframe host, code editor, cloud rail. Only the left CHAT pane moves
// to React. The vanilla `openBuilder` closure keeps the SSE agent stream, the
// `chat` message model, and all turn state; it derives a snapshot on every
// change (the single `renderChat()` funnel) and pushes it. React renders the
// transcript, the determinate agent-progress strip, and the composer. The
// version-history view stays a vanilla async renderer, injected into a host div
// via `onMountHistory`.
export type BuilderMsgDTO =
  | { kind: 'divider'; text: string }
  | { kind: 'status'; text: string; spinning: boolean }
  | { kind: 'user'; text: string }
  | { kind: 'ai'; paras: string[] }
  | { kind: 'thinking'; text: string; streaming: boolean; header: string }
  | {
      kind: 'toolGroup';
      id: string;
      label: string;
      open: boolean;
      running: boolean;
      error: boolean;
      rows: { state: 'running' | 'ok' | 'error'; verb: string; target: string }[];
      change: { count: number; subtitle: string; version: string } | null;
    };
export interface BuilderProgressDTO {
  verb: string;
  file: string;
  sub: string;
  filled: number;
}
export interface BuilderChatSnapshot {
  view: 'chat' | 'history';
  messages: BuilderMsgDTO[];
  generating: boolean;
  /** Live turn progress; present only while `generating`. */
  progress: BuilderProgressDTO | null;
  suggestions: string[];
  /** `true` while a turn is in flight or before an app id exists. */
  composerDisabled: boolean;
  /** Bumps to force a history-view re-fetch after a version op. */
  historyNonce: number;
}
/** A builder-composer attachment ref (mirrors ConversationAttachmentRef). */
export interface BuilderAttachmentRef {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
}
export interface BuilderChatBridgeProps {
  onReady: (update: (s: BuilderChatSnapshot) => void) => void;
  /** Send a turn, optionally with files uploaded ahead of it (issue #420). */
  onSend: (text: string, attachments?: BuilderAttachmentRef[]) => void;
  onCancel: () => void;
  onToggleGroup: (id: string) => void;
  onSetView: (view: 'chat' | 'history') => void;
  /** Fill the version-history host — vanilla owns the async renderer. */
  onMountHistory: (host: HTMLElement) => void;
  /** Upload one file to the app's blob CAS (issue #420). When omitted, the
   *  composer's attach button is hidden (e.g. before the app exists). */
  onUploadAttachment?: (file: File) => Promise<BuilderAttachmentRef>;
}
