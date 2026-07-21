/*
 * Runner backend registry — the single dispatch table for every runner
 * kind the runtime can drive.
 *
 * governance: allow-repo-hygiene file-size-limit — this is a per-kind
 * dispatch table; it grows one backend entry per RunnerKind by design, so it
 * legitimately exceeds the 500-line file cap. Split into a data module before
 * it doubles, not per added kind.
 *
 * Before this existed, three sites hardcoded a per-kind switch: `runTurn`
 * (a two-arm `if`), `preflight` (`MIN_VERSIONS` / `defaultBinFor` /
 * `hintFor`), and `models/enumerators` (a `switch`). They now all read
 * from `RUNNER_BACKENDS` below, so adding a runner kind is one entry here
 * plus its `RunnerKind` literal in `@centraid/app-engine` — nothing else
 * branches on the kind.
 *
 * Since issue #479 there is exactly ONE integration path: the generic ACP
 * client in `./backends/acp/backend.ts`. Every kind is a `makeAcpBackend`
 * entry; kinds differ only in how the ACP-speaking process is launched.
 *
 *   - `gemini` / `qwen` / `opencode` / `grok` / `kimi` / `copilot` / `cursor` /
 *     `kilo` / `cline` / `goose` / `auggie` / `vibe` / `droid` / `pi` / custom
 *     `acp`: the CLI speaks ACP natively, so we spawn it with its ACP flag or
 *     subcommand (or, for `vibe` and `pi`, its dedicated ACP binary).
 *   - `codex` / `claude-code`: neither CLI speaks ACP (Claude Code has no
 *     `--acp`; codex-rs has no ACP surface), so we spawn their official
 *     Apache-2.0 adapters — pinned dependencies of this package, never an
 *     `npx -y` fetch — which drive the same `claude` / `codex app-server`
 *     underneath. `defaultBin` still names the USER-FACING CLI, because
 *     that is what preflight probes and what the install hint is about.
 *
 * Adding a harness is therefore one registry entry plus, if it needs an
 * adapter, an `AcpAdapterSpec` — see docs/runners.md.
 */

import type {
  RunTurnFn,
  RunnerKind,
  RunnerModel,
  TurnConfig,
  TurnInput,
  TurnResult,
} from '@centraid/app-engine';
import { runAcpTurn, type AcpAdapterSpec, type AcpTurnConfig } from './backends/acp/backend.js';
import { enumerateAcpModels } from './backends/acp/enumerate-models.js';
import { resolveClaudeModel } from './models/tiers.js';

/** A pinned semantic version — the minimum whose protocol we've verified. */
export interface RunnerVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Prefs slice a model enumerator reads (never the whole `RunnerPrefs`). */
export interface EnumeratePrefs {
  binPath?: string;
  extraArgs?: string[];
}

/**
 * Everything the runtime needs to know about one runner kind, gathered in
 * one place: how to drive a turn, its default binary, the minimum verified
 * version, the install hint, and how to enumerate its models.
 */
export interface RunnerBackend {
  readonly kind: RunnerKind;
  /** Human label for pickers / status surfaces. */
  readonly label: string;
  /**
   * The USER-FACING CLI resolved off PATH when the user sets no explicit
   * `binPath` — `claude`, `codex`, `gemini`, … This is what preflight probes
   * and version-checks even for adapter-backed kinds, because it is what the
   * user installs and authenticates; the adapter is our implementation detail.
   * `undefined` for the custom `acp` kind, which has no canonical binary —
   * preflight reports it unavailable until `binPath` is configured.
   */
  readonly defaultBin?: string;
  /** Minimum CLI version whose event/flag schema we've verified. */
  readonly minVersion: RunnerVersion;
  /** Caller-facing install/setup hint (shown when the CLI is missing). */
  readonly installHint: string;
  /** Drive one model turn. Emits `TurnStreamEvent`s; resolves with the resume id. */
  readonly runTurn: RunTurnFn;
  /** Enumerate the models this runner can serve. Best-effort, never throws. */
  readonly enumerateModels: (prefs: EnumeratePrefs) => Promise<RunnerModel[]>;
}

// ---- the one backend shape ----------------------------------------------

