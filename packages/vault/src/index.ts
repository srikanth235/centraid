// @centraid/vault — the Duaility personal ontology (11 schemas over two
// SQLite files) and the gateway that is the only door to it. Consumers import
// it namespaced (`import * as vault from '@centraid/vault'`).

export {
  openVaultDb,
  readBlobStoreSettings,
  type VaultDb,
  type OpenVaultOptions,
  type BlobStoreSettings,
} from './db.js';
export {
  BLOB_URI_PREFIX,
  blobUriFor,
  isBlobUri,
  shaOfBlobUri,
  sha256OfBytes,
  type BlobStore,
  type BlobRange,
  type BlobStat,
} from './blob/store.js';
export { FsBlobStore, MemoryBlobStore, type LocalBlobStore } from './blob/local.js';
export { S3BlobStore, type S3BlobStoreOptions, type S3Credentials } from './blob/s3.js';
export { BlobCustody, sealBlob, unsealBlob, type ReconcileResult } from './blob/custody.js';
export {
  stageBlobBytes,
  sweepBlobStaging,
  releaseBatchHold,
  mediaLocationPolicy,
  STAGING_TTL_HOURS,
  type StageBlobOptions,
  type StagedBlob,
} from './blob/staging.js';
export { MAX_INLINE_DATA_URI_CHARS, decodeDataUri } from './blob/mint.js';
export { promoteStagedBlob, type PromotedContent } from './blob/promote.js';
export { sniffMediaType, extractBlobMeta, type BlobMeta } from './blob/pipeline.js';
export {
  resolveServableBlob,
  liveBlobShas,
  type BlobResolveOutcome,
  type ServableBlob,
} from './blob/read.js';
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
  OrderBy,
  ReadRequest,
  ReadResult,
  SearchRequest,
  SearchResult,
  ChangesRequest,
  ChangesResult,
  ChangeEntry,
  InvokeRequest,
  InvokeOutcome,
  ParkedSummary,
  ConditionSpec,
  Citation,
  HandlerCtx,
  CommandHandler,
  CommandDefinition,
  RevealRequest,
  RevealResult,
} from './gateway/types.js';
export {
  SEALED_COLUMNS,
  SEALED_PLACEHOLDER,
  SEALED_PREFIX,
  isSealedValue,
  sealedColumnsOf,
  sealValue,
  unsealValue,
  sealAad,
  sealKeyFileFor,
  loadOrCreateSealKey,
  ephemeralSealKey,
  sealedHashToken,
  redactSealedInput,
} from './schema/sealed.js';
export {
  admitImportedRow,
  resolveHandle,
  type RevocationResult,
  type SweepResult,
} from './gateway/duties.js';
export { SEED_DEMO_ACTIVITY, SEED_PURGE_ACTIVITY } from './schema/seed.js';
export { type DemoPurgeResult } from './gateway/demo.js';
export { SEARCHABLE, type SearchableEntity } from './schema/fts.js';
export {
  VAULT_SQL_DEFAULT_ROWS,
  VAULT_SQL_MAX_ROWS,
  readOnlySqlRefusal,
  type VaultSqlRequest,
  type VaultSqlResult,
  type VaultSqlRows,
} from './gateway/sql.js';
export { buildAssistantContext } from './gateway/assistant-context.js';
export {
  CARDED_ENTITIES,
  CARD_PK,
  type RefRequest,
  type RefCard,
  type ResolveResult,
} from './gateway/cards.js';

export {
  bootstrapVault,
  enrollDevice,
  enrollApp,
  enrollAgent,
  createGrant,
  type BootstrapResult,
  type BootstrapVaultOptions,
  type ScopeSpec,
} from './bootstrap.js';
export {
  ensureVaultBootstrapped,
  renameVault,
  readVaultSettings,
  readVaultPresentation,
  updateVaultPresentation,
  type VaultPresentation,
  lookupAppByName,
  ensureAppEnrolled,
  listActiveGrants,
  listEnrolledApps,
  markAppRevoked,
  lookupAgentByName,
  ensureAgentEnrolled,
  listActiveAgentGrants,
  listEnrolledAgents,
  markAgentRevoked,
  purposeConceptId,
  type HostBootstrap,
  type EnrolledApp,
  type EnrolledAgent,
  type GrantSummary,
  type AppSummary,
  type AgentSummary,
} from './host.js';

export { registerScheduleCommands } from './commands/schedule.js';
export { registerTaskCommands } from './commands/tasks.js';
export { registerSocialCommands } from './commands/social.js';
export { registerFinanceCommands } from './commands/finance.js';
export { registerHealthCommands } from './commands/health.js';
export { registerKnowledgeCommands } from './commands/knowledge.js';
export { registerBusinessCommands } from './commands/business.js';
export { registerAttachmentCommands, ATTACHABLE_SUBJECTS } from './commands/attachments.js';
export { registerLinkCommands, RELATIONS_SCHEME_URI } from './commands/links.js';
export { registerPartyCommands } from './commands/parties.js';
export { registerMediaCommands } from './commands/media.js';
export { registerDocumentCommands, FOLDER_SCHEME_URI } from './commands/documents.js';
export { FLAGS_SCHEME_URI, STARRED_NOTATION } from './commands/flags.js';
export { registerHomeCommands } from './commands/home.js';
export { registerPeopleCommands, CIRCLE_SCHEME_URI } from './commands/people.js';
export { registerLockerCommands, LOCKER_ITEM_TYPE } from './commands/locker.js';
export { registerTallyCommands } from './commands/tally.js';
export { registerSyncCommands } from './commands/sync.js';

export { parseIcs, type IcsEvent } from './ingest/ics.js';
export {
  ensureConnection,
  stageCandidates,
  publishBatch,
  discardBatch,
  payloadHash,
  type StageCandidate,
  type StageResult,
  type PublishResult,
  type Publisher,
} from './ingest/staging.js';
export { PUBLISHERS } from './ingest/publishers.js';
export { stageFile, type StageFileOptions, type StageFileResult } from './ingest/stage-file.js';
export { parseMbox, threadKey, type MboxMessage, type MboxAttachment } from './ingest/mbox.js';
export { parseTransactionsCsv, parseCsvRows, type CsvTransaction } from './ingest/csv.js';
export { readZipEntries, type ZipEntry } from './ingest/zip.js';
export { parseVcards, normalizeHandle, type Vcard, type VcardIdentifier } from './ingest/vcard.js';
export { importIcsEvents, importVcardParties, type ImportResult } from './ingest/import.js';
export { importVaultExport, canonicalJson, type VaultExport } from './gateway/portability.js';
export type { ViewDefinition, ViewJoin, ViewResult } from './gateway/views.js';
export { type BackupResult } from './gateway/custody.js';
export {
  validateExtSpecs,
  canonicalSpecJson,
  extLogical,
  extPhysical,
  parseExtLogical,
  ExtSpecError,
  type ExtTableSpec,
  type ExtColumnSpec,
  type ExtIndexSpec,
  type ExtBand,
} from './schema/ext.js';
export {
  extAppIds,
  extCommandNames,
  extSearchable,
  assertExtSchemaOwnership,
  type ExtApplyOutcome,
} from './gateway/ext.js';
