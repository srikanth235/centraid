// The one human name for each Centraid-owned workspace root. Both chat surfaces
// (builder pane + assistant composer) render the same selector, and the raw
// token ('vault-data') is not something to show a user.

const WORKSPACE_KIND_LABELS: Record<"vault-data" | "app" | "draft", string> = {
  "vault-data": "Vault data",
  app: "Live app",
  draft: "Draft",
};

export function workspaceKindLabel(kind: string): string {
  return (
    WORKSPACE_KIND_LABELS[kind as keyof typeof WORKSPACE_KIND_LABELS] ?? kind
  );
}
