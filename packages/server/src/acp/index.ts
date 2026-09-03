export {
  makeConversationRunner,
  type MakeConversationRunnerOptions,
} from "./conversation-driver.js";

export { defaultCentraidCliDir } from "./cli/centraid-cli-dir.js";

export type { HarnessKind, HarnessPrefs } from "./types.js";

export {
  runTurn,
  type TurnInput,
  type TurnConfig,
  type TurnResult,
  type ToolContext,
} from "./runtime.js";

export {
  VAULT_SQL_TOOL,
  VAULT_INVOKE_TOOL,
  VAULT_CONTENT_TOOL,
} from "./vault-sql-tool.js";

export {
  runAcpTurn,
  type AcpAdapterSpec,
  type AcpTurnInput,
  type AcpTurnConfig,
  type AcpTurnResult,
} from "./backends/acp/backend.js";

export {
  resolveAcpCapabilities,
  clearCapabilitiesCache,
  type AcpHarnessCapabilities,
} from "./backends/acp/capabilities-cache.js";

export {
  HARNESSES,
  SUPPORTED_HARNESSES,
  SUPPORTED_HARNESS_KINDS,
  getHarness,
  type HarnessSpec,
  type HarnessVersion,
} from "./registry.js";

export {
  runPreflight,
  probeCliAvailability,
  CLI_AVAILABILITY_TTL_MS,
  type CliAvailability,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from "./preflight.js";

export { readHarnessModels } from "./models/catalog.js";
export {
  CatalogWarmer,
  deriveStatus,
  type CatalogSurface,
  type CatalogWarmerOptions,
  type SurfaceStatus,
} from "./models/catalog-warmer.js";
export { enumerateHarnessModels } from "./models/enumerators.js";

export {
  runAutomation,
  type RunAutomationOptions,
} from "./automation/run-automation.js";
