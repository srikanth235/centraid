/*
 * @centraid/gateway
 *
 * Host-agnostic centraid gateway. `serve()` wires `app-engine` +
 * `agent-runtime` + stores + chat runner against injected paths and
 * secrets, and starts an HTTP server in front of it. Two callers ship
 * today:
 *
 *   - `apps/desktop` embeds it in the Electron main process (paths
 *     under `<userData>/gateways/<id>/`, secrets read from
 *     `safeStorage`).
 *   - The `centraid-gateway` CLI in this package runs it as a
 *     standalone daemon (paths under a config-file `dataDir`, secrets
 *     read from a sealed file).
 *
 * No new wire protocol — the daemon serves the exact same routes the
 * Electron embed does, so desktop and mobile clients reach it through
 * their existing remote-gateway flow.
 */

export {
  buildGateway,
  type BuildGatewayOptions,
  type BuiltGateway,
  type RouteHandler,
  type FireAutomation,
  type FireAutomationDeps,
  type FireAutomationFactory,
} from './serve/build-gateway.js';
export { serve, type ServeOptions, type GatewayServeHandle } from './serve/serve.js';
export type { GatewayPaths } from './paths.js';
export { readAgentsStatus, type AgentsStatus } from './routes/agents-routes.js';
export {
  openVaultPlane,
  VaultPlane,
  type VaultPlaneOptions,
  type GrantRequest,
} from './serve/vault-plane.js';
export {
  openVaultRegistry,
  VaultRegistry,
  VaultRegistryError,
  type VaultRegistryOptions,
  type VaultInfo,
} from './serve/vault-registry.js';
export { makeVaultRouteHandler } from './routes/vault-routes.js';
// The vault-register tool runners + the embedded-turn grounding block —
// reused by the in-process OpenClaw plugin to give its embedded chat turns
// the same `vault_sql` / `vault_invoke` / `vault_content` capability the
// codex/claude runners get, executed through the same consent/receipt
// pipeline (issue #319).
export { makeVaultToolRunners, assistantCwd } from './runs/assistant-conversation-runner.js';
export { buildVaultToolsGrounding } from './runs/assistant-prompt.js';
export {
  runWithVaultContext,
  vaultContext,
  VAULT_HEADER,
  type VaultRequestContext,
  type DeviceAccess,
} from './serve/vault-context.js';
export { GATEWAY_VERSION, GATEWAY_SCHEMA_EPOCH } from './version.js';
