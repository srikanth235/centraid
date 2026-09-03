/*
 * governance: allow-repo-hygiene file-size-limit — a per-kind dispatch table
 * that grows one entry per HarnessKind by design. Split into a data module
 * before it doubles, not per added kind.
 *
 * NOTHING ELSE BRANCHES ON THE KIND: `runTurn`, preflight and model enumeration
 * all read `HARNESSES`, over one integration path. Kinds differ only in how the
 * ACP process is launched — natively or through a pinned adapter, never an
 * `npx -y` fetch (docs/harnesses.md).
 */

import type {
  RunTurnFn,
  HarnessKind,
  HarnessModel,
  TurnConfig,
  TurnInput,
  TurnResult,
} from "@centraid/server/engine";

import { runAcpTurn } from "./backends/acp/backend.js";
import type { AcpAdapterSpec, AcpTurnConfig } from "./backends/acp/backend.js";
import { enumerateAcpModels } from "./backends/acp/enumerate-models.js";
import { resolveClaudeModel } from "./models/tiers.js";

export interface HarnessVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface EnumeratePrefs {
  binPath?: string;
  extraArgs?: string[];
}

export interface HarnessSpec {
  readonly kind: HarnessKind;
  readonly label: string;
  readonly defaultBin?: string;
  readonly minVersion: HarnessVersion;
  readonly installHint: string;
  readonly runTurn: RunTurnFn;
  readonly enumerateModels: (prefs: EnumeratePrefs) => Promise<HarnessModel[]>;
}

interface AcpHarnessSpec {
  kind: HarnessKind;
  label: string;
  defaultBin?: string;
  acpArgs: string[];
  minVersion: HarnessVersion;
  installHint: string;
  env?: Readonly<Record<string, string>>;
  adapter?: AcpAdapterSpec;
  resolveModel?: (model: string) => string;
  probeModels?: boolean;
}

export function buildAcpConfig(
  spec: AcpHarnessSpec,
  prefs: { binPath?: string; extraArgs?: string[] }
): AcpTurnConfig {
  return {
    kind: spec.kind,
    label: spec.label,
    installHint: spec.installHint,
    acpArgs: spec.acpArgs,
    ...(spec.defaultBin ? { defaultBin: spec.defaultBin } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.adapter ? { adapter: spec.adapter } : {}),
    ...(spec.resolveModel ? { resolveModel: spec.resolveModel } : {}),
    ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
    ...(prefs.extraArgs?.length ? { extraArgs: prefs.extraArgs } : {}),
  };
}

const ACP_SPECS = new Map<HarnessKind, AcpHarnessSpec>();

export function acpConfigFor(
  kind: HarnessKind,
  prefs: { binPath?: string; extraArgs?: string[] }
): AcpTurnConfig {
  const spec = ACP_SPECS.get(kind);
  if (!spec)
    throw new Error(`no harness spec registered for kind "${String(kind)}"`);
  return buildAcpConfig(spec, prefs);
}

function makeAcpHarness(spec: AcpHarnessSpec): HarnessSpec {
  ACP_SPECS.set(spec.kind, spec);
  return {
    kind: spec.kind,
    label: spec.label,
    ...(spec.defaultBin ? { defaultBin: spec.defaultBin } : {}),
    minVersion: spec.minVersion,
    installHint: spec.installHint,
    runTurn: async (
      input: TurnInput,
      config: TurnConfig
    ): Promise<TurnResult> => {
      const { prefs } = config;
      const acpConfig = buildAcpConfig(spec, prefs);
      const result = await runAcpTurn(
        {
          cwd: input.cwd,
          ...(input.conversationId
            ? { conversationId: input.conversationId }
            : {}),
          message: input.message,
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          ...(input.toolContext ? { toolContext: input.toolContext } : {}),
          extraSystemPrompt: input.extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(input.configPins ? { configPins: input.configPins } : {}),
          ...(input.permissionPolicy
            ? { permissionPolicy: input.permissionPolicy }
            : {}),
          ...(input.prevSessionId
            ? { prevSessionId: input.prevSessionId }
            : {}),
          ...(input.prevUsageSnapshot
            ? { prevUsageSnapshot: input.prevUsageSnapshot }
            : {}),
          ...(input.hydrationContext
            ? { hydrationContext: input.hydrationContext }
            : {}),
          ...(input.hydrationAttachments?.length
            ? { hydrationAttachments: input.hydrationAttachments }
            : {}),
          ...(input.recoveryHydrationContext
            ? { recoveryHydrationContext: input.recoveryHydrationContext }
            : {}),
          ...(input.recoveryHydrationAttachments?.length
            ? {
                recoveryHydrationAttachments:
                  input.recoveryHydrationAttachments,
              }
            : {}),
          ...(input.forceHydration ? { forceHydration: true } : {}),
          ...(input.additionalDirectories?.length
            ? { additionalDirectories: input.additionalDirectories }
            : {}),
          ...(input.extraPath ? { extraPath: input.extraPath } : {}),
          abortSignal: input.abortSignal,
          onEvent: input.onEvent,
        },
        acpConfig
      );
      return {
        harnessKind: spec.kind,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.usageSnapshot
          ? { usageSnapshot: result.usageSnapshot }
          : {}),
        ...(result.hydrated ? { hydrated: true } : {}),
        ...(result.hydrationKind
          ? { hydrationKind: result.hydrationKind }
          : {}),
      };
    },
    enumerateModels: spec.probeModels
      ? (prefs: EnumeratePrefs): Promise<HarnessModel[]> =>
          enumerateAcpModels(buildAcpConfig(spec, prefs))
      : (): Promise<HarnessModel[]> => Promise.resolve([]),
  };
}

