/*
 * Platform-neutral replica surface for non-DOM hosts (React Native).
 *
 * The main `./replica` barrel re-exports the browser engine — the OPFS worker
 * client, the IndexedDB outbox, the `window`-driven change feed and shell
 * session — so importing it drags DOM globals into a React Native typecheck and
 * bundle. This entry point re-exports only the modules whose transitive graph
 * is DOM-free: the driver-neutral store core, the coordinator, the intent queue
 * and record contract, the injectable HTTP transport, the SSE grammar, the
 * error taxonomy and the wire types. Native code composes these over an
 * op-sqlite driver and an `expo/fetch` change feed.
 */
/* eslint-disable oxc/no-barrel-file -- (#419) intentional @centraid/client/replica/native public subpath; governance: allow-no-unjustified-suppressions stable cross-platform API boundary */
export * from './coordinator.js';
export * from './digest.js';
export * from './errors.js';
export * from './intent-invalidations.js';
export * from './intent-record-store.js';
export * from './intents.js';
export * from './key.js';
export * from './live-query.js';
export * from './live-query-registry.js';
export * from './memory-intent-store.js';
export * from './payload-hash.js';
export * from './query.js';
export * from './search.js';
export * from './shell-transport.js';
export * from './store.js';
export * from './store-core.js';
export * from './types.js';
export * from './windowed-bootstrap.js';
export {
  authHeaders,
  GatewayClientError,
  href,
  VAULT_HEADER,
  type GatewayAuth,
} from '../gateway-auth.js';
export * from '../vault-change-sse.js';
