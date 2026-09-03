// governance: allow-repo-hygiene file-size-limit (#363) single source of truth for every renderer screen's prop-type contract (issue #325); splitting would scatter one cohesive DTO surface across files that all need to change together

import type { ColorKey } from "@centraid/design";

import type { ResourceUsageDTO } from "./screens/resource-summary.js";

export interface CatalogTemplate {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: "app" | "automation";
  emoji?: string;
  category?: string;
  triggerKind?: "cron" | "webhook" | "data" | "condition";
  triggerLabel?: string;
  integrations?: readonly string[];
}

export interface InsightsKpis {
  totalTokens: number;
  hydrationTokens: number;
  totalCostUsd: number;
  harnessReportedCostUsd: number;
  estimatedCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  failedRuns: number;
  failedCostUsd: number;
  appsTouched: number;
  unpricedRuns: number;
  unreportedRuns: number;
  medianRunMs?: number;
}
export interface InsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
  failedRuns: number;
  failedCostUsd: number;
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
export interface InsightsHarnessRow {
  harness: string;
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
  harness?: string;
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
  byHarness: InsightsHarnessRow[];
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
  resourceUsage?: ResourceUsageDTO;
}

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
export interface VaultData {
  vaultName: string;
  grants: VaultGrantDTO[];
  parked: VaultParkedDTO[];
  demo?: VaultDemoDTO;
}
export interface VaultBridgeProps {
  block: VaultBlockDTO;
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

export interface AutomationTemplatesBridgeProps {
  templates: readonly CatalogTemplate[];
  subtitle?: string;
  onPreview: (t: CatalogTemplate) => void;
  onStartFromScratch: () => void;
}

export interface PaletteTileDTO {
  background: string;
  glyphColor: string;
  boxShadow?: string;
}
export interface PaletteRowDTO {
  label: string;
  sub?: string;
  iconHtml: string;
  variant: "action" | "app" | "chat";
  appMark?: {
    colorKey: ColorKey;
    iconKey: string;
  };
  tile?: PaletteTileDTO;
  kind?: string;
  meta?: string;
  kbd?: string;
  accent?: boolean;
  run: () => void;
}
export interface PaletteGroupIconDTO {
  html: string;
  hue?: string;
}
export interface PaletteGroupDTO {
  group: string;
  icon?: PaletteGroupIconDTO;
  items: PaletteRowDTO[];
}
export interface PaletteBridgeProps {
  buildGroups: (query: string) => PaletteGroupDTO[];
  onClose: () => void;
  onReady?: (refresh: () => void) => void;
  suggestions?: () => string[];
}

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
  loadStatus: () => Promise<PhoneStatusDTO | null>;
  beginPairing: (
    onPaired: (deviceName: string) => void
  ) => Promise<{ info: PhonePairingDTO; cancel: () => void } | null>;
  revoke: (deviceId: string) => Promise<boolean>;
  showToast?: (message: string) => void;
}

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
  lastRunSummary: string | null;
  statusKind: AuStatusKind;
  statusLabel: string;
  lastRunOk: boolean | null;
  nextRunLabel: string | null;
  attentionCount: number;
  recentFailover?: boolean;
  systemLane?: "recognition";
}
export interface AuOverviewRunDTO {
  runId: string;
  automationId: string;
  ok: boolean;
  name: string;
  summary: string;
  whenLabel: string;
  metaLabel: string;
  startedAt: number;
  systemLane?: "recognition";
}
export interface AuOverviewData {
  rows: AuOverviewRowDTO[];
  runs: AuOverviewRunDTO[];
  health: { active: number; paused: number; drafts: number; attention: number };
  subtitle: string;
}
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
  loadSuggestions?: () => Promise<AuOverviewSuggestionDTO[]>;
  onUseSuggestion?: (templateId: string) => void;
}

