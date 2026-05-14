/*
 * @centraid/runtime-core
 *
 * Transport-agnostic engine for centraid apps:
 *   - registry, versioned uploads, sqlite-backed handler runner
 *   - the full `/centraid/...` URL surface as a `Runtime.handle(req, res)` fn
 *   - a `Scheduler` interface that pluggable backends (OpenClaw, Claude
 *     Agent SDK, ...) implement
 *
 * Hosts: `@centraid/openclaw-plugin` (OpenClaw gateway shim) and the
 * desktop in-process embed in `@centraid/desktop`.
 */

export { Runtime, type RuntimeOptions, type RuntimeLogger } from './runtime.js';

export {
  startRuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerHandle,
} from './http-server.js';

export { NullScheduler } from './null-scheduler.js';

export type {
  Scheduler,
  CronJobDefinition,
  CronJobSnapshot,
  CronChangedEvent,
} from './scheduler.js';

// Public handler types — apps written in TypeScript import these to type
// their default exports.
export type {
  QueryHandler,
  ActionHandler,
  CronHandler,
  QueryHandlerArgs,
  ActionHandlerArgs,
  CronHandlerArgs,
  ActionResult,
  ScopedDb,
  ScopedLog,
  AppRef,
  AppId,
  AppMode,
  RegistryEntry,
  CronStatus,
  CronModule,
  QueryModule,
  ActionModule,
  HandlerFn,
  ScopedFetch,
  CommonHandlerArgs,
} from './types.js';

// Live-schema and cloud-panel payload shapes — consumed by agent-harness
// and by the desktop cloud panel.
export type {
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
} from './schema.js';
export type { AppTableRows } from './table-rows.js';
export type { RunQueryResult } from './run-query.js';
export type { LogEntry, LogLevel } from './log-store.js';

// Error classes — hosts that want to translate them to their own response
// shapes can import these directly. (The Runtime.handle() default handler
// already converts them to JSON error responses.)
export { RegistryError } from './registry.js';
export { VersionStoreError } from './version-store.js';
export { UploadError } from './upload.js';
export { MigrationError } from './migrate.js';
