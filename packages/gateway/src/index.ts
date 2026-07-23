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
} from './serve/build-gateway.js';
export { serve, type ServeOptions, type GatewayServeHandle } from './serve/serve.js';
export {
  ASSIST_PRODUCTION_CALLBACK_URL,
  ASSIST_PRODUCTION_WORKER_ORIGIN,
  GOOGLE_ASSIST_SCOPE_TIERS,
  assistOAuthFromEnvironment,
  validateAssistOAuthConfig,
  type AssistOAuthConfig,
  type AssistOAuthEnvironment,
} from './serve/assist-oauth.js';
// Component-level health (self-hosting observability): hosts push their
// own components (tunnel, disk) through `BuiltGateway.health`; clients
// read the aggregate at `GET /centraid/_gateway/health`.
export {
  HealthRegistry,
  type ComponentHealth,
  type ComponentStatus,
  type HealthEvent,
  type HealthSnapshot,
  type HealthProbe,
  type HealthMetrics,
} from './serve/health-registry.js';
export {
  GatewayPerformanceMonitor,
  type GatewayPerformanceSnapshot,
  type GatewayPerformanceMonitorOptions,
} from './serve/gateway-performance.js';
export { measureStorageLatency, type StorageLatencySample } from './serve/storage-latency.js';
export {
  GatewayLogStore,
  type GatewayLogEntry,
  type GatewayLogLevel,
} from './serve/gateway-log-store.js';
export type { GatewayPaths } from './paths.js';
export {
  readAgentsStatus,
  type AgentsStatus,
  type AgentStatusEntry,
} from './routes/agents-routes.js';
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
export {
  makeReplicaRouteHandler,
  REPLICA_INTENTS_PATH,
  type ReplicaRouteOptions,
} from './routes/replica-routes.js';
// The vault-register tool runners, giving chat turns `vault_sql` /
// `vault_invoke` / `vault_content` capability through the same
// consent/receipt pipeline the codex/claude runners use (issue #319).
export { makeVaultToolRunners, assistantCwd } from './runs/assistant-conversation-runner.js';
export {
  runWithVaultContext,
  vaultContext,
  VAULT_HEADER,
  type VaultRequestContext,
  type DeviceAccess,
} from './serve/vault-context.js';
// The preview ladder's raster codec (issue #405 §2): pure-JS jpeg-js/pngjs
// downscaler the host injects into vault planes so the blob sweep's backstop
// can generate missing tiny/medium derivatives for imported / weak-client /
// server-ingested images.
export { createImagePreviewCodec } from './preview/codec.js';
export { createWasmImagePreviewCodec } from './preview/wasm-codec.js';
export {
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
} from './version.js';