const codexHarness = makeAcpHarness({
  kind: "codex",
  label: "Codex",
  defaultBin: "codex",
  acpArgs: [],
  minVersion: { major: 0, minor: 128, patch: 0 },
  installHint:
    "Install Codex CLI (https://platform.openai.com/docs/codex) and run `codex login`.",
  env: { INITIAL_AGENT_MODE: "agent-full-access" },
  adapter: {
    packageName: "@agentclientprotocol/codex-acp",
    binPathEnvVar: "CODEX_PATH",
  },
  probeModels: true,
});

const claudeHarness = makeAcpHarness({
  kind: "claude-code",
  label: "Claude Code",
  defaultBin: "claude",
  acpArgs: [],
  minVersion: { major: 2, minor: 1, patch: 126 },
  installHint:
    "Install Claude Code (https://claude.com/code) and run `claude login`.",
  adapter: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    binPathEnvVar: "CLAUDE_CODE_EXECUTABLE",
    sessionModeId: "bypassPermissions",
    bypassNeedsSandboxWhenRoot: true,
  },
  resolveModel: resolveClaudeModel,
  probeModels: true,
});

const geminiHarness = makeAcpHarness({
  kind: "gemini",
  label: "Gemini CLI",
  defaultBin: "gemini",
  acpArgs: ["--acp"],
  minVersion: { major: 0, minor: 50, patch: 0 },
  installHint:
    "Install Gemini CLI (`npm i -g @google/gemini-cli`) and run `gemini` once to authenticate.",
});

const qwenHarness = makeAcpHarness({
  kind: "qwen",
  label: "Qwen Code",
  defaultBin: "qwen",
  acpArgs: ["--acp"],
  minVersion: { major: 0, minor: 20, patch: 0 },
  installHint:
    "Install Qwen Code (`npm i -g @qwen-code/qwen-code`) and run `qwen` once to authenticate.",
});

const opencodeHarness = makeAcpHarness({
  kind: "opencode",
  label: "opencode",
  defaultBin: "opencode",
  // SAFETY: never add `--mdns` to these args, and be wary of a user who puts it
  acpArgs: ["acp"],
  minVersion: { major: 1, minor: 18, patch: 4 },
  installHint:
    "Install opencode (`npm i -g opencode-ai`) and run `opencode auth login`.",
});

const grokHarness = makeAcpHarness({
  kind: "grok",
  label: "Grok",
  defaultBin: "grok",
  acpArgs: ["agent", "stdio"],
  minVersion: { major: 0, minor: 2, patch: 106 },
  installHint:
    "Install Grok CLI (`npm i -g @xai-official/grok`) and sign in. Requires a paid SuperGrok or X Premium+ subscription.",
});

const kimiHarness = makeAcpHarness({
  kind: "kimi",
  label: "Kimi",
  defaultBin: "kimi",
  acpArgs: ["acp"],
  minVersion: { major: 1, minor: 17, patch: 0 },
  installHint:
    "Install Kimi CLI (`uv tool install kimi-cli`, or `curl -LsSf https://code.kimi.com/install.sh | bash`) and run `kimi login`.",
});

const copilotHarness = makeAcpHarness({
  kind: "copilot",
  label: "GitHub Copilot CLI",
  defaultBin: "copilot",
  acpArgs: ["--acp"],
  minVersion: { major: 1, minor: 0, patch: 71 },
  installHint:
    "Install GitHub Copilot CLI (`curl -fsSL https://gh.io/copilot-install | bash`, or `brew install copilot-cli`) and sign in with `/login`. Requires a paid Copilot subscription.",
});

