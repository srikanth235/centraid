import type { JSX } from 'react';

// Small helpers shared by BuilderAutomationPane.tsx (Flow/Runs/Code/root) and
// BuilderAutomationConfigView.tsx (Config) — split out so neither of those
// files re-implements the same formatting logic, without pulling either one
// into an import cycle with the other.

/** Inline glyph span carrying a raw icon SVG string. */
export function Glyph({ svg, className }: { svg: string; className?: string }): JSX.Element {
  return (
    <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

// Relative "Nd ago" from an epoch-ms timestamp (builder.ts `relTime`).
export function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Human retention label from the manifest's history.keep (builder.ts `fmtRetention`).
export function fmtRetention(keep: CentraidAutomationManifest['history']['keep']): string {
  if (keep === 'all') return 'Keep all runs';
  if (keep === 'errors') return 'Keep failed runs only';
  if (typeof keep === 'object' && 'count' in keep) return `Last ${keep.count} runs`;
  if (typeof keep === 'object' && 'days' in keep) return `Last ${keep.days} days`;
  return '—';
}

export function fmtNextRun(d: Date): string {
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Title-Case label for a run's trigger source (GAP 3). Mirrors the mapping
 * automationsData.ts:229-238 uses for the Automations Overview screen —
 * `triggerOrigin` when present, falling back to `triggerKind` so an older
 * run recorded before `triggerOrigin` existed still reads sensibly.
 */
export function runOriginLabel(r: CentraidAutomationRunRecord): string {
  if (r.triggerOrigin === 'webhook') return 'Webhook';
  if (r.triggerOrigin === 'data') return 'Data';
  if (r.triggerOrigin === 'condition') return 'Condition';
  if (r.triggerKind === 'manual') return 'Manual';
  return 'Cron';
}

/**
 * True when the manifest already carries a `vault` access block. `vault`
 * isn't in the ambient `CentraidAutomationManifest` type the desktop
 * renderer declares (apps/desktop/src/renderer/centraid-api.d.ts) but IS a
 * real field on the JSON the gateway returns (packages/automation/src/
 * manifest/manifest.ts `Manifest.vault`) — read it structurally.
 */
export function manifestHasVault(m: CentraidAutomationManifest): boolean {
  return (m as unknown as Record<string, unknown>).vault !== undefined;
}

/** One requested vault scope (packages/automation/src/manifest/manifest.ts `ManifestVaultScope`). */
export interface ManifestVaultScope {
  readonly schema: string;
  readonly table?: string;
  readonly verbs: 'read' | 'read+act' | 'act' | 'reveal';
}

/** The automation's requested vault access (`ManifestVault`) — see `manifestHasVault`'s note on why this reads structurally. */
export interface ManifestVaultBlock {
  readonly purpose: string;
  readonly why?: string;
  readonly scopes: readonly ManifestVaultScope[];
}

/** The manifest's `vault` block, typed — `undefined` when `manifestHasVault` is false. */
export function getVaultBlock(m: CentraidAutomationManifest): ManifestVaultBlock | undefined {
  return (m as unknown as { vault?: ManifestVaultBlock }).vault;
}
