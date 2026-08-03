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

import type { TileVariant } from "@centraid/design";

import type { ResourceUsageDTO } from "./screens/resource-summary.js";

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
  kind?: "app" | "automation";
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
  triggerKind?: "cron" | "webhook" | "data" | "condition";
  triggerLabel?: string;
  integrations?: readonly string[];
}

/** Right-click anchor passed back to the shell's template context menu. */
export interface DiscoverMenuAnchor {
  kind: "point";
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

// ── Insights (#514 transparency rewrite) ────────────────────────────────────
// DTOs mirror CentraidInsightsSummary & friends (centraid-api.d.ts).
export interface InsightsKpis {
  totalTokens: number;
  hydrationTokens: number;
  /** Known spend floor when unpriced/unreported runs exist. */
  totalCostUsd: number;
  agentReportedCostUsd: number;
  estimatedCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  failedRuns: number;
  failedCostUsd: number;
  appsTouched: number;
  unpricedRuns: number;
  unreportedRuns: number;
}
export interface InsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}
export interface InsightsSourceRow {
  key: string;
  label: string;
  kind: string;
  runs: number;
  tokens: number;
  costUsd: number;
  automationName?: string;
}
export interface InsightsRunnerRow {
  provider: string;
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
export interface InsightsEffortRow {
  effort: string;
  runs: number;
  tokens: number;
  costUsd: number;
}
export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  automationRef?: string;
  automationName?: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  hydrationTokens: number;
  costUsd: number;
  provider?: string;
  model?: string;
  effort?: string;
}
export interface InsightsPeakDay {
  date: string;
  tokens: number;
  costUsd: number;
  topSources: Array<{
    key: string;
    label: string;
    kind: string;
    tokens: number;
    costUsd: number;
  }>;
}
export interface InsightsAttention {
  kind: "top_source";
  key: string;
  label: string;
  kindLabel: string;
  share: number;
  costUsd: number;
}
export interface InsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  bySource: InsightsSourceRow[];
  byRunner: InsightsRunnerRow[];
  byModel: InsightsModelRow[];
  byEffort: InsightsEffortRow[];
  recent: InsightsActivityRow[];
  peakDay?: InsightsPeakDay;
  attention?: InsightsAttention;
}
export interface InsightsBridgeProps {
  summary: InsightsSummary;
  windowDays: number;
  onWindowDays: (days: number) => void;
  onOpenRun?: (automationId: string, runId: string) => void;
  /** Measured resource actuals from `health.metrics.resourceUsage` (#528 Phase
   *  C); absent on older gateways, which renders a quiet "not available" line. */
  resourceUsage?: ResourceUsageDTO;
}

// ── Vault pane ────────────────────────────────────────────────────────────
// DTOs mirror the gateway-client-vault.ts types so the React island stays
// decoupled from the vanilla client module (and its ambient globals).
export interface VaultScopeDTO {
  schema: string;
  table?: string | null;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }> | null;
  fieldMask?: string[] | null;
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
  callerKind: "app" | "agent" | "assistant" | "owner-device";
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
  variant: "action" | "app" | "chat";
  /** For `variant: 'app'` — the gradient tile paint. */
  tile?: PaletteTileDTO;
  /**
   * MONO row-kind register (Binding Layer row anatomy, issue #708 §A) — a
   * short lowercase noun for what the row IS (`doc`, `person`, `event`,
   * `conversation`), rendered ahead of the title. Unset for rows that are
   * not a vault object (apps, nav destinations, the create row).
   */
  kind?: string;
  /**
   * NUMERIC register — tabular mono, a date/size/count. Distinct from `sub`,
   * which stays free UI-register text.
   */
  meta?: string;
  kbd?: string;
  accent?: boolean;
  run: () => void;
}
export interface PaletteGroupIconDTO {
  /** Pre-rendered icon SVG markup — the owning app's glyph. */
  html: string;
  /** Identity hue as a CSS value, e.g. `var(--c-teal)`. Omitted = no tint. */
  hue?: string;
}
export interface PaletteGroupDTO {
  group: string;
  /**
   * Group marker (Binding Layer row anatomy, issue #708 §A point 2) — set
   * when every row in the group is a vault object owned by one app/surface
   * (entity search, Conversations, Recents); omitted for navigational
   * groups (Apps, Go to, Create) that stay plain text.
   */
  icon?: PaletteGroupIconDTO;
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
  /**
   * Example queries for the pre-query empty state (issue #708 §A) — seeded
   * from what the vault actually contains, not static copy. Read only while
   * the query field is empty; a click fills the field with the chip's text.
   */
  suggestions?: () => string[];
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
    onPaired: (deviceName: string) => void
  ) => Promise<{ info: PhonePairingDTO; cancel: () => void } | null>;
  revoke: (deviceId: string) => Promise<boolean>;
  showToast?: (message: string) => void;
}

