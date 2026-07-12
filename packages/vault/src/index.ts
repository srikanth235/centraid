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
  isDiskFullError,
  asVaultDiskFullError,
  VaultDiskFullError,
  DiskFullTracker,
  sharedDiskFullTracker,
  type DiskFullEvent,
} from './errors.js';
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
export {
  S3BlobStore,
  MULTIPART_THRESHOLD_BYTES,
  type S3BlobStoreOptions,
  type S3Credentials,
} from './blob/s3.js';
export {
  BlobCustody,
  sealBlob,
  unsealBlob,
  sealBlobStream,
  custodyStateCounts,
  custodyStateByteCounts,
  type ReconcileResult,
  type ReconcileOptions,
  type CustodyState,
  type BlobSweepStatus,
  type RemoteTier,
} from './blob/custody.js';
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
  VaultSchemaAheadError,
} from './schema/migrate.js';
export {
  resolveEntity,
  listVaultEntities,
  VAULT_TABLES,
  JOURNAL_TABLES,
  type EntityRef,
} from './schema/tables.js';

export { createGateway, Gateway } from './gateway/gateway.js';
export { GatewayError, DEFAULT_PURPOSE } from './gateway/types.js';
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
  loadSealKey,
  createSealKey,
  resolveSealKey,
  sealKeyFingerprint,
  readSealKeyFingerprint,
  stampSealKeyFingerprint,
  SealKeyError,
  ephemeralSealKey,
  sealedHashToken,
  redactSealedInput,
  scrubSealedText,
  writeSealKeyFile,
} from './schema/sealed.js';
export { resealVaultKey, type ResealResult } from './gateway/reseal.js';
export { writeReceipt } from './gateway/evidence.js';
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
  updateBlobStoreSettings,
  readEnrichSettings,
  updateEnrichSettings,
  type EnrichSettings,
  type EnrichTier,
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
export {
  writeScopeTombstones,
  listScopeTombstones,
  clearScopeTombstones,
  clearAllScopeTombstones,
  hasGrantHistory,
  openScopeRequest,
  closeObsoleteScopeRequest,
  listOpenScopeRequests,
  getOpenScopeRequest,
  markScopeRequestDecided,
  type ScopeTriple,
  type ScopeRequestSummary,
} from './install-memory.js';

export { registerScheduleCommands } from './commands/schedule.js';
export { registerTaskCommands } from './commands/tasks.js';
export { registerSocialCommands } from './commands/social.js';
export { registerFinanceCommands } from './commands/finance.js';
export { registerHealthCommands } from './commands/health.js';
export { registerKnowledgeCommands } from './commands/knowledge.js';
export { registerBusinessCommands } from './commands/business.js';
export { registerAttachmentCommands, ATTACHABLE_SUBJECTS } from './commands/attachments.js';
export { registerTagCommands, TAGGABLE_SUBJECTS } from './commands/tags.js';
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
export { registerEnrichCommands } from './commands/enrich.js';
export { registerOutboxCommands } from './commands/outbox.js';
export { registerJudgmentCommands } from './commands/judgment.js';

export {
  AGENT_CONTENT_VARIANTS,
  AGENT_CONTENT_DEFAULT_MAX_BYTES,
  AGENT_CONTENT_HARD_MAX_BYTES,
  resolveAgentContent,
  type AgentContentOutcome,
  type AgentContentVariant,
} from './enrich/content.js';
export {
  hexHamming,
  registerHammingFn,
  encodeVector,
  decodeVector,
  cosine,
  scanEmbeddings,
  type SemanticHit,
} from './enrich/similarity.js';
export { ENRICH_PUBLISHERS, tagNotation } from './ingest/enrich-publishers.js';
export { VISION_SCHEME_URI, DOCTYPE_SCHEME_URI } from './schema/enrich.js';

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
export { stageVaultDbs, type BackupResult, type StageDbsResult } from './gateway/custody.js';
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

// --- issue #367 §E: vault.db growth-runway (dbstat sizing, journal
// archival, FTS index budget, inline-body threshold) — appended as one
// block, kept distinct from the exports above. ---
export {
  dbSizeBreakdown,
  type DbSizeBreakdown,
  type TableStatsMethod,
  type TableSizeEntry,
} from './schema/table-stats.js';
export {
  DEFAULT_JOURNAL_ARCHIVE_WINDOW_DAYS,
  archivedSegmentShas,
  runJournalArchival,
  readArchivedSegment,
  verifyArchivedSegment,
  listArchiveManifests,
  findArchiveManifest,
  type JournalArchiveStream,
  type JournalArchiveManifestRow,
  type JournalArchivalOptions,
  type JournalArchivalResult,
  type ArchivedSegmentRows,
  type ArchiveVerification,
} from './journal-archive.js';
export {
  FTS_BODY_INDEX_BUDGET_CHARS,
  truncateForIndex,
  rebuildFtsIndex,
} from './schema/fts.js';
export { rebuildDocumentFtsIndex } from './schema/blob.js';
export {
  INLINE_BODY_BUDGET_BYTES,
  InlineBodyTooLargeError,
  assertTextBodyWithinBudget,
  assertInlineDataUriWithinBudget,
  scanInlineBodyViolations,
  type InlineBodyViolationEntry,
  type InlineBodyViolationScan,
} from './commands/inline-body-guard.js';
