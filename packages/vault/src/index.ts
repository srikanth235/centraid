// @centraid/vault — the Duaility personal ontology (11 schemas over two
// SQLite files) and the gateway that is the only door to it. Consumers import
// it namespaced (`import * as vault from '@centraid/vault'`).

export { openVaultDb, type VaultDb, type OpenVaultOptions } from './db.js';
export { uuidv7, nowIso, sha256Hex } from './ids.js';
export {
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  JOURNAL_MIGRATIONS,
  migrate,
} from './schema/migrate.js';
export {
  resolveEntity,
  listVaultEntities,
  VAULT_TABLES,
  JOURNAL_TABLES,
  type EntityRef,
} from './schema/tables.js';

export { createGateway, Gateway } from './gateway/gateway.js';
export { GatewayError } from './gateway/types.js';
export type {
  Credential,
  Identity,
  Risk,
  FilterClause,
  ReadRequest,
  ReadResult,
  InvokeRequest,
  InvokeOutcome,
  ParkedSummary,
  ConditionSpec,
  Citation,
  HandlerCtx,
  CommandHandler,
  CommandDefinition,
} from './gateway/types.js';
export {
  admitImportedRow,
  resolveHandle,
  type RevocationResult,
  type SweepResult,
} from './gateway/duties.js';

export {
  bootstrapVault,
  enrollDevice,
  enrollApp,
  enrollAgent,
  createGrant,
  type BootstrapResult,
  type ScopeSpec,
} from './bootstrap.js';
export {
  ensureVaultBootstrapped,
  lookupAppByName,
  ensureAppEnrolled,
  listActiveGrants,
  listEnrolledApps,
  markAppRevoked,
  purposeConceptId,
  type HostBootstrap,
  type EnrolledApp,
  type GrantSummary,
  type AppSummary,
} from './host.js';

export { registerScheduleCommands } from './commands/schedule.js';
export { registerTaskCommands } from './commands/tasks.js';
export { registerSocialCommands } from './commands/social.js';
export { registerFinanceCommands } from './commands/finance.js';
export { registerHealthCommands } from './commands/health.js';
export { registerKnowledgeCommands } from './commands/knowledge.js';
export { registerBusinessCommands } from './commands/business.js';
export { registerAttachmentCommands, ATTACHABLE_SUBJECTS } from './commands/attachments.js';
export { registerBookingCommands } from './commands/bookings.js';
export { registerSubscriptionCommands } from './commands/subscriptions.js';

export { parseIcs, type IcsEvent } from './ingest/ics.js';
export { parseVcards, normalizeHandle, type Vcard, type VcardIdentifier } from './ingest/vcard.js';
export { importIcsEvents, importVcardParties, type ImportResult } from './ingest/import.js';
export { importVaultExport, canonicalJson, type VaultExport } from './gateway/portability.js';
export type { ViewDefinition, ViewJoin, ViewResult } from './gateway/views.js';
export { appExtPath, type BackupResult } from './gateway/custody.js';