export interface AuViewDataDetailDTO {
  entities: string[];
  everyLabel: string | null;
}
export interface AuViewConditionDetailDTO {
  entity: string;
  whereText: string;
  everyLabel: string | null;
}
export type ConsentKind = "outbox" | "parked" | "grant";
export type ConsentDecision = "approve" | "discard" | "revoke";
export interface ParkedItemDTO {
  invocationId: string;
  command: string;
  parkedAt: string;
  input: Record<string, unknown>;
}
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
export interface AuEditorConnectorsDTO {
  mcps: string[];
  secrets: string[];
  connector: string | null;
  vaultPurpose: string | null;
  vaultScopes: string[];
  connections?: Array<{ connectionId: string; kind: string; label: string }>;
}
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
  connection: {
    connectionId: string;
    label: string;
    principal: string | null;
    health: "ok" | "needs-auth" | "paused" | "failing";
  } | null;
  connections: Array<{
    connectionId: string;
    label: string;
    principal: string | null;
    health: "ok" | "needs-auth" | "paused" | "failing";
  }>;
}
export interface AutomationEditorData {
  mode: "create" | "edit";
  automationId: string | null;
  rowId?: string | null;
  name: string;
  instructions: string;
  triggers: AuEditorTriggerDTO[];
  enabled: boolean;
  webhook: { pending: boolean; url: string | null } | null;
  consent: AuConsentDTO;
  connectors?: AuEditorConnectorsDTO | null;
  onFailure?: string | null;
  model?: string | null;
  harness?: HarnessKind | null;
  defaultHarnessKind?: HarnessKind;
  defaultModel?: string | null;
  defaultCronTimeZone?: string | null;
  harnesses?: Array<{
    kind: HarnessKind;
    label: string;
    accent: string;
    connected: boolean;
    models: HarnessModelDTO[];
    defaultModel: string | null;
  }>;
}
export interface AutomationEditorSaveFields {
  name: string;
  instructions: string;
  triggers: AuEditorTriggerInput[];
  connections?: Array<{ connectionId: string; kind: string; label: string }>;
  harness?: HarnessKind | null;
  model?: string | null;
}
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

export interface CompileStepDTO {
  itemId: string;
  ordinal: number;
  kind: string;
  label: string;
  status: "ok" | "fail" | "running";
  durationMs: number | null;
  detail: string | null;
}

export interface CompileAttemptDTO {
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  status: "ok" | "fail" | "running";
  error: string | null;
  summary: string | null;
  whenLabel: string;
}

export interface TurnWatchOutcome {
  settled: boolean;
  ok: boolean;
}

