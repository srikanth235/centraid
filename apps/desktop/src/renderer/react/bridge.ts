// The vanilla↔React handoff seam (issue #325, Phase 3).
//
// The renderer is two independently-loaded module graphs: the vanilla shell
// (tsc → per-file ES modules) and the React bundle (Vite → react-boot.js).
// They can't `import` each other, so converted screens meet here: react-boot
// publishes `window.CentraidReact` with one `mount<Screen>` per converted
// screen, and the vanilla route module (still owning routing/teardown) calls
// it, mounts the returned React tree into the page container, and registers the
// returned disposer as the page's cleanup. If the bundle is missing the vanilla
// module falls back to its own render, so the app is runnable at every commit.

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

// ── Onboarding (first run) ──────────────────────────────────────────────────
export interface OnboardingCompleteInput {
  displayName: string;
  avatarColor: string;
}
export interface OnboardingBridgeProps {
  onComplete: (input: OnboardingCompleteInput) => Promise<void> | void;
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

export interface CentraidReactBridge {
  /** Mount the React Discover screen into `host`; returns an unmount disposer. */
  mountDiscover(host: HTMLElement, props: DiscoverBridgeProps): () => void;
  /** Mount the React Assistant copilot (streaming); returns a disposer. */
  mountAssistant(host: HTMLElement, props: AssistantBridgeProps): () => void;
  /** Mount the React automation run-viewer (SSE-driven); returns a disposer. */
  mountRunView(host: HTMLElement, props: RunViewBridgeProps): () => void;
  /** Mount the React Home screen (composer hero + unified library grid). */
  mountHome(host: HTMLElement, props: HomeBridgeProps): () => void;
  /** Mount the React Settings → Spaces (profiles + connections) page. */
  mountSettingsProfiles(host: HTMLElement, props: SettingsProfilesBridgeProps): () => void;
  /** Mount the React Settings → Providers (agents) page; returns a disposer. */
  mountSettingsProviders(host: HTMLElement, props: SettingsProvidersBridgeProps): () => void;
  /** Mount the React Settings → Appearance page; returns an unmount disposer. */
  mountSettingsAppearance(host: HTMLElement, props: SettingsAppearanceBridgeProps): () => void;
  /** Mount the React Settings → Layout page; returns an unmount disposer. */
  mountSettingsLayout(host: HTMLElement, props: SettingsLayoutBridgeProps): () => void;
  /** Mount the React automation single-view; returns an unmount disposer. */
  mountAutomationView(host: HTMLElement, props: AutomationViewBridgeProps): () => void;
  /** Mount the React Automations overview; returns an unmount disposer. */
  mountAutomationsOverview(host: HTMLElement, props: AutomationsOverviewBridgeProps): () => void;
  /** Mount the React first-run onboarding view; returns an unmount disposer. */
  mountOnboarding(host: HTMLElement, props: OnboardingBridgeProps): () => void;
  /** Mount the React Import settings pane; returns an unmount disposer. */
  mountImport(host: HTMLElement, props: ImportBridgeProps): () => void;
  /** Mount the React Phone settings pane; returns an unmount disposer. */
  mountPhone(host: HTMLElement, props: PhoneBridgeProps): () => void;
  /** Mount the React command palette overlay; returns an unmount disposer. */
  mountPalette(host: HTMLElement, props: PaletteBridgeProps): () => void;
  /** Mount the React automation-templates gallery; returns an unmount disposer. */
  mountAutomationTemplates(host: HTMLElement, props: AutomationTemplatesBridgeProps): () => void;
  /** Mount the React Insights dashboard into `host`; returns an unmount disposer. */
  mountInsights(host: HTMLElement, props: InsightsBridgeProps): () => void;
  /** Mount the React Vault consent pane into `host`; returns an unmount disposer. */
  mountVault(host: HTMLElement, props: VaultBridgeProps): () => void;
}

declare global {
  interface Window {
    CentraidReact?: CentraidReactBridge;
  }
}