interface AcpBackendSpec {
  kind: RunnerKind;
  label: string;
  defaultBin?: string;
  acpArgs: string[];
  minVersion: RunnerVersion;
  installHint: string;
  /**
   * Static env for the spawned process, whichever flavour this kind is: the
   * CLI itself for native kinds, the adapter for adapter-backed ones. See
   * `AcpTurnConfig.env` — deliberately ONE field rather than an adapter-only
   * one, so a native kind that needs launch env (auggie, droid) doesn't grow
   * a second path.
   */
  env?: Readonly<Record<string, string>>;
  /** Launch through a first-party adapter (kinds whose CLI has no ACP mode). */
  adapter?: AcpAdapterSpec;
  /** Tier → native-alias mapping applied before matching the agent's model options. */
  resolveModel?: (model: string) => string;
  /**
   * Enumerate this kind's models by probing a real ACP session (launch →
   * initialize → session/new → read the model config option). Off by default:
   * the probe spawns the agent, and the boot warmer warms EVERY detected
   * runner, so a universal default would spawn a process per installed native
   * kind at boot — many of which just answer `AUTH_REQUIRED`. The two
   * adapter-backed kinds that had bespoke enumerators before #484 (codex,
   * claude-code) opt in; every native kind stays on "Gateway default" and
   * still pins a model per-session at turn time. See `./backends/acp/
   * enumerate-models.ts`.
   */
  probeModels?: boolean;
}

/**
 * Fold a registry spec plus the user's prefs into the config the generic ACP
 * client consumes. Pure and exported so the per-kind launch config (adapter
 * package, headless env, which env var `binPath` becomes) is assertable
 * without spawning anything.
 */