const cursorHarness = makeAcpHarness({
  kind: "cursor",
  label: "Cursor",
  defaultBin: "cursor-agent",
  acpArgs: ["acp"],
  minVersion: { major: 2026, minor: 7, patch: 16 },
  installHint:
    "Install Cursor CLI (`curl https://cursor.com/install -fsS | bash`) and sign in with `cursor-agent login`. Requires a paid Cursor plan.",
});

const kiloHarness = makeAcpHarness({
  kind: "kilo",
  label: "Kilo",
  defaultBin: "kilo",
  acpArgs: ["acp"],
  minVersion: { major: 7, minor: 4, patch: 11 },
  installHint: "Install Kilo (`npm i -g @kilocode/cli`) and run `kilo auth`.",
});

const clineHarness = makeAcpHarness({
  kind: "cline",
  label: "Cline",
  defaultBin: "cline",
  acpArgs: ["--acp"],
  minVersion: { major: 3, minor: 0, patch: 46 },
  installHint: "Install Cline (`npm i -g cline`) and run `cline auth`.",
});

const gooseHarness = makeAcpHarness({
  kind: "goose",
  label: "goose",
  defaultBin: "goose",
  acpArgs: ["acp"],
  minVersion: { major: 1, minor: 43, patch: 0 },
  installHint:
    "Install goose (`brew install block-goose-cli`; the binary is `goose`) and run `goose configure` to set a provider before use.",
});

const auggieHarness = makeAcpHarness({
  kind: "auggie",
  label: "Auggie CLI",
  defaultBin: "auggie",
  acpArgs: ["--acp"],
  env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
  minVersion: { major: 0, minor: 33, patch: 0 },
  installHint:
    "Install Auggie CLI (`npm i -g @augmentcode/auggie`) and sign in from a terminal. Requires a paid Augment plan.",
});

const vibeHarness = makeAcpHarness({
  kind: "vibe",
  label: "Mistral Vibe",
  defaultBin: "vibe-acp",
  acpArgs: [],
  minVersion: { major: 2, minor: 21, patch: 0 },
  installHint:
    "Install Mistral Vibe (`uv tool install mistral-vibe`, needs Python 3.12+) and set a Mistral API key.",
});

const droidHarness = makeAcpHarness({
  kind: "droid",
  label: "Factory Droid",
  defaultBin: "droid",
  acpArgs: ["exec", "--output-format", "acp-daemon"],
  env: {
    DROID_DISABLE_AUTO_UPDATE: "true",
    FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
  },
  minVersion: { major: 0, minor: 175, patch: 1 },
  installHint:
    "Install Factory Droid (`curl -fsSL https://app.factory.ai/cli | sh`, or `brew install --cask droid`) and sign in in a browser, or set `FACTORY_API_KEY`.",
});

const piHarness = makeAcpHarness({
  kind: "pi",
  label: "pi",
  defaultBin: "pi-acp",
  acpArgs: [],
  minVersion: { major: 0, minor: 0, patch: 31 },
  installHint: "Install the pi ACP adapter (`npm i -g pi-acp`) and sign in.",
});

const acpHarness = makeAcpHarness({
  kind: "acp",
  label: "Custom ACP agent",
  acpArgs: [],
  minVersion: { major: 0, minor: 0, patch: 0 },
  installHint:
    "Set the ACP CLI’s binary path in Settings → Agents, and add its ACP flag (e.g. `--acp`) under extra args.",
});

export const HARNESSES: Record<HarnessKind, HarnessSpec> = {
  codex: codexHarness,
  "claude-code": claudeHarness,
  gemini: geminiHarness,
  qwen: qwenHarness,
  opencode: opencodeHarness,
  grok: grokHarness,
  kimi: kimiHarness,
  copilot: copilotHarness,
  cursor: cursorHarness,
  kilo: kiloHarness,
  cline: clineHarness,
  goose: gooseHarness,
  auggie: auggieHarness,
  vibe: vibeHarness,
  droid: droidHarness,
  pi: piHarness,
  acp: acpHarness,
};

export const SUPPORTED_HARNESS_KINDS = [
  "codex",
  "claude-code",
  "opencode",
  "grok",
  "pi",
] as const satisfies readonly HarnessKind[];

export const SUPPORTED_HARNESSES: readonly HarnessSpec[] =
  SUPPORTED_HARNESS_KINDS.map((kind) => HARNESSES[kind]);

export function getHarness(kind: HarnessKind): HarnessSpec {
  const harness = HARNESSES[kind];
  if (!harness)
    throw new Error(`no harness spec registered for kind "${String(kind)}"`);
  return harness;
}