export interface AutomationEditorBridgeProps {
  loadData: () => Promise<AutomationEditorData>;
  onSave: (fields: AutomationEditorSaveFields) => Promise<boolean>;
  onCompile: (enableOnSuccess?: boolean) => Promise<string | null>;
  loadCompileAttempts: () => Promise<CompileAttemptDTO[]>;
  loadTurnSteps: (turnId: string) => Promise<CompileStepDTO[]>;
  watchTurnSteps: (
    turnId: string,
    onSteps: (steps: CompileStepDTO[]) => void,
    signal: AbortSignal
  ) => Promise<TurnWatchOutcome>;
  onTestRun: () => Promise<string | null>;
  onSearchEntities: (term: string) => Promise<
    Array<{
      type: string;
      id: string;
      title: string | null;
      subtitle: string | null;
    }>
  >;
  loadEntityTypes?: () => Promise<string[]>;
  loadConnectorCatalog?: () => Promise<AuEditorCatalogConnectorDTO[]>;
  connectorsEnabled?: boolean;
  configureConnection?: (
    input: AuEditorConnectFormInput
  ) => Promise<{ connectionId: string } | void>;
  beginAuthorize?: (connectionId: string) => Promise<string>;
  showToast?: (message: string) => void;
  onReadSource: () => Promise<{
    manifest: string | null;
    handler: string | null;
  }>;
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  onDecideConsent: (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean
  ) => Promise<boolean>;
  onOpenRun: (runId: string) => void;
  onOpenRuns: () => void;
  onCopyWebhook: (url: string) => void;
  onRotateWebhook: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onCancel: () => void;
}

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
  entityTags: Array<{ type: string; id: string }>;
}
export type ThreadRunStatus = "ok" | "fail" | "running" | "pending";
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
  dateGroup: string;
}
export interface AuPlanStatusDTO {
  state: "ready" | "compiling" | "failed" | "never";
  label: string;
  detail: string | null;
}
export interface AutomationThreadData {
  header: AutomationThreadHeaderDTO;
  consent: AuConsentDTO;
  runs: ThreadRunDTO[];
  plan: AuPlanStatusDTO;
  automationTurns?: boolean;
  recognition?: {
    capability: string;
    selected: "deterministic" | "delegate";
    deterministicLabel: string;
    delegate: {
      model: string | null;
      latency: string;
      consequence: string;
    };
  };
}
export interface AutomationThreadBridgeProps {
  loadData: () => Promise<AutomationThreadData | null>;
  onBack: () => void;
  onOpenCompiler: () => void;
  onOpenRun: (runId: string) => void;
  loadTurnTrace: (turnId: string) => Promise<AsstMsgDTO[]>;
  watchTurn: (
    turnId: string,
    onMessages: (messages: AsstMsgDTO[]) => void,
    signal: AbortSignal
  ) => Promise<boolean>;
  onSetRecognitionStep?: (
    variant: "deterministic" | "delegate"
  ) => Promise<boolean>;
  onRunNow: () => Promise<string | null>;
  onToggleEnabled: (next: boolean) => Promise<boolean>;
  onDecideConsent: (
    kind: ConsentKind,
    id: string,
    decision: ConsentDecision,
    alwaysAllow?: boolean
  ) => Promise<boolean>;
  onAskAboutRuns: (
    text: string,
    options: {
      attachments?: BuilderAttachmentRef[];
      harnessKind?: HarnessKind;
      model?: string;
      thinking?: string;
      onContext?: (context: { used: number; size: number }) => void;
    },
    onMessages: (messages: AsstMsgDTO[]) => void,
    signal: AbortSignal
  ) => Promise<string | null>;
  onUploadAttachment?: (file: File) => Promise<BuilderAttachmentRef>;
  loadAttachmentImage?: (hash: string, mime: string) => Promise<string>;
  onSetHarness?: (harnessKind: HarnessKind) => Promise<AsstModelPickerDTO>;
  onCopyWebhook: (url: string) => void;
  onRotateWebhook: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

export type SettingsThemeMode = "light" | "dark" | "system";
export interface SettingsAppearanceBridgeProps {
  themeMode: SettingsThemeMode;
  onSetThemeMode: (mode: SettingsThemeMode) => void;
  automations?: boolean;
}

export type HarnessKind = string;
export interface HarnessModelDTO {
  id: string;
  name?: string;
  default?: boolean;
  tier?: "smart" | "balanced" | "fast";
}
export interface HarnessCardDTO {
  kind: HarnessKind;
  title: string;
  accent: string;
  subtitle: string;
  connected: boolean;
  models: HarnessModelDTO[];
  modelsLoading: boolean;
  sessionReady: boolean;
  sessionProbePending?: boolean;
  fallbackBlockedReason?: string;
  modelConfigurable?: boolean;
  supportsAttachments?: boolean;
  supportsContext?: boolean;
  configOptions?: Array<{
    id: string;
    category: string;
    type: string;
    values: Array<{ value: string; name?: string }>;
    currentValue?: string;
  }>;
  additionalDirectories?: boolean;
  capabilityChips?: string[];
  vaultUnavailable?: boolean;
  authRequired?: boolean;
  breakerStates?: Array<{
    failureClass: string;
    state: "open" | "half-open";
  }>;
}
export type ModelSubsystem = "assistant" | "ask" | "builder" | "automations";
export interface HarnessesStatusDTO {
  selectedKind: HarnessKind;
  cards: HarnessCardDTO[];
  anyLoading: boolean;
  savedModelByKind: Record<string, string>;
  subsystemModelByKind: Record<string, Partial<Record<ModelSubsystem, string>>>;
  defaultConfigPinsByKind: Record<string, Record<string, string>>;
  subsystemConfigPinsByKind: Record<
    string,
    Partial<Record<ModelSubsystem, Record<string, string>>>
  >;
  diagnosticsJson: string;
  subsystemHarnessByKey: Partial<Record<ModelSubsystem, HarnessKind>>;
  subsystemHarnessLadders: Partial<Record<ModelSubsystem, HarnessKind[]>>;
}
export type HarnessPrefWrite = Promise<string | null>;
export interface SettingsHarnessesBridgeProps {
  loadStatus: () => Promise<HarnessesStatusDTO>;
  refreshModels: () => Promise<HarnessesStatusDTO>;
  activateHarness: (kind: HarnessKind) => HarnessPrefWrite;
  setHarnessModel: (kind: HarnessKind, modelId: string) => HarnessPrefWrite;
  setSubsystemModel: (
    kind: HarnessKind,
    subsystem: ModelSubsystem,
    modelId: string
  ) => HarnessPrefWrite;
  setHarnessConfigPin: (
    kind: HarnessKind,
    category: string,
    value: string
  ) => HarnessPrefWrite;
  setSubsystemConfigPin: (
    kind: HarnessKind,
    subsystem: ModelSubsystem,
    category: string,
    value: string
  ) => HarnessPrefWrite;
  setSubsystemHarness: (
    subsystem: ModelSubsystem,
    kind: HarnessKind | ""
  ) => HarnessPrefWrite;
  setSubsystemHarnessLadder: (
    subsystem: ModelSubsystem,
    kinds: HarnessKind[]
  ) => HarnessPrefWrite;
  showToast: (message: string) => void;
}

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
  colorKey?: ColorKey;
  tile?: HomeTileDTO;
  tone: "new" | null;
  stamp: string;
  starred: boolean;
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
  deleted: boolean;
  triggerLabel: string;
  triggersSummary: string;
  triggerHeroIcon: string;
  promptInstr: string;
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
  onReady: (update: (snap: RunViewSnapshot | null) => void) => void;
  onBack: () => void;
  onOpenAutomation: () => void;
  onRunAgain: () => void;
  onSetMode: (m: "timeline" | "log") => void;
}

