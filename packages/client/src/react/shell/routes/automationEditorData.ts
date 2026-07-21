// Automation editor data layer — LOAD half only (Automations UI revamp, see
// receipts/issue-387-automations-ui-revamp.md). Seeded by Foundation-renderer so the editor
// route/screen have something real to compile against; Lane B (editor) owns
// this file per the brief's file-ownership table and is expected to extend
// it with the save flow (`updateAutomation`/`createAutomation` wiring,
// webhook mint/rotate, consent-tab derivation) rather than start from
// scratch. Kept intentionally thin: just enough to resolve `{ row, name,
// instructions, triggers }` for edit mode, and defaults for create mode.
import { readAutomation } from '../../../gateway-client.js';
import type { AuEditorConnectorsDTO } from '../../screen-contracts.js';

export interface AutomationEditorLoadResult {
  /** `null` for create mode (no `automationId` in the route yet). */
  row: CentraidAutomationRow | null;
  name: string;
  /** Manifest `prompt` — the natural-language instructions the builder
   *  compiles into `handler.js`. */
  instructions: string;
  triggers: CentraidAutomationRow['triggers'];
  /** `row.id` — see `AutomationEditorData.rowId` (screen-contracts.ts) for
   *  why this is distinct from `row.ref`. `null` in create mode. */
  rowId: string | null;
  /** Connectors tab data, derived from the manifest. `null` in create mode. */
  connectors: AuEditorConnectorsDTO | null;
  /** Manifest `onFailure`, `null` when unset or in create mode. */
  onFailure: string | null;
  /** Manifest `requires.model` falling back to `costEstimate.model`,
   *  `null` when neither is set or in create mode. */
  model: string | null;
}

const DEFAULT_EDITOR_LOAD: AutomationEditorLoadResult = {
  connectors: null,
  instructions: '',
  model: null,
  name: '',
  onFailure: null,
  row: null,
  rowId: null,
  triggers: [],
};

/** The manifest fields `deriveConnectors`/`loadAutomationEditorData` read
 *  that the renderer's ambient `CentraidAutomationManifest` type
 *  (`centraid-api.d.ts`) doesn't declare yet — `requires.secrets`,
 *  `connector`, and `vault` all validate server-side
 *  (`packages/automation/src/manifest/manifest.ts`) but haven't been added
 *  to the renderer's stale mirror. Same "cast past a stale ambient type"
 *  pattern as the `prompt` cast below; drop once the ambient type catches
 *  up. */
interface ManifestConnectorExtra {
  requires: { secrets?: readonly string[] };
  connector?: { kind: string; label: string; principal?: string };
  vault?: {
    purpose: string;
    why?: string;
    scopes: readonly { schema: string; table?: string; verbs: string }[];
  };
}

/** One compact string per vault scope — e.g. `"core.event read"` — mirroring
 *  the schema[.table] + verbs convention `approvalsData.ts`'s
 *  `scopeSummary`/`VaultScreen.tsx`'s `scopeLabel` already use for the same
 *  `{schema, table?, verbs}` shape elsewhere in the app. */
function vaultScopeLabel(s: { schema: string; table?: string; verbs: string }): string {
  return `${s.schema}${s.table ? `.${s.table}` : ''} ${s.verbs}`;
}

function deriveConnectors(row: CentraidAutomationRow): AuEditorConnectorsDTO {
  const manifest = row.manifest as CentraidAutomationRow['manifest'] & ManifestConnectorExtra;
  const vault = manifest.vault;
  return {
    connector: manifest.connector?.label ?? null,
    mcps: [...(manifest.requires.mcps ?? [])],
    secrets: [...(manifest.requires.secrets ?? [])],
    vaultPurpose: vault?.purpose ?? null,
    vaultScopes: vault ? vault.scopes.map(vaultScopeLabel) : [],
  };
}

/**
 * Load an automation's editable fields for edit mode, or defaults for
 * create mode (`automationId` omitted). `automationId` not resolving (stale
 * deep link, deleted automation) also falls back to defaults rather than
 * throwing — the editor route decides whether that's a silent "start
 * fresh" or a toast, same as `AutomationViewRoute.tsx`'s `null`-row handling.
 */
export async function loadAutomationEditorData(input: {
  automationId?: string;
}): Promise<AutomationEditorLoadResult> {
  if (!input.automationId) return DEFAULT_EDITOR_LOAD;
  const row = await readAutomation({ automationId: input.automationId });
  if (!row) return DEFAULT_EDITOR_LOAD;
  // `row.manifest.prompt` is the source of truth for instructions (same
  // field runViewData.ts's `promptInstr` reads). A top-level `row.prompt`
  // convenience field was floated during the revamp but never added — the
  // local cast checks it first purely so this keeps working if it appears,
  // falling back to the real manifest field.
  // Drop the cast once `prompt` lands on the ambient row type for real.
  const withPrompt = row as CentraidAutomationRow & { prompt?: string };
  return {
    connectors: deriveConnectors(row),
    instructions: withPrompt.prompt ?? row.manifest.prompt ?? '',
    model: row.manifest.requires.model ?? row.manifest.costEstimate?.model ?? null,
    name: row.name,
    onFailure: row.manifest.onFailure ?? null,
    row,
    rowId: row.id,
    triggers: row.triggers,
  };
}
