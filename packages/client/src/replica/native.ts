/*
 * Platform-neutral replica surface for non-DOM hosts (React Native).
 *
 * The main `./replica` barrel re-exports the browser engine — OPFS worker
 * client, IndexedDB outbox, `window`-driven change feed and shell session — so
 * importing it drags DOM globals into a React Native typecheck and bundle.
 * Every re-export below must have a DOM-free transitive graph. Native code
 * composes them over an op-sqlite driver and an `expo/fetch` change feed.
 */
/* oxlint-disable oxc/no-barrel-file -- (#419) intentional @centraid/client/replica/native public subpath; governance: allow-no-unjustified-suppressions stable cross-platform API boundary */
export * from "./coordinator.js";
export * from "./digest.js";
export * from "./errors.js";
export * from "./inline-query-ctx-core.js";
export * from "./intent-invalidations.js";
export * from "./intent-record-store.js";
export * from "./intents.js";
export * from "./key.js";
export * from "./live-query.js";
export * from "./live-query-registry.js";
export * from "./memory-intent-store.js";
export * from "./payload-hash.js";
export * from "./query.js";
// The read grammar's compiler: public here because the native seat composes it
// over its mounted vault databases (#883).
export * from "./read-plan.js";
export * from "./rebootstrap-copy.js";
export * from "./search.js";
export * from "./shell-transport.js";
export * from "./store.js";
export * from "./store-core.js";
export * from "./trace.js";
export * from "./types.js";
export * from "./work-counters.js";
export * from "./windowed-bootstrap.js";
export * from "./write-helpers.js";
export {
  authHeaders,
  GatewayClientError,
  href,
  VAULT_HEADER,
  type GatewayAuth,
} from "../gateway-auth.js";
export * from "../vault-change-sse.js";
export {
  isGatewayCapabilities,
  type GatewayCapabilities,
  type GatewayInfo,
} from "@centraid/core/protocol";