export interface AsstToolCallDTO {
  tool: string;
  sql?: string;
  state: "run" | "ok" | "error";
  meta: string;
  outputText?: string;
  artifacts?: Array<{ label: string; hash?: string; workspacePath?: string }>;
}
export interface AsstAttachmentDTO {
  hash: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}
export interface AsstRetryDTO {
  index: number;
  count: number;
}
export interface AsstUsageDTO {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  estimated?: boolean;
  model?: string;
  effort?: string;
}
export type AsstMsgDTO =
  | {
      kind: "user";
      text: string;
      attachments?: AsstAttachmentDTO[];
      createdAt?: number;
      msgId?: string;
    }
  | { kind: "tools"; label: string; calls: AsstToolCallDTO[]; msgId?: string }
  | { kind: "thinking"; text: string; streaming: boolean; msgId?: string }
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
      copyText: string;
      usage?: AsstUsageDTO;
      createdAt?: number;
      turnId?: string;
      feedback?: "up" | "down" | null;
      retry?: AsstRetryDTO;
      canRegenerate?: boolean;
      canRetry?: boolean;
      offline?: boolean;
      msgId?: string;
    };
export interface AsstPendingAttachmentDTO {
  id: string;
  filename: string;
  sizeBytes: number;
  state: "uploading" | "ready" | "error";
  errorText?: string;
  mime?: string;
  previewUrl?: string;
}
export interface AssistantSnapshot {
  empty: boolean;
  busy: boolean;
  messages: AsstMsgDTO[];
  pendingAttachments: AsstPendingAttachmentDTO[];
  context?: { used: number; size: number };
  additionalDirectories?: string[];
  workspaceKind?: "vault-data" | "app" | "draft";
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  harnessReady?: boolean;
  pickerRevision?: number;
}
export interface AsstModelOptionDTO {
  id: string;
  name?: string;
  default?: boolean;
}
export interface AsstModelPickerDTO {
  harnesses: Array<{
    kind: HarnessKind;
    title: string;
    connected: boolean;
    sessionReady: boolean;
    sessionProbePending?: boolean;
    hint?: string;
  }>;
  selectedHarnessKind: HarnessKind;
  workspaceKinds: Array<"vault-data" | "app" | "draft">;
  connected: boolean;
  models: AsstModelOptionDTO[];
  defaultModelName: string;
  selectedModelId: string;
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
  conversationId?: string;
  onReady: (update: (s: AssistantSnapshot) => void) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onLoadEarlier?: () => void;
  onAttachFiles: (files: File[]) => void;
  onRemovePendingAttachment: (id: string) => void;
  onAddWorkspace?: () => void;
  onRemoveWorkspace?: (directory: string) => void;
  hydrateRefs: (node: HTMLElement) => void;
  wireCodeCopy: (node: HTMLElement) => void;
  loadAttachmentImage: (hash: string, mime: string) => Promise<string>;
  onCopyMessage: (text: string) => void;
  onFeedback: (turnId: string, value: "up" | "down") => void;
  onRegenerate: () => void;
  onRetryError: (messageIndex: number) => void;
  onPagerNav: (messageIndex: number, delta: number) => void;
  loadModelPicker: () => Promise<AsstModelPickerDTO>;
  onSetModel: (modelId: string) => void;
  onSetEffort: (effort: string) => void;
  onSetHarness: (harnessKind: HarnessKind) => Promise<AsstModelPickerDTO>;
  onSetWorkspaceKind?: (kind: "vault-data" | "app" | "draft") => void;
  searchEntities?: (term: string) => Promise<AsstComposerEntity[]>;
  slashCommands?: AsstSlashCommand[];
  onRunSlash?: (id: string) => void;
}

export interface AsstComposerEntity {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
}

export interface AsstSlashCommand {
  id: string;
  label: string;
  hint?: string;
  enabled?: boolean;
}

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
  appMark?: {
    colorKey: ColorKey;
    iconKey: string;
  };
  iconSvg?: string;
  iconBg?: string;
  iconColor?: string;
  iconShadow?: string | null;
  accent: string;
  vaultVisible: boolean;
  automationsBadge: number | null;
  vaultBadge: number | null;
  knobs: AppKnobDTO[] | null;
  orders: AppOrderDTO[];
}
export interface AppSettingsBridgeProps {
  initialTab?: "appearance" | "vault";
  automationsVisible?: boolean;
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
  bundled?: boolean;
  onMountRuns: (ref: string, host: HTMLElement) => void;
  onMountVault: (host: HTMLElement) => void;
  onMountEnrichment?: (host: HTMLElement) => void;
}

export interface BuilderAttachmentRef {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
}
