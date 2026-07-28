import type {
  AuEditorTriggerDTO,
  AutomationEditorData,
} from "../../screen-contracts.js";
import type { AutomationAgentEditorData } from "./automationEditorAgentData.js";

/** Pure create-mode DTO builder for template/watch-entity prefills. */
export function buildCreateAutomationEditorData(opts: {
  template?: {
    name: string;
    desc: string;
    triggerKind?: "cron" | "webhook" | "data" | "condition";
  };
  watchEntity?: string;
  instructions: string;
  name: string;
  agent?: AutomationAgentEditorData;
}): AutomationEditorData {
  const { template, watchEntity, instructions, name, agent } = opts;
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
    runner: null,
    triggers,
    webhook: null,
    ...agent,
  };
}