// ── Import pane ─────────────────────────────────────────────────────────────
export interface ImportBatchDTO {
  batchId: string;
  status: "draft" | "published" | "discarded";
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
  status: "active" | "needs-auth" | "failing" | "paused";
  lastRunAt: string | null;
  lastRunError: string | null;
}
export interface ImportRowDTO {
  entityType: string;
  externalId: string;
  disposition: "create" | "update" | "skip" | "merge-candidate";
  note: string | null;
  mapping: string;
}
export interface ImportData {
  vaultName: string;
  batches: ImportBatchDTO[];
  connections: ImportConnectionDTO[];
}
export interface ImportStagePayload {
  filename?: string;
  text?: string;
  base64?: string;
  directoryName?: string;
  files?: { path: string; text: string }[];
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
  setConnectionStatus: (
    connectionId: string,
    status: "active" | "paused"
  ) => Promise<void>;
  exportPortable: () => Promise<{ blob: Blob; filename: string }>;
  showToast?: (message: string) => void;
}

// ── Automations overview ────────────────────────────────────────────────────
// The vanilla side derives every display value (hue, glyph, trigger + status
// labels, formatted run meta) so the React screen needs no app-format /
// automation-identity imports.
export type AuStatusKind =
  | "active"
  | "paused"
  | "draft"
  | "running"
  | "success"
  | "failed";
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
  /** The most recent run's message — its summary, or the error text when it
   *  failed — shown as the inbox row's preview line. `null` before the first
   *  run (issue #539, automation-as-conversation inbox). */
  lastRunSummary: string | null;
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
  /** The newest attempt is a successful or failed fallback rung. */
  recentFailover?: boolean;
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
/** One suggested starter card on the Automations empty overview. */
export interface AuOverviewSuggestionDTO {
  id: string;
  name: string;
  desc: string;
  triggerLabel?: string;
}

export interface AutomationsOverviewBridgeProps {
  loadData: () => Promise<AuOverviewData>;
  onOpenAutomation: (ref: string) => void;
  onOpenRun: (automationId: string, runId: string) => void;
  onBrowseTemplates: () => void;
  onNewAutomation: () => void;
  /** Curated template starters for the empty fleet — omitted when the
   *  catalog is unavailable. Empty state falls back to Browse / New only. */
  loadSuggestions?: () => Promise<AuOverviewSuggestionDTO[]>;
  /** Adopt a suggested template (clone → thread), same path as Templates. */
  onUseSuggestion?: (templateId: string) => void;
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
export type ConsentKind = "outbox" | "parked" | "grant";
export type ConsentDecision = "approve" | "discard" | "revoke";
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
// compiles into `handler.js`), a trigger picker, and Notifications / Plan
// tabs. Connectors are chosen from the Instructions toolbar (catalog + OAuth /
// API-key attach). `AuEditorTriggerDTO` is the LOAD/display shape (webhook
// carries its minted id + pending flag); `AuEditorTriggerInput` is the
// narrower SAVE shape `updateAutomation` accepts (gateway-client-editing.ts
// `CentraidCreateTrigger` — a webhook entry carries no fields, minting
// happens server-side).
export type AuEditorTriggerDTO =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "webhook"; id: string | null; pending: boolean }
  | { kind: "condition"; entity: string; where?: unknown; every?: string }
  | { kind: "data"; entities: string[]; every?: string }
  | {
      kind: "event";
      connectorKind: string;
      event: string;
      filter?: Record<string, unknown>;
      every?: string;
    };
export type AuEditorTriggerInput =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "webhook" }
  | { kind: "condition"; entity: string; where?: unknown; every?: string }
  | { kind: "data"; entities: string[]; every?: string }
  | {
      kind: "event";
      connectorKind: string;
      event: string;
      filter?: Record<string, unknown>;
      every?: string;
    };
/** Compiled-plan connector summary (read-only chips from the manifest).
 *  Owner-picked catalog connectors live separately on the Instructions
 *  toolbar picker — see `loadConnectorCatalog` on the bridge. */
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
  /** Durable connection bindings (ids only) when the automation references vault credentials. */
  connections?: Array<{ connectionId: string; kind: string; label: string }>;
}
/** One selectable catalog connector for the automation editor picker.
 *  Carries everything needed to configure oauth2 or api_key credentials
 *  without re-fetching the provider preset. */