export function buildAcpConfig(
  spec: AcpBackendSpec,
  prefs: { binPath?: string; extraArgs?: string[] },
): AcpTurnConfig {
  return {
    kind: spec.kind,
    label: spec.label,
    // Carried so the ACP client can answer `AUTH_REQUIRED` with the kind's
    // own sign-in instructions without ever branching on the kind itself.
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

/** Every registered spec, keyed by kind — the launch-config source of truth. */
const ACP_SPECS = new Map<RunnerKind, AcpBackendSpec>();

/** The launch config a kind would use for the given prefs. Test/diagnostic seam. */
export function acpConfigFor(
  kind: RunnerKind,
  prefs: { binPath?: string; extraArgs?: string[] },
): AcpTurnConfig {
  const spec = ACP_SPECS.get(kind);
  if (!spec) throw new Error(`no runner backend registered for kind "${String(kind)}"`);
  return buildAcpConfig(spec, prefs);
}

function makeAcpBackend(spec: AcpBackendSpec): RunnerBackend {
  ACP_SPECS.set(spec.kind, spec);
  return {
    kind: spec.kind,
    label: spec.label,
    ...(spec.defaultBin ? { defaultBin: spec.defaultBin } : {}),
    minVersion: spec.minVersion,
    installHint: spec.installHint,
    runTurn: async (input: TurnInput, config: TurnConfig): Promise<TurnResult> => {
      const { prefs } = config;
      const acpConfig = buildAcpConfig(spec, prefs);
      const result = await runAcpTurn(
        {
          cwd: input.cwd,
          message: input.message,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          // The vault runners: the ACP client serves them from a per-turn
          // loopback MCP endpoint, which is how every kind reaches the vault.
          ...(input.toolContext ? { toolContext: input.toolContext } : {}),
          extraSystemPrompt: input.extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(input.prevSessionId ? { prevSessionId: input.prevSessionId } : {}),
          ...(input.extraPath ? { extraPath: input.extraPath } : {}),
          abortSignal: input.abortSignal,
          onEvent: input.onEvent,
        },
        acpConfig,
      );
      return {
        adapterKind: spec.kind,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      };
    },
    // Models are an ACP *session* concern (the agent advertises its own
    // `configOptions` at session/new, and the backend pins one from there). A
    // kind that opts into `probeModels` enumerates via the generic ACP probe —
    // one launch → session/new → read the model option — reusing the exact
    // launch config a turn would. Everything else returns nothing and the
    // picker stays on "Gateway default".
    enumerateModels: spec.probeModels
      ? (prefs: EnumeratePrefs): Promise<RunnerModel[]> =>
          enumerateAcpModels(buildAcpConfig(spec, prefs))
      : (): Promise<RunnerModel[]> => Promise.resolve([]),
  };
}

// ---- codex ---------------------------------------------------------------

const codexBackend = makeAcpBackend({
  kind: 'codex',
  label: 'Codex',
  // The user-facing CLI: what preflight probes, what the hint installs. The
  // adapter spawns it (or the path the user pinned) via `CODEX_PATH`.
  defaultBin: 'codex',
  acpArgs: [],
  minVersion: { major: 0, minor: 128, patch: 0 },
  installHint: 'Install Codex CLI (https://platform.openai.com/docs/codex) and run `codex login`.',
  // Headless parity with the retired bespoke backend's `approvalPolicy:'never'`
  // + full-access sandbox. Set at startup, so the adapter never round-trips an
  // approval this surface cannot show. Lives on the spec, not the adapter:
  // launch env is one field for native and adapter-backed kinds alike.
  env: { INITIAL_AGENT_MODE: 'agent-full-access' },
  adapter: {
    packageName: '@agentclientprotocol/codex-acp',
    binPathEnvVar: 'CODEX_PATH',
  },
  // The codex-acp adapter advertises a `model` config option on session/new
  // (its `createModelConfigOption`), so the generic probe replaces the old
  // `codex app-server model/list` enumerator.
  probeModels: true,
});

// ---- claude-code ---------------------------------------------------------

const claudeBackend = makeAcpBackend({
  kind: 'claude-code',
  label: 'Claude Code',
  defaultBin: 'claude',
  acpArgs: [],
  minVersion: { major: 2, minor: 1, patch: 126 },
  installHint: 'Install Claude Code (https://claude.com/code) and run `claude login`.',
  adapter: {
    packageName: '@agentclientprotocol/claude-agent-acp',
    // The adapter honours CLAUDE_CONFIG_DIR, so an existing `claude login`
    // is reused as-is; no env of our own is needed at launch.
    binPathEnvVar: 'CLAUDE_CODE_EXECUTABLE',
    // Headless parity: gateway turns have no approval UI, so the default mode
    // deadlocks the first file write. Centraid's own consent layer (vault
    // grants, outbox) is the gate that matters.
    sessionModeId: 'bypassPermissions',
    bypassNeedsSandboxWhenRoot: true,
  },
  // The picker offers capability tiers; map them to the CLI's aliases before
  // matching against the concrete model ids the adapter advertises.
  resolveModel: resolveClaudeModel,
  // The claude-agent-acp adapter advertises a `model` config option on
  // session/new (its `buildConfigOptions`), so the generic probe replaces the
  // old Agent-SDK `supportedModels()` enumerator.
  probeModels: true,
});

const geminiBackend = makeAcpBackend({
  kind: 'gemini',
  label: 'Gemini CLI',
  // Natively ACP-speaking: no adapter, just the flag.
  defaultBin: 'gemini',
  // `--experimental-acp` is deprecated upstream and aliases to `--acp`; the
  // pinned minimum accepts both, so we use the name that outlives the alias.
  acpArgs: ['--acp'],
  minVersion: { major: 0, minor: 50, patch: 0 },
  installHint:
    'Install Gemini CLI (`npm i -g @google/gemini-cli`) and run `gemini` once to authenticate.',
});

const qwenBackend = makeAcpBackend({
  kind: 'qwen',
  label: 'Qwen Code',
  defaultBin: 'qwen',
  // `--experimental-acp` is deprecated upstream and aliases to `--acp`; the
  // pinned minimum accepts both, so we use the name that outlives the alias.
  acpArgs: ['--acp'],
  minVersion: { major: 0, minor: 20, patch: 0 },
  installHint:
    'Install Qwen Code (`npm i -g @qwen-code/qwen-code`) and run `qwen` once to authenticate.',
});

const opencodeBackend = makeAcpBackend({
  kind: 'opencode',
  label: 'opencode',
  defaultBin: 'opencode',
  // `opencode acp` is the ACP-native subcommand; there is no deprecated
  // flag alias to worry about here.
  //
  // SAFETY: never add `--mdns` to these args, and be wary of a user who puts
  // it in `extraArgs`. That flag defaults opencode's listen hostname to
  // 0.0.0.0, which would publish an unauthenticated code-execution agent to
  // every host on the LAN. We launch with `acp` and nothing else of our own.
  acpArgs: ['acp'],
  // ACP landed in 0.15.10, but 1.18.4 is the floor after a client-compat
  // rework (the ACP SDK is still pre-1.0, so older clients drift).
  minVersion: { major: 1, minor: 18, patch: 4 },
  installHint: 'Install opencode (`npm i -g opencode-ai`) and run `opencode auth login`.',
});

const grokBackend = makeAcpBackend({
  kind: 'grok',
  label: 'Grok',
  defaultBin: 'grok',
  // xAI's Grok Build CLI speaks ACP natively under `grok agent stdio`.
  acpArgs: ['agent', 'stdio'],
  // 0.2.106 — NOT 0.2.11. The latter is an older release that predates ACP
  // support entirely; the two only look adjacent under a string sort.
  minVersion: { major: 0, minor: 2, patch: 106 },
  installHint:
    'Install Grok CLI (`npm i -g @xai-official/grok`) and sign in. Requires a paid SuperGrok or X Premium+ subscription.',
});

const kimiBackend = makeAcpBackend({
  kind: 'kimi',
  label: 'Kimi',
  defaultBin: 'kimi',
  // The `acp` SUBCOMMAND, not the deprecated `--acp` flag: they are not
  // synonyms. `--acp` runs a single-session mode with no session list/load,
  // and we rely on `session/load` to resume a conversation. Do not "simplify"
  // this back to a flag.
  //
  // The project is mid-rename to "Kimi Code" (new repo, license moving
  // Apache-2.0 → MIT), but the `kimi` binary and `kimi acp` invocation are
  // preserved across it.
  acpArgs: ['acp'],
  // `kimi acp` landed in 0.63 and model switching over ACP in 0.74, but 1.17
  // added the AUTH_REQUIRED terminal-auth handshake our ACP client consumes,
  // so that is the meaningful floor.
  minVersion: { major: 1, minor: 17, patch: 0 },
  // Not an npm package — Kimi CLI is a Python tool.
  installHint:
    'Install Kimi CLI (`uv tool install kimi-cli`, or `curl -LsSf https://code.kimi.com/install.sh | bash`) and run `kimi login`.',
});

const copilotBackend = makeAcpBackend({
  kind: 'copilot',
  label: 'GitHub Copilot CLI',
  // The npm package is `@github/copilot`, but the BINARY it installs is
  // `copilot` — package name and bin name differ here, unlike every other
  // kind. Do not "correct" this to the package name.
  //
  // There is also a separate `@github/copilot-language-server` package whose
  // bin is `copilot-language-server`. That is an LSP server for editor
  // completions, NOT this agent, and it does not speak ACP. Do not add it.
  defaultBin: 'copilot',
  // Stdio ACP. `--acp` also accepts a `--port` for TCP mode; we speak stdio,
  // so `--port` must never be passed — it would put the agent on a socket the
  // ACP client isn't reading.
  acpArgs: ['--acp'],
  minVersion: { major: 1, minor: 0, patch: 71 },
  installHint:
    'Install GitHub Copilot CLI (`curl -fsSL https://gh.io/copilot-install | bash`, or `brew install copilot-cli`) and sign in with `/login`. Requires a paid Copilot subscription.',
});

const cursorBackend = makeAcpBackend({
  kind: 'cursor',
  // The installer creates BOTH `agent` and `cursor-agent` symlinks. We
  // deliberately use `cursor-agent`: a bare `agent` on PATH is a dangerously
  // generic name that could resolve to anything. Do not switch to `agent`.
  label: 'Cursor',
  defaultBin: 'cursor-agent',
  acpArgs: ['acp'],
  // CalVer, NOT semver: `2026.07.16` is year.month.day. It still compares
  // numerically and sorts correctly through the same `compareSemver`, so this
  // needs no special casing — but it is not a semantic version, and
  // "normalising" it to something small would silently drop the floor.
  minVersion: { major: 2026, minor: 7, patch: 16 },
  installHint:
    'Install Cursor CLI (`curl https://cursor.com/install -fsS | bash`) and sign in with `cursor-agent login`. Requires a paid Cursor plan.',
});

const kiloBackend = makeAcpBackend({
  kind: 'kilo',
  label: 'Kilo',
  defaultBin: 'kilo',
  acpArgs: ['acp'],
  minVersion: { major: 7, minor: 4, patch: 11 },
  installHint: 'Install Kilo (`npm i -g @kilocode/cli`) and run `kilo auth`.',
});

const clineBackend = makeAcpBackend({
  kind: 'cline',
  label: 'Cline',
  defaultBin: 'cline',
  acpArgs: ['--acp'],
  minVersion: { major: 3, minor: 0, patch: 46 },
  installHint: 'Install Cline (`npm i -g cline`) and run `cline auth`.',
});

const gooseBackend = makeAcpBackend({
  kind: 'goose',
  label: 'goose',
  // Homebrew's formula is `block-goose-cli`, but the binary it installs is
  // `goose` — hence the hint spelling out both.
  defaultBin: 'goose',
  acpArgs: ['acp'],
  minVersion: { major: 1, minor: 43, patch: 0 },
  // goose does NOT answer an unconfigured provider with ACP's `AUTH_REQUIRED`.
  // It fails `session/new` with an opaque JSON-RPC `-32603 Internal error`,
  // which our AUTH_REQUIRED handling cannot turn into an actionable message.
  // Telling the user to configure a provider up front is the only fix
  // available from here — keep `goose configure` in this hint.
  installHint:
    'Install goose (`brew install block-goose-cli`; the binary is `goose`) and run `goose configure` to set a provider before use.',
});

const auggieBackend = makeAcpBackend({
  kind: 'auggie',
  label: 'Auggie CLI',
  defaultBin: 'auggie',
  acpArgs: ['--acp'],
  // Suppresses the CLI's own auto-update. Without it Auggie can update itself
  // mid-session, swapping the binary underneath a running turn.
  env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  minVersion: { major: 0, minor: 33, patch: 0 },
  installHint:
    'Install Auggie CLI (`npm i -g @augmentcode/auggie`) and sign in from a terminal. Requires a paid Augment plan.',
});

const vibeBackend = makeAcpBackend({
  kind: 'vibe',
  label: 'Mistral Vibe',
  // `vibe-acp` is a SEPARATE binary from `vibe` — the ACP server is its own
  // entrypoint, not a mode of the main CLI. That is also why `acpArgs` is
  // empty: there is no flag or subcommand to add. Do not "fix" this to
  // `vibe` + `['acp']`; that command does not exist.
  defaultBin: 'vibe-acp',
  acpArgs: [],
  minVersion: { major: 2, minor: 21, patch: 0 },
  // A Python tool (like kimi), not an npm package.
  installHint:
    'Install Mistral Vibe (`uv tool install mistral-vibe`, needs Python 3.12+) and set a Mistral API key.',
});

const droidBackend = makeAcpBackend({
  kind: 'droid',
  label: 'Factory Droid',
  defaultBin: 'droid',
  // A SUBCOMMAND plus a value-bearing flag, not a mode flag: `acp-daemon` is
  // the value of `--output-format`, so the three tokens are inseparable.
  acpArgs: ['exec', '--output-format', 'acp-daemon'],
  // Both vars suppress the CLI's own auto-update (it honours two names).
  // Without them droid can update itself mid-session.
  env: {
    DROID_DISABLE_AUTO_UPDATE: 'true',
    FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
  },
  minVersion: { major: 0, minor: 175, patch: 1 },
  installHint:
    'Install Factory Droid (`curl -fsSL https://app.factory.ai/cli | sh`, or `brew install --cask droid`) and sign in in a browser, or set `FACTORY_API_KEY`.',
});

const piBackend = makeAcpBackend({
  kind: 'pi',
  label: 'pi',
  // `pi-acp` is a SEPARATE ACP server binary, not a mode of a `pi` CLI — the
  // same shape as `vibe`/`vibe-acp`. That is why `acpArgs` is empty: there is
  // no flag or subcommand to add. Do not "fix" this to a `pi` + `['acp']`
  // invocation; that command does not exist.
  defaultBin: 'pi-acp',
  acpArgs: [],
  minVersion: { major: 0, minor: 0, patch: 31 },
  installHint: 'Install the pi ACP adapter (`npm i -g pi-acp`) and sign in.',
});

const acpBackend = makeAcpBackend({
  kind: 'acp',
  label: 'Custom ACP agent',
  // No default binary — the custom kind is unavailable until a path is set.
  acpArgs: [],
  minVersion: { major: 0, minor: 0, patch: 0 },
  installHint:
    'Set the ACP CLI’s binary path in Settings → Agents, and add its ACP flag (e.g. `--acp`) under extra args.',
});

/** The dispatch table. Keyed on `RunnerKind` — TS enforces full coverage. */
export const RUNNER_BACKENDS: Record<RunnerKind, RunnerBackend> = {
  codex: codexBackend,
  'claude-code': claudeBackend,
  gemini: geminiBackend,
  qwen: qwenBackend,
  opencode: opencodeBackend,
  grok: grokBackend,
  kimi: kimiBackend,
  copilot: copilotBackend,
  cursor: cursorBackend,
  kilo: kiloBackend,
  cline: clineBackend,
  goose: gooseBackend,
  auggie: auggieBackend,
  vibe: vibeBackend,
  droid: droidBackend,
  pi: piBackend,
  acp: acpBackend,
};

/**
 * Resolve the backend for a runner kind. Throws on an unregistered kind —
 * callers that must never throw (best-effort enumeration) index
 * `RUNNER_BACKENDS` directly and guard for `undefined`.
 */
export function getRunnerBackend(kind: RunnerKind): RunnerBackend {
  const backend = RUNNER_BACKENDS[kind];
  if (!backend) throw new Error(`no runner backend registered for kind "${String(kind)}"`);
  return backend;
}
