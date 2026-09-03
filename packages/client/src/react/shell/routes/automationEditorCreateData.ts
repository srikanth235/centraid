import type {
  AuEditorTriggerDTO,
  AutomationEditorData,
} from "../../screen-contracts.js";
import type { AutomationHarnessEditorData } from "./automationEditorHarnessData.js";

export function buildCreateAutomationEditorData(opts: {
  template?: {
    name: string;
    desc: string;
    triggerKind?: "cron" | "webhook" | "data" | "condition";
  };
  watchEntity?: string;
  instructions: string;
  name: string;
  harness?: AutomationHarnessEditorData;
}): AutomationEditorData {
  const { template, watchEntity, instructions, name, harness } = opts;
  const triggers: AuEditorTriggerDTO[] =
    template?.triggerKind === "webhook"
      ? [{ id: null, kind: "webhook", pending: true }]
      : template?.triggerKind === "cron"
        ? [{ expr: "0 9 * * *", kind: "cron" }]
        : watchEntity
          ? [{ entities: [watchEntity], kind: "data" }]
          : [];
  return {
    automationId: null,
    connectors: null,
    consent: { grants: [], outbox: [], parked: [] },
    enabled: false,
    instructions: template?.desc ?? instructions,
    mode: "create",
    model: null,
    name: template?.name ?? name,
    onFailure: null,
    rowId: null,
    harness: null,
    triggers,
    webhook: null,
    ...harness,
  };
}