export interface AuEditorCatalogConnectorDTO {
  key: string;
  kind: string;
  name: string;
  tone: string;
  credKind: "oauth2" | "api_key";
  providerId: string;
  providerName: string;
  templateId: string;
  scope?: string;
  scopes?: string;
  authUrl?: string;
  tokenUrl?: string;
  allowedHosts: string[];
  setup: string[];
  /** Existing vault connection for this kind, if any. */
  connection: {
    connectionId: string;
    label: string;
    principal: string | null;
    health: "ok" | "needs-auth" | "paused" | "failing";
  } | null;
  /** Every configured account for this exact provider + connector kind.
   *  The editor renders an account chooser when more than one exists. */
  connections: Array<{
    connectionId: string;
    label: string;
    principal: string | null;
    health: "ok" | "needs-auth" | "paused" | "failing";
  }>;
}
export interface AutomationEditorData {
  mode: "create" | "edit";
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
  /** Compiled-plan connector summary (optional/additive). Owner picks from the
   *  catalog via `loadConnectorCatalog` on the Instructions toolbar. */
  connectors?: AuEditorConnectorsDTO | null;
  /** Notifications tab: manifest `onFailure` — another automation's ref
   *  this one hands off to when a run fails. Optional/additive. */
  onFailure?: string | null;
  /** Notifications tab: manifest `requires.model` (falling back to
   *  the selected runner's effective default) — the model the compiled plan
   *  runs on. `null` means "Use default". Optional/additive. */
  model?: string | null;
  /** Manifest `requires.runner`; `null` means the automations subsystem runner. */
  runner?: AgentRunnerKind | null;
  /** Effective automations subsystem runner inherited when `runner` is null. */
  defaultRunnerKind?: AgentRunnerKind;
  /** Effective model inherited for `defaultRunnerKind` when `model` is null. */
  defaultModel?: string | null;
  /**
   * Gateway-wide default cron timezone (prefs `automation.cron.defaultTimezone`).
   * Used when a cron trigger omits `tz` (issue #570). Absent/empty → host-local.
   */
  defaultCronTimeZone?: string | null;
  /** Dynamic gateway runner/model catalog used by the editor Agent control. */
  agentRunners?: Array<{
    kind: AgentRunnerKind;
    label: string;
    accent: string;
    connected: boolean;
    models: AgentModelDTO[];
    defaultModel: string | null;
  }>;
}
export interface AutomationEditorSaveFields {
  name: string;
  instructions: string;
  triggers: AuEditorTriggerInput[];
  /**
   * Durable vault connection bindings from the connectors picker.
   * Soft bindings only (agent automations) — connection id + kind + label.
   */
  connections?: Array<{ connectionId: string; kind: string; label: string }>;
  /** Explicit harness pin; `null` clears back to the automations default. */
  runner?: AgentRunnerKind | null;
  /** Explicit model pin; `null` clears back to the selected runner's default. */
  model?: string | null;
}
/** Credential payload when attaching a catalog connector from the editor. */
export interface AuEditorConnectFormInput {
  providerId: string;
  connectorKind: string;
  label: string;
  credKind: "oauth2" | "api_key";
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  allowedHosts: string[];
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
}
// ── The compiler workbench (compile screen) ────────────────────────────────
// Authoring an automation is a compile loop, not a form submit: you edit the
// instructions, compile them into a deterministic plan, watch the compile
// steps, read the failure when there is one, and ask the assistant to fix it.
// All of that belongs to the EDITOR route — the run screen only ever reports
// that a plan exists (`AuPlanStatusDTO`) and links here.

/** One step of a compile attempt — a tool call or a model step the compiler
 *  took, flattened from that turn's ledger items. `detail` carries the error
 *  when the step failed, otherwise a short one-line preview (assistant text /
 *  tool target) — never the whole payload. */
export interface CompileStepDTO {
  itemId: string;
  ordinal: number;
  /** Ledger item kind — 'tool' / 'step' / 'agent' / 'message_in'. */
  kind: string;
  /** Human label: the tool name, or the phase for a model step. */
  label: string;
  status: "ok" | "fail" | "running";
  durationMs: number | null;
  detail: string | null;
}

/** One compile attempt (a `triggerKind: 'compile'` turn). The workbench lists
 *  these newest-first so a failed compile can be compared with the last good
 *  one instead of vanishing. */
export interface CompileAttemptDTO {
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  status: "ok" | "fail" | "running";
  /** Failure text from the ledger — shown verbatim in the rail's failure block.
   *  (It used to seed a fix-it assistant; there is no second editor now.) */
  error: string | null;
  summary: string | null;
  /** Relative label for the attempt header ("just now", "12m ago"). */
  whenLabel: string;
}

/** Outcome of watching one compile/test turn to completion. `settled` is what
 *  the ledger says (false ⇒ the stream dropped with the turn still open, so
 *  the caller must rejoin); `ok` is the turn's result once settled. */
export interface TurnWatchOutcome {
  settled: boolean;
  ok: boolean;
}

