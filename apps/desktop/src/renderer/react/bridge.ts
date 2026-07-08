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

export interface CentraidReactBridge {
  /** Mount the React Discover screen into `host`; returns an unmount disposer. */
  mountDiscover(host: HTMLElement, props: DiscoverBridgeProps): () => void;
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
