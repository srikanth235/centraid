/*
 * Platform-neutral replica surface for non-DOM hosts (React Native).
 *
 * The main `./replica` barrel re-exports the browser engine — OPFS worker
 * client, IndexedDB outbox, `window`-driven change feed and shell session — so
 * importing it drags DOM globals into a React Native typecheck and bundle.
 * Every re-export below must have a DOM-free transitive graph. Native code
 * composes them over an expo-sqlite driver and an `expo/fetch` change feed.
 */
/* oxlint-disable oxc/no-barrel-file -- (#419) intentional @centraid/client/replica/native public subpath; governance: allow-no-unjustified-suppressions stable cross-platform API boundary */
export * from "./coordinator.js";
export * from "./digest.js";
export * from "./errors.js";
export * from "./inline-query-ctx-core.js";
export * from "./intent-invalidations.js";
export * from "./intent-record-store.js";
export * from "./intent-revision.js";
export * from "./intents.js";
export * from "./key.js";
export * from "./live-query.js";
export * from "./live-query-registry.js";
export * from "./memory-intent-store.js";
// The offline chain (#996, R23–R25): the phone derives its own edges, holds and
// restart projection from the outbox, because the badge has to be right in
// airplane mode where the gateway's verdict does not exist yet.
export * from "./offline-chain.js";
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
// THE SEAT STORE, minus its hosts (#996 wave 3). The `replica/seat` barrel
// re-exports the browser seat, its worker client and the OPFS storage probe,
// which drag `Worker`, `navigator.storage` and the DOM into a React Native
// typecheck; the phone supplies its own host — an expo-sqlite driver, the app's
// document directory, and `expo/fetch` — over exactly the pieces below.
export * from "./seat/applier.js";
export * from "./seat/blob-presence.js";
export * from "./seat/bootstrap.js";
export * from "./seat/byte-policy.js";
export * from "./seat/carry-over.js";
export * from "./seat/driver.js";
export * from "./seat/http-snapshot-transport.js";
export * from "./seat/in-process-channel.js";
export * from "./seat/outbox.js";
export * from "./seat/seat-bootstrap-no-room-error.js";
export * from "./seat/seat-drift-error.js";
export * from "./seat/seat-intent-store.js";
export * from "./seat/seat-loop.js";
export * from "./seat/seat-page-reader.js";
export * from "./seat/seat-rebootstrap-required-error.js";
export * from "./seat/seat-snapshot-moved-error.js";
export * from "./seat/state.js";
export * from "./seat/watermark.js";
export * from "./seat/worker-core.js";
export * from "./seat/worker-protocol.js";
export {
  isGatewayCapabilities,
  type GatewayCapabilities,
  type GatewayInfo,
} from "@centraid/core/protocol";
