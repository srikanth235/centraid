// Shared renderer types: appearance prefs, routes, shell metadata.
export type ThemeName = keyof typeof window.CentraidTokens.themes;
export type ThemeMode = ThemeName | "system";
export type TileVariant = "solid" | "gradient" | "glassy" | "flat";
export type CardVariant = "flat" | "outlined" | "elevated";

export type GatewayProfile = Awaited<
  ReturnType<typeof window.CentraidApi.listGateways>
>[number];

/** No per-owner colour override (#707): the shell spends no hue. */
export interface AppearancePrefs {
  themeMode: ThemeMode;
  theme: ThemeName;
  tileVariant: TileVariant;
  cardVariant: CardVariant;
}

export type ShellRoute =
  | { kind: "home" }
  // `string`, not the page union, to avoid a type-only import cycle.
  | { kind: "settings"; page?: string }
  | { kind: "assistant"; conversationId?: string }
  | { kind: "insights" }
  | { kind: "starred" }
  | { kind: "automations" }
  | { kind: "connectors" }
  | { kind: "approvals" }
  | {
      kind: "gateway";
      /** ROUTES, not local state, so the frame's back arrow works. */
      tab?:
        | "overview"
        | "components"
        | "storage"
        | "logs"
        | "alerts"
        | "restart";
      focus?: "backups" | "capacity";
      cause?: "backup-alert";
    }
  | { kind: "household" }
  | { kind: "storage" }
  | { kind: "atlas" }
  | { kind: "templates" }
  // `templateId`/`watchEntity` seed the initial DTO only: excluded from
  // `routeKey`, so neither survives the first paint.
  | {
      kind: "automation-editor";
      automationId?: string;
      templateId?: string;
      watchEntity?: string;
    }
  | { automationId: string; kind: "automation-view" }
  | { automationId: string; kind: "run-view"; runId: string }
  | { id: string; kind: "app" }
  | { automationId: string; kind: "automation-builder"; seedMessage?: string };

export interface GatewaySummary {
  activeId: string;
  activeKind: "local" | "remote";
  activeLabel: string;
  activeDisplayName: string;
  activeAvatarColor: string;
}

// Mirror of blueprints' `TemplateMeta`, not an import: IPC carries JSON.
export interface TemplateEntry {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: "app" | "automation";
  /** Always true for a mounted vault; an unmounted audience says `false`. */
  installed?: boolean;
  vault?: TemplateVaultBlock;
  emoji?: string;
  category?: string;
  triggerKind?: "cron" | "webhook" | "data" | "condition";
  triggerLabel?: string;
  integrations?: readonly string[];
}

export interface TemplateVaultBlock {
  purpose?: string;
  why?: string;
  scopes: Array<{
    schema: string;
    table?: string;
    verbs: string;
    rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
    fieldMask?: string[];
  }>;
}

export type AutomationRunState =
  | { kind: "running" }
  | {
      kind: "done";
      ok: boolean;
      durationMs: number;
      error?: string;
      finishedAt: number;
    };
