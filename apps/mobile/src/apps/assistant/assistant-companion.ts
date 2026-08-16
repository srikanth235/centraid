export const ASSISTANT_COMPANION_PRESENTATION = "bottom-sheet" as const;
export const ASSISTANT_COMPANION_HEIGHT = "86%" as const;
export const ASSISTANT_COMPANION_TOUCH_TARGET = 44;

/** A compact turn needs real text before it can enter the shared ledger. */
export function companionSubmitText(
  draft: string,
  sending: boolean
): string | undefined {
  const text = draft.trim();
  return !sending && text ? text : undefined;
}

const PAGE_LABELS: Readonly<Record<string, string>> = {
  Agenda: "Agenda",
  Automations: "Automations",
  Connectors: "Connectors",
  Data: "Vault",
  Devices: "Copies",
  Docs: "Documents",
  Home: "Home",
  Insights: "Activity",
  Locker: "Locker",
  Notes: "Notes",
  People: "People",
  Photos: "Photos",
  Settings: "Settings",
  Tally: "Tally",
  Tasks: "Tasks",
};

export function companionPageContext(routeName: string | undefined): string {
  return (routeName && PAGE_LABELS[routeName]) || "Current page";
}

export function companionConsequence(
  pageContext: string | undefined,
  attachmentCount: number,
  harness: { kind: string; label: string; available: boolean } | undefined
): string {
  if (!harness) return "Checking the selected harness — nothing is sent yet.";
  if (!harness.available)
    return `${harness.label} is unavailable — choose an available harness to send.`;
  const provider = companionProviderLabel(harness.kind, harness.label);
  const inputs = [
    pageContext ? `${pageContext} context` : undefined,
    attachmentCount > 0
      ? `${String(attachmentCount)} attachment${attachmentCount === 1 ? "" : "s"}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  return inputs.length > 0
    ? `${harness.label} sends what you ask and the inputs listed below to ${provider}. This turn includes ${inputs.join(" and ")} and is saved in your Assistant ledger.`
    : `${harness.label} sends what you ask to ${provider}. This turn is saved in your Assistant ledger.`;
}

export function companionProviderLabel(kind: string, label: string): string {
  switch (kind) {
    case "codex":
      return "OpenAI";
    case "claude-code":
      return "Anthropic";
    case "gemini":
      return "Google";
    case "grok":
      return "xAI";
    default:
      return `${label}'s configured provider`;
  }
}
