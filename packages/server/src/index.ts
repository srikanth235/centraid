export {
  buildGateway,
  type BuildGatewayOptions,
  type BuiltGateway,
  type RouteHandler,
  type FireAutomation,
} from "./serve/build-gateway.js";
export {
  serve,
  type ServeOptions,
  type GatewayServeHandle,
} from "./serve/serve.js";
export {
  ASSIST_PRODUCTION_CALLBACK_URL,
  ASSIST_PRODUCTION_WORKER_ORIGIN,
  GOOGLE_ASSIST_SCOPE_TIERS,
  assistOAuthFromEnvironment,
  validateAssistOAuthConfig,
  type AssistOAuthConfig,
  type AssistOAuthEnvironment,
} from "./serve/assist-oauth.js";
export {
  HealthRegistry,
  type ComponentHealth,
  type ComponentStatus,
  type HealthEvent,
  type HealthSnapshot,
  type HealthProbe,
  type HealthMetrics,
} from "./serve/health-registry.js";
export {
  RESOURCE_MODE_PREF_KEY,
  RESOURCE_MODES,
  formatEventLoopDetail,
  formatLoadShedDeferringDetail,
  formatRss,
  isResourceMode,
  parseResourceMode,
  resolveResourceMode,
  resourceModeLabel,
  type ResourceMode,
} from "./serve/resource-mode.js";
export {
  formatHardwareProfileDetail,
  hardwareClassForResourceMode,
  resolveGatewayHardwareProfile,
  type GatewayHardwareProfile,
  type HardwareClass,
} from "./serve/hardware-profile.js";
export {
  evaluateDiskFreeStatus,
  DISK_DEGRADED_BELOW_BYTES,
  DISK_DEGRADED_BELOW_PERCENT,
  DISK_ERROR_BELOW_BYTES,
  DISK_ERROR_BELOW_PERCENT,
} from "./serve/disk-health.js";
export {
  GatewayPerformanceMonitor,
  type GatewayPerformanceSnapshot,
  type GatewayPerformanceMonitorOptions,
} from "./serve/gateway-performance.js";
export {
  measureStorageLatency,
  type StorageLatencySample,
} from "./serve/storage-latency.js";
export {
  GatewayLogStore,
  type GatewayLogEntry,
  type GatewayLogLevel,
} from "./serve/gateway-log-store.js";
export type { GatewayPaths } from "./paths.js";
export {
  readHarnessesStatus,
  type HarnessesStatus,
  type HarnessStatusEntry,
} from "./routes/harnesses-routes.js";
export {
  openVaultPlane,
  VaultPlane,
  type VaultPlaneOptions,
  type GrantRequest,
} from "./serve/vault-plane.js";
export {
  openVaultRegistry,
  VaultRegistry,
  VaultRegistryError,
  type VaultRegistryOptions,
  type VaultInfo,
} from "./serve/vault-registry.js";
export { makeVaultRouteHandler } from "./routes/vault-routes.js";
export {
  makeReplicaRouteHandler,
  REPLICA_INTENTS_PATH,
  type ReplicaRouteOptions,
} from "./routes/replica-routes.js";
export {
  makeMultiplexReplicaRouteHandler,
  MULTIPLEX_REPLICA_CHANGES_PATH,
} from "./routes/multiplex-replica-routes.js";
export { makeEdgesRouteHandler, EDGES_PATH } from "./routes/edges-routes.js";
export {
  makeVaultLinksRouteHandler,
  LINKS_PATH,
} from "./routes/vault-links-routes.js";
export {
  makePeerPlaneHandler,
  PEER_LINK_HELLO_PATH,
  PEER_LINK_REDEEM_PATH,
  PEER_ROUTE_ASSERT_PATH,
  type PeerPlaneDeps,
} from "./routes/peer-plane.js";
export { VaultLinksStore } from "./serve/vault-links-store.js";
export {
  type LinkChangeListener,
  type LinkChangeReason,
} from "./serve/vault-link-row.js";
export {
  reconcileLinkBindings,
  type LinkBindingDeps,
  type LinkBindingOutcome,
  type LinkBindingState,
} from "./serve/link-party-bindings.js";
export type {
  LinkedPeer,
  LinkRoute,
  VaultLink,
} from "./serve/vault-link-row.js";
export {
  makePushRegistrationRouteHandler,
  PUSH_REGISTRATIONS_PATH,
  PushWakeRelay,
} from "./routes/push-wake-routes.js";
export {
  makeVaultToolRunners,
  assistantCwd,
} from "./runs/assistant-conversation-runner.js";
export {
  runWithVaultContext,
  vaultContext,
  VAULT_HEADER,
  type VaultRequestContext,
  type DeviceAccess,
} from "./serve/vault-context.js";
export { createImagePreviewCodec } from "./preview/codec.js";
export { createWasmImagePreviewCodec } from "./preview/wasm-codec.js";
export {
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
} from "./version.js";
export {
  platformDefaultDataDir,
  type DefaultDataDirOptions,
} from "./cli/data-dir.js";
export { landlordBearerForDataDir } from "./cli/landlord-auth.js";
export { isDirectHostRequest } from "./routes/route-helpers.js";
