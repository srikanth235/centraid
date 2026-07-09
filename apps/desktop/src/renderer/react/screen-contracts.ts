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
  emoji?: string;
  category?: string;
  triggerKind?: 'cron' | 'webhook';
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
  callerKind: 'app' | 'agent' | 'owner-device';
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
}
export interface AuOverviewRunDTO {
  runId: string;
  automationId: string;
  ok: boolean;
  name: string;
  summary: string;
  whenLabel: string;
  metaLabel: string;
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

// ── Automation single-view ──────────────────────────────────────────────────
export interface AuViewRunDTO {
  runId: string;
  automationId: string | null;
  ok: boolean;
  summary: string;
  trigIcon: string;
  trigLabel: string;
  whenLabel: string;
  metaLabel: string;
  filterKey: 'cron' | 'webhook' | 'manual' | 'other';
}
export interface AutomationViewData {
  name: string;
  description: string | null;
  glyphIcon: string;
  hue: string;
  kindEyebrow: string;
  heroIcon: string;
  when: string;
  cronExprs: string[];
  nextRuns: string[];
  webhook: { pending: boolean; url: string | null } | null;
  enabled: boolean;
  statusKind: AuStatusKind;
  statusLabel: string;
  runs: AuViewRunDTO[];
  kpis: { total: string; successPct: string; avg: string; cost: string };
  behavior: { model: string; historyLabel: string; onFailure: string };
  tools: string[];
}
export interface AutomationViewBridgeProps {
  /** Load the automation + its runs. `null` = not found. */
  loadData: () => Promise<AutomationViewData | null>;
  onBack: () => void;
  onEdit: () => void;
  /** Confirm + delete; resolves true when deleted (view is navigating away). */
  onDelete: () => Promise<boolean>;
  /** Run now; resolves true when started (handing off to the run viewer). */
  onRun: () => Promise<boolean>;
  /** Toggle enabled; resolves true on success (the view reloads). */
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  onCopyWebhook: (url: string) => void;
  onOpenRun: (automationId: string, runId: string) => void;
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
export type AgentRunnerKind = 'codex' | 'claude-code';
export interface AgentModelDTO {
  id: string;
  name?: string;
  default?: boolean;
  tier?: 'smart' | 'balanced' | 'fast';
}
export interface AgentToolDTO {
  name: string;
  source: 'native' | 'mcp';
  server?: string;
  description?: string;
  hasArgs: boolean;
}
export interface AgentCardDTO {
  kind: AgentRunnerKind;
  title: string;
  accent: string;
  subtitle: string;
  connected: boolean;
  models: AgentModelDTO[];
  tools: AgentToolDTO[];
  modelsLoading: boolean;
  toolsLoading: boolean;
}
export interface AgentsStatusDTO {
  selectedKind: AgentRunnerKind;
  cards: AgentCardDTO[];
  anyLoading: boolean;
  savedModelByKind: Record<string, string>;
}
export interface SettingsProvidersBridgeProps {
  loadStatus: () => Promise<AgentsStatusDTO>;
  refreshModels: () => Promise<AgentsStatusDTO>;
  refreshTools: () => Promise<AgentsStatusDTO>;
  /** Switch the active agent; resolves true on success. */
  activateRunner: (kind: AgentRunnerKind) => Promise<boolean>;
  /** Persist this agent's default model ('' = gateway default). */
  setAgentModel: (kind: AgentRunnerKind, modelId: string) => void;
}

// ── Settings: profiles (spaces + connections) ───────────────────────────────
export interface ProfileRowDTO {
  id: string;
  name: string;
  icon: string;
  color: string;
  subLine: string;
  active: boolean;
  primordial: boolean;
}
export interface ConnectionRowDTO {
  id: string;
  displayName: string;
  sub: string;
  active: boolean;
  removable: boolean;
}
export interface SettingsProfilesBridgeProps {
  profiles: ProfileRowDTO[];
  connections: ConnectionRowDTO[];
  onSwitch: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onConnect: (id: string) => void;
  onRemoveConnection: (id: string) => void;
}

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
// The vanilla side owns the stream (streamAssistantTurn), the message model,
// and the rich-answer renderer; it pushes a snapshot to React on each change.
// Final AI answers carry pre-rendered HTML (from the vanilla `richAnswer`);
// React injects it and re-hydrates the interactive vault refs via `hydrateRefs`.
export interface AsstToolCallDTO {
  tool: string;
  sql?: string;
  state: 'run' | 'ok' | 'error';
  meta: string;
}
export type AsstMsgDTO =
  | { kind: 'user'; text: string }
  | { kind: 'tools'; label: string; calls: AsstToolCallDTO[] }
  | { kind: 'ai'; streaming: true; text: string }
  | { kind: 'ai'; streaming: false; html: string; error: boolean };
export interface AsstThreadDTO {
  id: string;
  title: string;
  timeLabel: string;
  active: boolean;
}
export interface AssistantSnapshot {
  threads: AsstThreadDTO[];
  empty: boolean;
  busy: boolean;
  messages: AsstMsgDTO[];
}
export interface AssistantBridgeProps {
  suggestions: string[];
  onReady: (update: (s: AssistantSnapshot) => void) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** `null` = new conversation. */
  onSelectThread: (id: string | null) => void;
  onDeleteThread: (id: string) => void;
  /** Wire the interactive vault refs inside a just-rendered answer node. */
  hydrateRefs: (node: HTMLElement) => void;
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
export interface BuilderChatBridgeProps {
  onReady: (update: (s: BuilderChatSnapshot) => void) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onToggleGroup: (id: string) => void;
  onSetView: (view: 'chat' | 'history') => void;
  /** Fill the version-history host — vanilla owns the async renderer. */
  onMountHistory: (host: HTMLElement) => void;
}

