import type {
  HarnessUsageSnapshot,
  HarnessKind,
  ToolContext,
  TurnAttachment,
  TurnStreamEvent,
} from "@centraid/server/engine";

export interface AcpTurnInput {
  conversationId?: string;
  cwd: string;
  message: string;
  attachments?: TurnAttachment[];
  toolContext?: ToolContext;
  extraSystemPrompt: string;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  permissionPolicy?: "auto-allow" | "deny";
  prevSessionId?: string;
  prevUsageSnapshot?: HarnessUsageSnapshot;
  hydrationContext?: string;
  hydrationAttachments?: TurnAttachment[];
  recoveryHydrationContext?: string;
  recoveryHydrationAttachments?: TurnAttachment[];
  forceHydration?: boolean;
  additionalDirectories?: string[];
  extraPath?: string;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface AcpAdapterSpec {
  readonly packageName: string;
  readonly binPathEnvVar?: string;
  readonly sessionModeId?: string;
  readonly bypassNeedsSandboxWhenRoot?: boolean;
}

export interface AcpTurnConfig {
  kind: HarnessKind;
  label?: string;
  installHint?: string;
  defaultBin?: string;
  acpArgs: string[];
  binPath?: string;
  extraArgs?: string[];
  env?: Readonly<Record<string, string>>;
  adapter?: AcpAdapterSpec;
  resolveModel?: (model: string) => string;
  stageTimeoutMs?: number;
  promptIdleTimeoutMs?: number;
}

export interface AcpTurnResult {
  sessionId?: string;
  usageSnapshot?: HarnessUsageSnapshot;
  hydrated?: boolean;
  hydrationKind?: "handoff" | "recovery";
}
