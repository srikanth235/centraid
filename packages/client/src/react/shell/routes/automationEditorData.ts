// Automation editor data — LOAD half only (#387). Save lives in AutomationEditorRoute.tsx.
import { readAutomation } from "../../../gateway-client.js";
import type { AuEditorConnectorsDTO } from "../../screen-contracts.js";

export interface AutomationEditorLoadResult {
  row: CentraidAutomationRow | null;
  name: string;
  instructions: string;
  triggers: CentraidAutomationRow["triggers"];
  /** `row.id`, distinct from `row.ref`. */
  rowId: string | null;
  connectors: AuEditorConnectorsDTO | null;
  onFailure: string | null;
  harness: string | null;
  model: string | null;
}

const DEFAULT_EDITOR_LOAD: AutomationEditorLoadResult = {
  connectors: null,
  instructions: "",
  model: null,
  name: "",
  onFailure: null,
  row: null,
  rowId: null,
  harness: null,
  triggers: [],
};

/** Manifest fields the renderer's ambient type doesn't declare yet — drop once it catches up. */
interface ManifestConnectorExtra {
  requires: { secrets?: readonly string[]; harness?: string };
  connector?: {
    kind: string;
    label: string;
    principal?: string;
    connectionId?: string;
  };
  connections?: readonly {
    connectionId: string;
    kind: string;
    label: string;
  }[];
  vault?: {
    purpose: string;
    why?: string;
    scopes: readonly {
      schema: string;
      table?: string;
      verbs: string;
      rowFilter?: readonly { column: string; op: string; value?: unknown }[];
      fieldMask?: readonly string[];
    }[];
  };
}

function vaultScopeLabel(s: {
  schema: string;
  table?: string;
  verbs: string;
  rowFilter?: readonly unknown[];
  fieldMask?: readonly string[];
}): string {
  const extent = [
    s.rowFilter ? `${s.rowFilter.length} row rule` : "",
    s.fieldMask ? `${s.fieldMask.length} fields` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${s.schema}${s.table ? `.${s.table}` : ""} ${s.verbs}${extent ? ` · ${extent}` : ""}`;
}

function deriveConnectors(row: CentraidAutomationRow): AuEditorConnectorsDTO {
  const manifest = row.manifest as CentraidAutomationRow["manifest"] &
    ManifestConnectorExtra;
  const vault = manifest.vault;
  const bindings: Array<{ connectionId: string; kind: string; label: string }> =
    [];
  if (manifest.connections) {
    for (const b of manifest.connections) {
      bindings.push({
        connectionId: b.connectionId,
        kind: b.kind,
        label: b.label,
      });
    }
  }
  if (manifest.connector?.connectionId) {
    bindings.push({
      connectionId: manifest.connector.connectionId,
      kind: manifest.connector.kind,
      label: manifest.connector.label,
    });
  }
  return {
    connector: manifest.connector?.label ?? null,
    connections: bindings,
    mcps: [...(manifest.requires.mcps ?? [])],
    secrets: [...(manifest.requires.secrets ?? [])],
    vaultPurpose: vault?.purpose ?? null,
    vaultScopes: vault ? vault.scopes.map(vaultScopeLabel) : [],
  };
}

/** Edit-mode fields, or defaults for create / unresolved `automationId`. */
export async function loadAutomationEditorData(input: {
  automationId?: string;
}): Promise<AutomationEditorLoadResult> {
  if (!input.automationId) return DEFAULT_EDITOR_LOAD;
  const row = await readAutomation({ automationId: input.automationId });
  if (!row) return DEFAULT_EDITOR_LOAD;
  // Source of truth is `row.manifest.prompt`. Cast checks a top-level
  // `row.prompt` first so this keeps working if it appears. Drop once ambient.
  const withPrompt = row as CentraidAutomationRow & { prompt?: string };
  return {
    connectors: deriveConnectors(row),
    instructions: withPrompt.prompt ?? row.manifest.prompt ?? "",
    model: row.manifest.requires.model ?? null,
    name: row.name,
    onFailure: row.manifest.onFailure ?? null,
    row,
    rowId: row.id,
    harness: row.manifest.requires.harness ?? null,
    triggers: row.triggers,
  };
}
