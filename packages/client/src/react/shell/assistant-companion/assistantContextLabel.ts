import type { ShellRoute } from "../../../app-shell-context.js";

/** Member-facing page context for the companion chip. Persisted route ids are
 * deliberately translated here rather than exposed as product language. */
export function assistantContextLabel(route: ShellRoute): string {
  switch (route.kind) {
    case "home":
      return "Home";
    case "assistant":
      return "Assistant";
    case "approvals":
      return "Notifications";
    case "insights":
      return "Activity";
    case "atlas":
      return "Vault";
    case "household":
      return "Copies";
    case "gateway":
      return "System";
    case "storage":
      return "Storage moved to System";
    case "automations":
      return "Automations";
    case "connectors":
      return "Connectors";
    case "starred":
      return "Starred";
    case "settings":
      return "Settings";
    case "templates":
      return "Templates";
    case "run-view":
      return "Run details";
    case "automation-view":
    case "automation-builder":
    case "automation-editor":
      return "Automation";
    case "app":
      return "This app";
  }
}