export interface AutomationEditorBridgeProps {
  /** Load the form. For create mode (no `automationId` in the route),
   *  resolves to defaults (`mode: 'create'`, empty name/instructions/triggers). */
  loadData: () => Promise<AutomationEditorData>;
  /** Persist Name/Instructions/triggers (manifest-only edit + publish —
   *  `updateAutomation`); resolves true on success. */
  onSave: (fields: AutomationEditorSaveFields) => Promise<boolean>;
  /**
   * Start a compile and return its turn id — the workbench then watches that
   * turn in place. It deliberately does NOT navigate: compiling is the
   * editor's own loop, and being thrown to the run screen mid-compile was the
   * reason a failed compile had nowhere to be fixed.
   */
  onCompile: (enableOnSuccess?: boolean) => Promise<string | null>;
  /** Compile attempts for this automation, newest first. */
  loadCompileAttempts: () => Promise<CompileAttemptDTO[]>;
  /** Cold read of one compile/test turn's steps. */
  loadTurnSteps: (turnId: string) => Promise<CompileStepDTO[]>;
  /**
   * Join a turn's live step stream. Same rejoin contract the thread uses:
   * resolves `settled: false` when the stream closed with the turn still
   * open, and performs the one authoritative post-stream ledger re-read.
   */
  watchTurnSteps: (
    turnId: string,
    onSteps: (steps: CompileStepDTO[]) => void,
    signal: AbortSignal
  ) => Promise<TurnWatchOutcome>;
  /* No conversational edit path. The compile screen has exactly ONE editable
     surface — the instructions field — and the run screen has none. An
     assistant composer in the compiler rail was a second writer on that same
     field, so a revise could silently supersede text the owner was mid-edit
     on. Everything the compiler has to say now flows one way: it reports, the
     owner rewrites the instructions, Save recompiles. */
  /** Fire a test execution of the compiled plan and return its turn id. Stays
   *  on this screen; `onOpenRun` is the explicit way out to the run viewer. */
  onTestRun: () => Promise<string | null>;
  onSearchEntities: (term: string) => Promise<
    Array<{
      type: string;
      id: string;
      title: string | null;
      subtitle: string | null;
    }>
  >;
  /** Canonical vault entity-type names (e.g. `core.transaction`) for the
   *  data/condition trigger editors' `<datalist>` autocomplete. Fetched
   *  lazily the first time a data/condition trigger is present. Optional so a
   *  `loadData`-only host still typechecks; absent ⇒ no autocomplete. */
  loadEntityTypes?: () => Promise<string[]>;
  /** Provider catalog + live connection status for the Instructions
   *  Connectors picker. Optional so hosts without the connections API still
   *  typecheck; absent ⇒ picker shows an empty/unavailable state. */
  loadConnectorCatalog?: () => Promise<AuEditorCatalogConnectorDTO[]>;
  /** Attach BYO oauth2 client or api_key credential for a connector kind.
   *  Resolves with the new/updated `connectionId` so oauth2 can start PKCE. */
  configureConnection?: (
    input: AuEditorConnectFormInput
  ) => Promise<{ connectionId: string } | void>;
  /** Start PKCE authorize for an oauth2 connection; returns the URL to open. */
  beginAuthorize?: (connectionId: string) => Promise<string>;
  showToast?: (message: string) => void;
  /** The compiled plan (automation.json + handler.js) for the read-only viewer. */
  onReadSource: () => Promise<{
    manifest: string | null;
    handler: string | null;
  }>;
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  /** Standing-grant consent review (edit mode) — same decision surface the
   *  thread uses. Kept on the bridge for future surfaces; not shown as a
   *  bottom tab anymore. */
  onDecideConsent: (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean
  ) => Promise<boolean>;
  onOpenRun: (runId: string) => void;
  /** Leave the compiler for this automation's run history. */
  onOpenRuns: () => void;
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
export type ThreadRunStatus = "ok" | "fail" | "running" | "pending";
/**
 * What a thread entry IS. The run screen shows exactly two things:
 *
 * - `run` — an EXECUTION of the compiled plan (scheduled / manual / replay /
 *   on-failure). This is the automation doing its job.
 * - `ask` — a question the owner asked ABOUT those executions, answered in
 *   place (`triggerKind: 'interactive'`). It reads nothing into the future and
 *   changes nothing.
 *
 * Compile turns are NOT thread entries. They are the compiler's own working,
 * they belong to the editor route, and mixing them in here is what made a
 * "Compile" card sit in the run history pretending to be a run.
 */
export type ThreadEntryKind = "run" | "ask";
export interface ThreadRunDTO {
  runId: string;
  entryKind: ThreadEntryKind;
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
/**
 * What the run screen is allowed to know about the compiled plan: enough to
 * say whether executions are running against a current, broken, or absent
 * plan — and nothing to act on. Every remedy is a link to the compiler.
 */
export interface AuPlanStatusDTO {
  state: "ready" | "compiling" | "failed" | "never";
  /** Headline for the banner ("Compile failed", "Plan ready"). */
  label: string;
  /** One line of context — the failure, or when the plan was built. */
  detail: string | null;
}
export interface AutomationThreadData {
  header: AutomationThreadHeaderDTO;
  consent: AuConsentDTO;
  /** Executions + asks, never compiles. */
  runs: ThreadRunDTO[];
  plan: AuPlanStatusDTO;
  /** Native interactive automation-turn endpoint advertised by the gateway. */
  automationTurns?: boolean;
}
export interface AutomationThreadBridgeProps {
  /** Load the automation + its runs + its consent surface. `null` = not found. */
  loadData: () => Promise<AutomationThreadData | null>;
  onBack: () => void;
  /**
   * Hand off to the compiler screen. Every "change this automation" affordance
   * on the run screen resolves to this one call — the run screen never edits,
   * compiles, or revises anything itself.
   */
  onOpenCompiler: () => void;
  onOpenRun: (runId: string) => void;
  /** Read one cold turn as the shared Message DTO. */
  loadTurnTrace: (turnId: string) => Promise<AsstMsgDTO[]>;
  /**
   * Join a native turn SSE stream and push shared Message snapshots. Resolves
   * `true` once the ledger shows the turn settled, `false` when the stream
   * closed with the turn still open (subscriber cap, gateway restart, proxy
   * idle timeout) — the screen rejoins on `false` instead of leaving a running
   * turn spinning forever. Implementations perform the one authoritative
   * post-stream ledger re-read themselves.
   */
  watchTurn: (
    turnId: string,
    onMessages: (messages: AsstMsgDTO[]) => void,
    signal: AbortSignal
  ) => Promise<boolean>;
  /** Start a manual fire and return its native turn id. */
  onRunNow: () => Promise<string | null>;
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  onDecideConsent: (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean
  ) => Promise<boolean>;
  /**
   * Ask a question about this automation's executions and stream the answer.
   * READ-ONLY by construction: there is no `applyFuture` escape hatch any
   * more, because a reply that silently rewrote the standing instructions was
   * authoring done from the wrong screen. Returns the native turn id.
   */
  onAskAboutRuns: (
    text: string,
    options: {
      attachments?: BuilderAttachmentRef[];
      runnerKind?: AgentRunnerKind;
      model?: string;
      thinking?: string;
      onContext?: (context: { used: number; size: number }) => void;
    },
    onMessages: (messages: AsstMsgDTO[]) => void,
    signal: AbortSignal
  ) => Promise<string | null>;
  /** Upload into the automation owner's CAS before the question is sent. */
  onUploadAttachment?: (file: File) => Promise<BuilderAttachmentRef>;
  /** Auth-aware transcript thumbnail loader. */
  loadAttachmentImage?: (hash: string, mime: string) => Promise<string>;
  /** Session-ready preflight before an attended per-conversation switch. */
  onSetRunner?: (runnerKind: AgentRunnerKind) => Promise<AsstModelPickerDTO>;
  onCopyWebhook: (url: string) => void;
  onRotateWebhook: () => Promise<boolean>;
  /** Confirm + delete; resolves true when deleted (thread is navigating away). */
  onDelete: () => Promise<boolean>;
}

// ── Settings: appearance + layout pages ─────────────────────────────────────
/** The three positions of the Appearance control. `system` is a standing mode
 *  the shell keeps tracking, not a one-shot snap to the current OS value. */
export type SettingsThemeMode = "light" | "dark" | "system";
/** Appearance is the one visual-treatment page: theme and card
 *  surface. Layout was folded into it (#608). The app-tile treatment picker
 *  was cut but keeps its pref; the dark ramp's surface temperature was removed
 *  outright, so dark has exactly one ramp — parity with light, which never had
 *  a temperature.
 *
 *  The accent swatches went the same way in #608 and their PREF went in #707:
 *  the shell spends no hue at all now, so there is no accent to store. Neither
 *  is `sidebarOpen` — the stem never hides, so there is no open state. */
export interface SettingsAppearanceBridgeProps {
  themeMode: SettingsThemeMode;
  cardVariant: "flat" | "outlined" | "elevated";
  onSetThemeMode: (mode: SettingsThemeMode) => void;
  onSetCards: (v: "flat" | "outlined" | "elevated") => void;
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
  tier?: "smart" | "balanced" | "fast";
}
export interface AgentCardDTO {
  kind: AgentRunnerKind;
  title: string;
  accent: string;
  subtitle: string;
  connected: boolean;
  models: AgentModelDTO[];
  modelsLoading: boolean;
  /** ACP initialize/session probe succeeded and did not request authentication. */
  sessionReady: boolean;
  /**
   * The runner is installed but its capability probe has not reported yet —
   * the gateway omits `capabilities` entirely until the probe succeeds, and it
   * also omits them when the probe throws. Without this flag "we haven't
   * checked" is indistinguishable from "you are signed out", which is how a
   * cold gateway came to label every installed runner "sign-in needed".
   */
  sessionProbePending?: boolean;
  /** Why an installed runner cannot join unattended failover. */
  fallbackBlockedReason?: string;
  /** Live ACP capability evidence gates the corresponding turn controls. */
  modelConfigurable?: boolean;
  supportsAttachments?: boolean;
  supportsContext?: boolean;
  /** Semantic ACP session configuration surfaced by the live probe. */
  configOptions?: Array<{
    id: string;
    category: string;
    type: string;
    values: Array<{ value: string; name?: string }>;
    currentValue?: string;
  }>;
  additionalDirectories?: boolean;
  /**
   * Short capability chips for Settings (vault, resume, model pin, sign-in).
   * Empty when the gateway has not probed this agent yet.
   */
  capabilityChips?: string[];
  /** True when vault tools need HTTP MCP and the agent does not offer it. */
  vaultUnavailable?: boolean;
  /** True when the agent answered AUTH_REQUIRED on the last probe. */
  authRequired?: boolean;
  /** Active breaker states, exposed so Settings can explain failover decisions. */
  breakerStates?: Array<{
    failureClass: string;
    state: "open" | "half-open";
  }>;
}
/**
 * The chat/agent subsystems that can each pin their own model, independent
 * of the runner's default (issue: model config → gateway prefs store).
 * Mirrors the gateway prefs keys `model.<runnerKind>.<subsystem>`.
 */
export type ModelSubsystem = "assistant" | "ask" | "builder" | "automations";
export interface AgentsStatusDTO {
  /** The DEFAULT agent (`agent.runner.kind`) — the runner every subsystem
   *  without its own pin inherits. */
  selectedKind: AgentRunnerKind;
  cards: AgentCardDTO[];
  anyLoading: boolean;
  savedModelByKind: Record<string, string>;
  /** Per-runner subsystem model overrides, keyed by runner kind then subsystem. */
  subsystemModelByKind: Record<string, Partial<Record<ModelSubsystem, string>>>;
  /** Semantic config pins at the runner-default tier. */
  defaultConfigPinsByKind: Record<string, Record<string, string>>;
  /** Semantic config pins at the runner + subsystem tier. */
  subsystemConfigPinsByKind: Record<
    string,
    Partial<Record<ModelSubsystem, Record<string, string>>>
  >;
  /** Sanitized, exportable capability evidence from the latest probe. */
  diagnosticsJson: string;
  /**
   * Per-subsystem runner pins (`runner.<subsystem>`). An ABSENT subsystem
   * inherits `selectedKind` — the map only carries explicit pins, so a
   * missing entry and "pinned to the default agent" stay distinguishable.
   */
  subsystemRunnerByKey: Partial<Record<ModelSubsystem, AgentRunnerKind>>;
  /** Ordered automatic failover members after the resolved primary runner. */
  subsystemRunnerLadders: Partial<Record<ModelSubsystem, AgentRunnerKind[]>>;
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
  setSubsystemModel: (
    kind: AgentRunnerKind,
    subsystem: ModelSubsystem,
    modelId: string
  ) => void;
  /** Persist a semantic runner-default config pin ('' clears it). */
  setAgentConfigPin: (
    kind: AgentRunnerKind,
    category: string,
    value: string
  ) => void;
  /** Persist a semantic per-subsystem config pin ('' clears it). */
  setSubsystemConfigPin: (
    kind: AgentRunnerKind,
    subsystem: ModelSubsystem,
    category: string,
    value: string
  ) => void;
  /**
   * Pin this subsystem to a runner, independent of the default agent.
   * `''` clears the pin, so the subsystem inherits `selectedKind` again.
   */
  setSubsystemRunner: (
    subsystem: ModelSubsystem,
    kind: AgentRunnerKind | ""
  ) => Promise<boolean>;
  /**
   * Replace one lane's ordered automatic failover membership. Removing a
   * member also revokes ladder-derived provider grants at the gateway.
   */
  setSubsystemRunnerLadder: (
    subsystem: ModelSubsystem,
    kinds: AgentRunnerKind[]
  ) => void;
}

// ── Settings: Vault (issue #382) ─────────────────────────────────────────────
// The cross-vault "Vaults" list + gateway "Connections" group DTOs
// (ProfileRowDTO/ConnectionRowDTO/SettingsProfilesBridgeProps) retired with
// SettingsProfilesScreen.tsx — that surface moved to the switcher, which is
// the (gateway, vault) pair manager now. The Settings "Vault" page's own
// shape is `ActiveVaultData` (shell/routes/settingsAccountData.ts), scoped
// to the active vault only.

// ── Home ────────────────────────────────────────────────────────────────────
export interface HomeMenuAnchor {
  kind: "point" | "rect";
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
  tone: "new" | "draft" | null;
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
  /** Native automation items rendered by the shared conversation Message. */
  messages: AsstMsgDTO[];
  final: {
    kind: "pending" | "ok" | "fail";
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
    /** False for deterministic / zero-usage runs (no tokens, cost, or steps).
     * The Usage card then shows a single caption instead of empty rows. */
    hasUsage: boolean;
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
  initialMode: "timeline" | "log";
  /** Handed an `update` fn on mount; the vanilla side calls it per stream event. */
  onReady: (update: (snap: RunViewSnapshot | null) => void) => void;
  onBack: () => void;
  onOpenAutomation: () => void;
  onRunAgain: () => void;
  onSetMode: (m: "timeline" | "log") => void;
}

// ── Assistant (streaming copilot) ───────────────────────────────────────────
// AssistantRoute owns the stream (streamAssistantTurn), the message model,
// and the rich-answer renderer; it pushes a snapshot to React on each change.
// Final AI answers carry pre-rendered HTML (from the vanilla `richAnswer`);
// React injects it and re-hydrates the interactive vault refs via `hydrateRefs`.
// The conversation LIST + selection live in the assistant SURFACE since #707
// (AssistantRoute + AssistantConversations) — AssistantScreen still renders a
// single conversation only, so there's no `threads`/`onSelectThread`/
// `onDeleteThread` here.
export interface AsstToolCallDTO {
  tool: string;
  sql?: string;
  state: "run" | "ok" | "error";
  meta: string;
  outputText?: string;
  artifacts?: Array<{ label: string; hash?: string; workspacePath?: string }>;
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
  /** ACP-confirmed semantic thought level; absent when the runner did not confirm it. */
  effort?: string;
}
/**
 * `msgId` is a stable identity for list keying (issue #541). A projected
 * transcript both grows and re-orders while a turn streams — a tool row is
 * inserted ahead of the answer bubble it belongs to on flush — so an array
 * index is not an identity, and keying by it remounts `Message` (which does
 * imperative DOM work on mount). Projections that know their source item
 * derive it from the ledger item id; hand-built optimistic bubbles omit it.
 */
export type AsstMsgDTO =
  | {
      kind: "user";
      text: string;
      attachments?: AsstAttachmentDTO[];
      createdAt?: number;
      msgId?: string;
    }
  | { kind: "tools"; label: string; calls: AsstToolCallDTO[]; msgId?: string }
  /** A live streaming reasoning/thinking row (issue #420, Wave 2). Live-only —
   *  reasoning is not persisted in the ledger, so it never comes back on reload. */
  | { kind: "thinking"; text: string; streaming: boolean; msgId?: string }
  /** A non-fatal runner notice (issue #420) — e.g. "this model can't read PDF
   *  attachments". Persisted as a notice step and replayed on reload. */
  | { kind: "notice"; level: "warn" | "info"; text: string; msgId?: string }
  | {
      kind: "ai";
      streaming: true;
      text: string;
      catchingUp?: boolean;
      msgId?: string;
    }
  | {
      kind: "ai";
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
      feedback?: "up" | "down" | null;
      /** Retry pager, present when the turn has been regenerated. */
      retry?: AsstRetryDTO;
      /** Only the last non-error answer — gates the Regenerate control. */
      canRegenerate?: boolean;
      /** An error bubble whose failed message can be retried (issue #420). */
      canRetry?: boolean;
      /** The failed send happened while the browser was offline (issue #420). */
      offline?: boolean;
      msgId?: string;
    };
/** A file the composer has uploaded (or is uploading) ahead of the next send. */
export interface AsstPendingAttachmentDTO {
  id: string;
  filename: string;
  sizeBytes: number;
  state: "uploading" | "ready" | "error";
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
  /** Latest ACP context snapshot; may decrease after compaction. */
  context?: { used: number; size: number };
  /** Explicitly selected extra workspace roots for the next turn. */
  additionalDirectories?: string[];
  /** Durable Centraid-owned primary workspace selection. */
  workspaceKind?: "vault-data" | "app" | "draft";
  /**
   * Older turns exist on the SERVER beyond what the route has fetched (issue
   * #659 G5). The screen exhausts its local render window first and then asks
   * for the previous page, so the "Show earlier messages" control is offered
   * whenever either source still has history — it must never do nothing.
   */
  canLoadEarlier?: boolean;
  /** A previous page is being fetched right now. */
  loadingEarlier?: boolean;
  /** False while a persisted conversation's runner binding is loading. */
  runnerReady?: boolean;
  /** Changes when the screen must reload runner/model capability data. */
  pickerRevision?: number;
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
  runners: Array<{
    kind: AgentRunnerKind;
    title: string;
    connected: boolean;
    sessionReady: boolean;
    /** Installed, probe not reported yet — say "checking", never "sign in". */
    sessionProbePending?: boolean;
    hint?: string;
  }>;
  selectedRunnerKind: AgentRunnerKind;
  workspaceKinds: Array<"vault-data" | "app" | "draft">;
  connected: boolean;
  models: AsstModelOptionDTO[];
  defaultModelName: string;
  selectedModelId: string;
  /** A higher-precedence manifest pin is displayed but cannot be overridden here. */
  modelLocked?: boolean;
  efforts: Array<{ value: string; name?: string }>;
  defaultEffortName: string;
  selectedEffortId: string;
  effortLocked?: boolean;
  supportsAdditionalDirectories?: boolean;
  supportsAttachments?: boolean;
  supportsContext?: boolean;
}
export interface AssistantBridgeProps {
  suggestions: string[];
  /** The open conversation id — keys per-thread scroll restore + draft
   *  persistence (issue #420). `undefined` for a fresh, uncreated thread. */
  conversationId?: string;
  onReady: (update: (s: AssistantSnapshot) => void) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /**
   * Fetch the page of turns before the oldest one held and PREPEND it (issue
   * #659 G5). Omitted by callers with no paged source (tests, older hosts) —
   * the screen then only expands its local window.
   */
  onLoadEarlier?: () => void;
  /** Upload one or more just-picked/dropped/pasted files ahead of the next send. */
  onAttachFiles: (files: File[]) => void;
  onRemovePendingAttachment: (id: string) => void;
  onAddWorkspace?: () => void;
  onRemoveWorkspace?: (directory: string) => void;
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
  onFeedback: (turnId: string, value: "up" | "down") => void;
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
  /** Persist the subsystem thought_level override ('' clears it). */
  onSetEffort: (effort: string) => void;
  /** Select a runner for this conversation and reload its semantic controls. */
  onSetRunner: (runnerKind: AgentRunnerKind) => Promise<AsstModelPickerDTO>;
  /** Persist the Centraid-scoped working directory for this conversation. */
  onSetWorkspaceKind?: (kind: "vault-data" | "app" | "draft") => void;
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
  type: "segmented" | "swatch";
  value: string;
  options: { value: string; label: string }[];
}
export interface AppOrderRunDTO {
  kind: "idle" | "running" | "done";
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
  /** Initial settings destination for direct recovery links from an app. */
  initialTab?: "appearance" | "vault";
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
  | { kind: "divider"; text: string }
  | { kind: "status"; text: string; spinning: boolean }
  | { kind: "user"; text: string }
  | { kind: "ai"; paras: string[] }
  | { kind: "thinking"; text: string; streaming: boolean; header: string }
  | {
      kind: "toolGroup";
      id: string;
      label: string;
      open: boolean;
      running: boolean;
      error: boolean;
      rows: {
        state: "running" | "ok" | "error";
        verb: string;
        target: string;
      }[];
      change: { count: number; subtitle: string; version: string } | null;
    };
export interface BuilderProgressDTO {
  verb: string;
  file: string;
  sub: string;
  filled: number;
}
export interface BuilderChatSnapshot {
  view: "chat" | "history";
  messages: BuilderMsgDTO[];
  generating: boolean;
  /** Live turn progress; present only while `generating`. */
  progress: BuilderProgressDTO | null;
  suggestions: string[];
  /** `true` while a turn is in flight or before an app id exists. */
  composerDisabled: boolean;
  /** Bumps to force a history-view re-fetch after a version op. */
  historyNonce: number;
  context?: { used: number; size: number };
  model?: string;
  effort?: string;
  /** Capability-backed attended runner controls for this builder conversation. */
  runnerConfig?: AsstModelPickerDTO;
  workspaceKind: "vault-data" | "app" | "draft";
  workspaceKinds: Array<"vault-data" | "app" | "draft">;
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
  onSetView: (view: "chat" | "history") => void;
  onSetWorkspaceKind: (kind: "vault-data" | "app" | "draft") => void;
  onSetRunner: (runnerKind: AgentRunnerKind) => Promise<AsstModelPickerDTO>;
  onSetModel: (modelId: string) => void;
  onSetEffort: (effort: string) => void;
  /** Fill the version-history host — vanilla owns the async renderer. */
  onMountHistory: (host: HTMLElement) => void;
  /** Upload one file to the app's blob CAS (issue #420). When omitted, the
   *  composer's attach button is hidden (e.g. before the app exists). */
  onUploadAttachment?: (file: File) => Promise<BuilderAttachmentRef>;
}
