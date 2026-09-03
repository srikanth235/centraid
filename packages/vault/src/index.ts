// governance: allow-repo-hygiene file-size-limit (#418) the package barrel is intentionally the single public API inventory; splitting exports would make consumers depend on internal paths
// @centraid/vault — the Duaility ontology and its sole gateway; consumers
// import it namespaced (`import * as vault from '@centraid/vault'`).

export {
  openVaultDb,
  readBlobStoreSettings,
  type VaultDb,
  type OpenVaultOptions,
  type BlobStoreSettings,
} from "./db.js";
// The per-vault memory budget and its division (#659). One owner for
// the split: `openVaultDb` applies it at open, a host's registry re-applies it
// to live planes on every mount/create/delete.
export {
  applyVaultFootprint,
  DEFAULT_VAULT_FOOTPRINT,
  MIN_VAULT_FILE_CACHE_BYTES,
  type VaultFootprintBudget,
  type AppliedVaultFootprint,
} from "./vault-footprint.js";
export {
  LockerAuthentication,
  LOCKER_ITEM_PERMIT_MS,
  LOCKER_PRIMARY_CREDENTIAL_ID,
  LOCKER_SESSION_TIMEOUT_MS,
  type LockerAuthRequest,
  type LockerAuthResult,
} from "./gateway/locker-auth.js";
export * from "./backup-policy.js";
export {
  isDiskFullError,
  asVaultDiskFullError,
  VaultDiskFullError,
  VaultBlobBackpressureError,
  VaultBlobAuthorizationError,
  VaultBlobHashMismatchError,
  VaultBlobRemoteUnavailableError,
  VaultBlobSessionError,
  VaultShareError,
  DiskFullTracker,
  sharedDiskFullTracker,
  type DiskFullEvent,
} from "./errors.js";
export {
  BLOB_URI_PREFIX,
  assertSha,
  blobUriFor,
  isBlobUri,
  shaOfBlobUri,
  sha256OfBytes,
  type BlobStore,
  type BlobRange,
  type BlobStat,
} from "./blob/store.js";
export {
  FsBlobStore,
  MemoryBlobStore,
  type BlobLinkOutcome,
  type LocalBlobStore,
} from "./blob/local.js";
// Share-by-placement (#599): the cross-vault share plane calls these, and
// they sit outside the per-vault handler path by design.
export {
  shareItemsToVault,
  unshareFromVault,
  moveOutOfVault,
  readShareOrigin,
  type ShareVaultRef,
  type ShareItemsToVaultInput,
  type ShareItemsToVaultResult,
  type UnshareFromVaultInput,
  type UnshareFromVaultResult,
  type MoveOutOfVaultInput,
  type ShareOriginRecord,
} from "./share/placement.js";
// The two halves of a share (#726): `readShareClosure` is origin-side and
// read-only, `projectShareClosure` audience-side and opens the single
// transaction. `WireClosure` between them is plain JSON.
export {
  isShareableItemType,
  CLOSURE_FORMAT_VERSION,
  type ShareableItemType,
  type WireClosure,
  type WireItem,
  type WireRows,
  type BlobManifestEntry,
  type ProjectedItem,
  type ProjectResult,
} from "./share/closure.js";
export {
  readShareClosure,
  type ReadShareClosureInput,
} from "./share/read-closure.js";
export {
  projectShareClosure,
  type ProjectShareClosureOptions,
} from "./share/project-closure.js";
// Projection is ingest (D11): the audience's own door, keyed by entity type so
// vault core never learns an app name.
export {
  type ProjectionIngestHook,
  type ProjectionIngestContext,
} from "./share/projection-ingest.js";
export {
  isCommonsCommandActable,
  commonsRoutesForCommand,
  COMMONS_COMMAND_ROUTES,
  COMMONS_CONTAINER_KEYS,
  type CommonsCommandRoute,
  type CommonsContainerKey,
  type CommonsRouteResolution,
} from "./share/commons-routing.js";
export {
  bindPartyToVault,
  revokePartyVaultBinding,
  type PartyVaultBindOutcome,
  type PartyVaultBindingRow,
  type PartyVaultRevokeOutcome,
} from "./share/party-vault-binding.js";
export {
  createCommonsGrant,
  ensureCommonsParty,
  readCommonsGrant,
  commonsClosure,
  commonsClosureSizeBytes,
  compactCommonsOperations,
  acknowledgeCommonsSeatCursor,
  assertCommonsWithinMax,
  compileCommons,
  appendCommonsOperation,
  appendCommonsOperationInTransaction,
  commonsGrantForCommand,
  COMMONS_MEMBER_IDENTITY_CHANGED,
  commonsMemberIdentityChangedReason,
  executeCommonsCommand,
  queueCommonsIntent,
  settleCommonsIntent,
  cancelCommonsIntent,
  expireParkedCommonsIntents,
  readCommonsIntentBasedOnSequence,
  COMMONS_INTENT_PARK_HORIZON_MS,
  STALE_CONTEXT_REASON_PREFIX,
  retainCommonsItem,
  removeCommonsFromSeat,
  transferCommonsSteward,
  commonsCurrentSize,
  type CommonsCapability,
  type CommonsDeparturePolicy,
  type CommonsMemberInput,
  type CommonsGrantRecord,
  type CompiledCommonsSeat,
  type CommonsCommandDecision,
  type CommonsIntentStatus,
  type ExecuteCommonsCommandInput,
  type ExecuteCommonsCommandResult,
} from "./share/commons.js";
// The steward's per-intent answer (#872): approve re-enters the signed rail,
// decline settles `denied` with the steward's own words. Neither is a second
// write path — see the module header.
export {
  decideCommonsIntent,
  type CommonsIntentDecisionResult,
  type DecideCommonsIntentInput,
} from "./share/commons-decide.js";
export {
  listCommonsGrants,
  findCommonsGrantForContainer,
  ensureCommonsGrant,
  upsertCommonsMember,
  refuseCommonsMember,
  removeCommonsMember,
  revokeCommonsGrant,
  commonsSeats,
  recompileCommonsGrants,
  scrubCommonsSeat,
  type CommonsMemberRecord,
  type CommonsGrantView,
} from "./share/commons-lifecycle.js";
export {
  readCommonsCursor,
  type CommonsCursor,
} from "./share/commons-cursor.js";
export {
  CommonsHistoryError,
  isCommonsHistoryError,
  commonsGenesisHash,
  commonsOpHash,
  commonsOpChainFields,
  commonsStateDigest,
  readCommonsChainHead,
  readCommonsVerified,
  verifyCommonsCheckpoint,
  type CommonsCheckpointAttestation,
  type CommonsHistoryFaultTag,
  type CommonsOpChainFields,
  type CommonsVerifiedPoint,
} from "./share/commons-chain.js";
export {
  commonsIntentBytes,
  signCommonsIntent,
  verifyCommonsIntent,
  type CommonsMemberSignature,
} from "./share/commons-signature.js";
export {
  exportCommonsBootstrap,
  exportCommonsSyncFrame,
  applyCommonsBootstrap,
  applyCommonsIncrement,
  applyCommonsTombstone,
  isCommonsIncrementUnusable,
  queueCommonsInvitation,
  createCommonsClaimInvitation,
  claimCommonsInvitation,
  listCommonsInvitations,
  answerCommonsInvitation,
  type CommonsBootstrap,
  type CommonsIncrement,
  type CommonsTombstone,
  type CommonsSyncFrame,
  type CommonsInvitationRecord,
} from "./share/commons-bootstrap.js";
// Command-tail replay (#750 invariant 7): catch-up proportional to what
// changed, because the steward ships the operations rather than the rows.
export {
  isCommonsReplayError,
  replicaInvocationKey,
  type CommonsReplicaExecutor,
  type CommonsTailBlob,
} from "./share/commons-replay.js";
// Replica-export recovery: a member re-founds a group whose steward is gone
// (#731). Deliberate ceremony — see the module header.
export {
  recoverCommonsFromReplica,
  readCommonsRecoveryLineage,
  type CommonsRecoveryLineage,
  type CommonsRecoveryRefusal,
  type CommonsRecoveryResult,
  type RecoverCommonsFromReplicaInput,
} from "./share/commons-recovery.js";
// The GRANT PLANE (#825): a share is a standing grant, fulfillment is
// per-audience-vault delivery state, and the channel is the party↔vault
// binding read as one state. Commons stays the edit-fulfillment strategy.
export {
  audienceExists,
  createShareGrant,
  declineShare,
  maskedPartiesForSubject,
  readShareGrant,
  readLiveShareGrant,
  readLiveShareRefusal,
  resolveGrantAudienceParties,
  grantPlacementAuthority,
  revokeShareGrant,
  revokeShareRefusal,
  listShareGrantsForAudience,
  listShareGrantsForSubject,
  listLiveGrantsReachingParty,
  resolveAudienceParties,
  setFulfillmentState,
  readFulfillment,
  listFulfillment,
  UnofferableSubjectError,
  type CreateShareGrantInput,
  type CreateShareGrantResult,
  type RevokeShareGrantResult,
  type ShareFulfillmentRecord,
  type ShareFulfillmentState,
  type ShareGrantAudience,
  type ShareGrantAudienceKind,
  type ShareGrantCapability,
  type ShareGrantRecord,
  type DeclineShareInput,
  type DeclineShareResult,
} from "./grant/grant-store.js";
// The closed declaration of what the plane may be asked (#883).
export {
  AUTHORITY_REGISTRY,
  authorityStrategyFor,
  authorityTriple,
  enforcementLocus,
  isRegisteredAuthority,
  registeredVerbs,
  subjectWokenBy,
  wakeTypesForSubjectTypes,
  type AuthorityPrincipalKind,
  type AuthorityStrategy,
  type AuthorityTriple,
  type EnforcementLocus,
} from "./grant/authority-registry.js";
export {
  grantPhrase,
  revokePromiseCopy,
  unregisteredVerbCopy,
  verbConflictCopy,
  type GrantPhrase,
  type GrantPhraseName,
} from "./grant/phrases.js";
export {
  isOfferableSubjectType,
  fulfillmentAnswerFor,
  shareSubjectDeclaration,
  SHARE_SUBJECT_REGISTRY,
  type ShareFulfillmentStrategy,
  type ShareSubjectDeclaration,
} from "./grant/subject-registry.js";
export {
  channelForParty,
  type ShareChannel,
  type ShareChannelState,
} from "./grant/channel.js";
// Fulfillment: the act of keeping a grant true. View re-projects the subject
// over the closure transport, edit routes back through the commons rail, and
// revoke propagates a removal instead of pretending it reached the peer.
export {
  createGrantProjectionMemory,
  fulfillShareGrant,
  propagateShareGrantRevocation,
  ShareGrantMaxSizeError,
  type GrantProjectionMemory,
  type FulfillShareGrantInput,
  type GrantFulfillmentResult,
  type GrantFulfillmentStep,
  type GrantRemovalResult,
  type GrantRemovalStep,
  type PropagateShareGrantRevocationInput,
} from "./grant/fulfillment.js";
export {
  routeShareGrantEdit,
  SHARE_GRANT_CO_CONTRIBUTION_COMMANDS,
  SHARE_GRANT_CO_CONTRIBUTION_TYPES,
  type ShareGrantEditRoute,
} from "./grant/fulfillment-edit.js";
// The LOCAL orphan reclaim (#599 d11): each vault unlinks only its own CAS
// directory entries, so hardlinked bytes survive until the last vault lets go.
export {
  sweepLocalOrphans,
  type LocalOrphanSweepOptions,
  type LocalOrphanSweepResult,
  type LocalOrphanSweepTarget,
} from "./blob/local-orphan-sweep.js";
export { type BlobPlacement, type BlobPlacementMode } from "./share/blobs.js";
export {
  S3BlobStore,
  MULTIPART_THRESHOLD_BYTES,
  type S3BlobStoreOptions,
  type S3Credentials,
} from "./blob/s3.js";
export {
  S3TransferStore,
  s3TemporaryUploadPrefix,
} from "./blob/s3-transfer.js";
export {
  BlobTransferCoordinator,
  type BeginBlobIngressInput,
  type BeginBlobIngressResult,
  type BlobTransferStatus,
  type CommittedBlob,
} from "./blob/transfers.js";
export {
  type DirectBlobDownloadResult,
  type DirectBlobInitInput,
  type DirectBlobInitResult,
} from "./blob/direct-transfers.js";
export {
  BlobContentKeyRegistry,
  type DeviceWrappedContentKey,
} from "./blob/content-keys.js";
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
} from "./blob/custody.js";
// The custody ROLLUP projection (#711): exported so `storage/status` answers
// with the same buckets `blob.custody_rollup` gives an app, rather than each
// client deriving its own idea of "freeable" (#712).
export {
  custodyRollup,
  refreshCustodyRollup,
  type CustodyRollup,
  type CustodyRollupBucket,
  type CustodyRollupBucketTotals,
} from "./blob/custody-rollup.js";
export {
  BlobCache,
  readBlobCacheSettings,
  CACHE_BUDGET_FLOOR_BYTES,
  CACHE_BUDGET_CEILING_BYTES,
  DEFAULT_REPLICATION_CONCURRENCY,
  replicationConcurrencyFromEnv,
  type BlobCacheSettings,
  type BlobCacheOptions,
  type BlobMetrics,
  type CacheStatfs,
} from "./blob/cache.js";
export { ReplicaIndex, AccessIndex } from "./blob/replica-index.js";
export type { ReplicaStore } from "./blob/replica-index.js";
export {
  stageBlobBytes,
  sweepBlobStaging,
  releaseBatchHold,
  mediaLocationPolicy,
  STAGING_TTL_HOURS,
  type StageBlobOptions,
  type StagedBlob,
} from "./blob/staging.js";
export {
  DERIVATIVE_REGISTRY,
  DERIVATIVE_VARIANTS,
  isBinaryDerivative,
  isDerivativeVariant,
  validateDerivativeContribution,
  type BinaryDerivativeVariant,
  type DerivativeBackstop,
  type DerivativeSpec,
  type DerivativeVariant,
  type InlineDerivativeVariant,
  type ValidatedDerivative,
} from "./blob/derivatives.js";
export { MAX_INLINE_DATA_URI_CHARS, decodeDataUri } from "./blob/mint.js";
export { promoteStagedBlob, type PromotedContent } from "./blob/promote.js";
export {
  sniffMediaType,
  extractBlobMeta,
  type BlobMeta,
} from "./blob/pipeline.js";
export {
  resolveServableBlob,
  resolveDerivativeShas,
  liveBlobShas,
  liveBlobShasCached,
  type BlobResolveOutcome,
  type ServableBlob,
  type DerivativeRef,
} from "./blob/read.js";
export {
  backfillPreviews,
  TINY_EDGE,
  MEDIUM_EDGE,
  PREVIEW_LADDER,
  PREVIEW_BACKFILL_BATCH,
  type PreviewCodec,
  type PreviewOutput,
  type PreviewBackfillResult,
} from "./blob/preview.js";
export { uuidv7, nowIso, sha256Hex } from "./ids.js";
export {
  notifyReplicaCommit,
  subscribeReplicaCommits,
} from "./replica/doorbell.js";
export { jitterDelayMs } from "./timer-jitter.js";
export {
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  migrate,
  VaultSchemaAheadError,
} from "./schema/migrate.js";
export {
  resolveEntity,
  listVaultEntities,
  entityDeclaration,
  assertRegistryLabels,
  assertVaultRegistryLabels,
  LOCAL_TABLES,
  VAULT_ENTITIES,
  VAULT_TABLES,
  type EntityRef,
  type EntityLifecycle,
  type VaultEntityDeclaration,
} from "./schema/tables.js";
// The two BANDS in `vault.db` beside the life data (#916): evidence and the
// conversation ledger. Names only — a host excludes them by band from the
// portable export, the replica and the support bundle, and the retention
// windows say how long each keeps rows in the live file.
export {
  AUDIT_BAND_TABLES,
  AUDIT_APPEND_ONLY_TABLES,
  RETENTION_WINDOWS,
} from "./schema/audit.js";
export { LEDGER_BAND_TABLES } from "./schema/ledger.js";
// The Vault Atlas mapping: table → kind → pack (#441).
export {
  ONTOLOGY_PACKS,
  MACHINERY_BANDS,
  ATLAS_PACK_LABELS,
  packKindOf,
  humanizeKind,
  atlasTables,
  atlasTablesByPhysical,
  atlasTablesByLogical,
  type AtlasPackKind,
  type AtlasTableEntry,
} from "./schema/atlas.js";
// The Atlas census/graph/pulse payload builders (#441).
export {
  atlasCensus,
  atlasGraph,
  atlasPulse,
  ATLAS_GRAPH_CENTER,
  ATLAS_PULSE_WINDOW_DAYS,
  type AtlasCensusPayload,
  type AtlasCensusPack,
  type AtlasCensusTable,
  type AtlasGraphPayload,
  type AtlasGraphNode,
  type AtlasFkEdge,
  type AtlasAuthoredLink,
  type AtlasPulsePayload,
  type AtlasPulseSeries,
  type AtlasPulseDay,
} from "./schema/atlas-census.js";
// The Browse read side (#441): table picker, keyset row grid, column
// metadata, FK reference search, dependent preview.
export {
  browseTableList,
  browseColumns,
  browseRows,
  browseRow,
  displayFieldOf,
  primaryKeyColumns,
  keysetKey,
  resolveBrowseTable,
  BrowseError,
  BROWSE_MAX_LIMIT,
  BROWSE_DEFAULT_LIMIT,
  BROWSE_REF_SEARCH_LIMIT,
  DISPLAY_FIELD_CANDIDATES,
  type BrowseTableEntry,
  type BrowseColumn,
  type BrowseColumnsResult,
  type BrowseRowsParams,
  type BrowseRowsResult,
  type BrowseRowResult,
} from "./schema/atlas-browse.js";
export {
  browseRefSearch,
  browseDependents,
  type BrowseRefHit,
  type BrowseDependent,
  type BrowseDependentsResult,
} from "./schema/atlas-browse-refs.js";
export {
  formatReplicaCursor,
  parseReplicaCursor,
  InvalidReplicaCursorError,
  type ReplicaCursor,
  type ReplicaCursorInput,
} from "./replica/cursor.js";
export {
  REPLICA_COMPACTION_HELD_ENTITIES,
  REPLICA_RETENTION_DAYS,
  REPLICA_RETENTION_MAX_ENTRIES,
  ReplicaRebootstrapRequiredError,
  appendReplicaChange,
  bumpReplicaEpoch,
  currentReplicaLogState,
  initializeReplicaProtocol,
  pruneReplicaChanges,
  readReplicaChanges,
  refreshReplicaTriggers,
  type AppendReplicaChangeInput,
  type BumpReplicaEpochOptions,
  type PruneReplicaChangesOptions,
  type ReadReplicaChangesOptions,
  type ReplicaChangeEntry,
  type ReplicaChangeOp,
  type ReplicaChangePage,
  type ReplicaLogState,
  type ReplicaPruneResult,
  type ReplicaRebootstrapReason,
} from "./replica/change-log.js";
export { REPLICA_SCHEMA_EPOCH } from "./schema/replica.js";
// The engine-computed cascade every purge runs, exported so the
// declared-writes gate unions it rather than have a manifest restate it.
export {
  ENTITY_POINTERS,
  ENTITY_REF_EXCLUSIONS,
  type EntityPointer,
  type EntityRefPair,
} from "./schema/entity-refs.js";
export {
  PARTY_POINTER_REGISTRY,
  type PartyPointer,
} from "./schema/party-pointers.js";
export {
  DEFAULT_REPLICA_MAX_VALUE_BYTES,
  readReplicaRow,
  readReplicaRows,
  withReplicaSnapshot,
  type ReadReplicaRowsOptions,
  type ReplicaRow,
  type ReplicaRowsPage,
  type ReplicaSnapshotReader,
  type ReplicaSnapshotResult,
} from "./replica/snapshot.js";
export { replicaUnavailableColumnsOf } from "./replica/unavailable-columns.js";
export {
  deleteReplicaIntentOutcomesForDevice,
  listReplicaIntentOutcomes,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  recordReplicaIntentOutcomeInTransaction,
  transitionReplicaIntentOutcome,
  type ListReplicaIntentOutcomesOptions,
  type RecordReplicaIntentOutcomeInput,
  type ReplicaIntentOutcome,
  type ReplicaIntentStatus,
  type TransitionReplicaIntentOutcomeInput,
} from "./replica/intents.js";
export {
  DEFAULT_REPLICA_INVOCATION_REPAIR_BATCH_SIZE,
  ReplicaInvocationRepairError,
  repairReplicaInvocationCommits,
  readReplicaInvocationCommit,
  recordReplicaInvocationCommitInTransaction,
  type RecordReplicaInvocationCommitInput,
  type ReplicaInvocationAudit,
  type ReplicaInvocationAuditCheck,
  type ReplicaInvocationAuditCitation,
  type ReplicaInvocationAuditWrite,
  type ReplicaInvocationCommit,
  type ReplicaInvocationRepairFailure,
  type ReplicaInvocationRepairResult,
} from "./replica/invocation-commits.js";
export {
  saveDurableParkedPayload,
  readDurableParkedPayload,
  listDurableParkedPayloads,
  deleteDurableParkedPayload,
  deleteDurableParkedPayloadsForGrant,
  type DurableParkedPayload,
} from "./replica/parked.js";

export { createGateway, Gateway } from "./gateway/gateway.js";
export { GatewayError, DEFAULT_PURPOSE } from "./gateway/types.js";
export {
  bumpWorkCounter,
  gatewayWorkCounters,
  instrumentVaultStatements,
} from "./gateway/work-counters.js";
export {
  evaluateAccess,
  type AccessAllow,
  type AccessDecision,
} from "./gateway/access.js";
export {
  compileFilters,
  compileReplicaHistoricalFilters,
  type CompiledFilter,
} from "./gateway/filters.js";
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
} from "./gateway/types.js";
export {
  SEALED_COLUMNS,
  SEALED_ENFORCEMENT_POINTS,
  SEALED_LEAK_SURFACES,
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
} from "./schema/sealed.js";
export {
  identityKeyFileFor,
  ephemeralVaultIdentitySeed,
  loadOrCreateVaultIdentitySeed,
  VaultIdentityMismatchError,
  vaultIdentityPublicKey,
  signWithVaultIdentity,
  verifyVaultIdentitySignature,
} from "./schema/vault-identity.js";
export {
  KeyStore,
  KeyStoreError,
  aesGcmKeyProtector,
  KEY_STORE_ENVELOPE_MAGIC,
  KEY_STORE_SECRET_BYTES,
  type KeyProtector,
  type KeyStoreOptions,
} from "./schema/key-store.js";
export { resealVaultKey, type ResealResult } from "./gateway/reseal.js";
export { writeReceipt } from "./gateway/evidence.js";
export {
  admitImportedRow,
  resolveHandle,
  type RevocationResult,
  type SweepResult,
} from "./gateway/duties.js";
export { SEED_DEMO_ACTIVITY, SEED_PURGE_ACTIVITY } from "./schema/seed.js";
export { type DemoPurgeResult } from "./gateway/demo.js";
export { SEARCHABLE, type SearchableEntity } from "./schema/fts.js";
export {
  VAULT_SQL_DEFAULT_ROWS,
  VAULT_SQL_MAX_ROWS,
  readOnlySqlRefusal,
  type VaultSqlRequest,
  type VaultSqlResult,
  type VaultSqlRows,
} from "./gateway/sql.js";
export { buildAssistantContext } from "./gateway/assistant-context.js";
export {
  CARDED_ENTITIES,
  CARD_PK,
  type RefRequest,
  type RefCard,
  type ResolveResult,
} from "./gateway/cards.js";

export {
  bootstrapVault,
  enrollDevice,
  enrollApp,
  enrollAgent,
  createGrant,
  type BootstrapResult,
  type BootstrapVaultOptions,
  type ScopeSpec,
} from "./bootstrap.js";
export {
  recoverVaultBootstrap,
  renameVault,
  readVaultSettings,
  updateBlobStoreSettings,
  readEnrichSettings,
  updateEnrichSettings,
  type EnrichSettings,
  type EnrichTier,
  readVaultPresentation,
  updateVaultPresentation,
  readVaultPersonal,
  markVaultPersonal,
  type VaultPresentation,
  lookupAppByName,
  ensureAppEnrolled,
  listActiveGrants,
  listEnrolledApps,
  markAppRevoked,
  listInstalledApps,
  setAppLabel,
  type InstalledAppRow,
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
} from "./host.js";
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
} from "./install-memory.js";
export { scopeCovers, type ScopeExtent } from "./scope-extent.js";

export { registerScheduleCommands } from "./commands/schedule.js";
export { registerTaskCommands } from "./commands/tasks.js";
export { registerSocialCommands } from "./commands/social.js";
export { registerKnowledgeCommands } from "./commands/knowledge.js";
export {
  registerAttachmentCommands,
  ATTACHABLE_SUBJECTS,
} from "./commands/attachments.js";
export { registerTagCommands, TAGGABLE_SUBJECTS } from "./commands/tags.js";
export {
  registerLinkCommands,
  RELATIONS_SCHEME_URI,
} from "./commands/links.js";
export { registerPartyCommands } from "./commands/parties.js";
export { registerMediaCommands } from "./commands/media.js";
export { registerMediaGazetteerCommands } from "./commands/media-gazetteer.js";
export {
  registerDocumentCommands,
  FOLDER_SCHEME_URI,
} from "./commands/documents.js";
export { FLAGS_SCHEME_URI, STARRED_NOTATION } from "./commands/flags.js";
export { registerPeopleCommands, LIST_SCHEME_URI } from "./commands/people.js";
export { registerLockerCommands, LOCKER_ITEM_TYPE } from "./commands/locker.js";
export { registerTallyCommands } from "./commands/tally.js";
export { registerSyncCommands } from "./commands/sync.js";
export { registerEnrichCommands } from "./commands/enrich.js";
export { registerOutboxCommands } from "./commands/outbox.js";
// The ONE writer of the share half of the authority plane (#883).
export { registerShareCommands, SHARE_COMMANDS } from "./commands/share.js";
// The Browse write trio: journalled row CRUD (#441).
export {
  registerAtlasCommands,
  ATLAS_OWNER_SCHEMA,
  AtlasDeleteBlockedError,
  type AtlasDependentsRefusal,
} from "./commands/atlas.js";

export {
  AGENT_CONTENT_VARIANTS,
  AGENT_CONTENT_DEFAULT_MAX_BYTES,
  AGENT_CONTENT_HARD_MAX_BYTES,
  resolveAgentContent,
  type AgentContentOutcome,
  type AgentContentVariant,
} from "./enrich/content.js";
export {
  FACE_CLUSTER_MAX_DISTANCE,
  FACE_MIN_CLUSTER_SIZE,
  FACE_PARTY_MAX_DISTANCE,
  FACE_REGION_TARGET_TYPE,
  rebuildFaceClusters,
  type FaceClusterResult,
} from "./enrich/face-clusters.js";
export {
  BUILT_IN_PROFILE,
  preferredDerivation,
  stampDerivation,
  stampedModel,
  type DerivationQuery,
  type DerivationRecord,
  type DerivationStamp,
} from "./enrich/derivation.js";
export {
  ENRICH_SCOPE_TYPES,
  ENRICH_TRIGGERS,
  deleteEnrichPolicyRule,
  listEnrichPolicyRules,
  putEnrichPolicyRule,
  readEnrichPolicyRule,
  readEnrichPolicyRuleChain,
  type EnrichPolicyRule,
  type EnrichPolicyRuleInput,
  type EnrichScope,
  type EnrichScopeType,
  type EnrichTrigger,
} from "./enrich/policy-rules.js";
export {
  ENRICH_EGRESS_CLASSES,
  listEnrichConsent,
  readEnrichConsent,
  recordEnrichConsent,
  type EnrichConsentDecision,
  type EnrichConsentInput,
  type EnrichConsentKey,
  type EnrichConsentRecord,
  type EnrichEgressClass,
} from "./enrich/egress-consent.js";
export {
  DEFAULT_ENRICHMENT_LEASE_TTL_MS,
  ENRICHMENT_CAPABILITIES,
  MAX_ENRICHMENT_LEASE_TTL_MS,
  MIN_ENRICHMENT_LEASE_TTL_MS,
  completeEnrichmentLease,
  drainSatisfiedEnrichmentRequests,
  enrichmentQueueDepth,
  leaseNextEnrichmentRequest,
  queueDeviceEnrichmentRequest,
  queueMissingDeviceEnrichmentBacklog,
  queueMissingDeviceEnrichmentRequests,
  releaseEnrichmentLease,
  releaseExpiredEnrichmentLeases,
  type DeviceEnrichmentSource,
  type EnrichmentCapability,
  type EnrichmentLease,
} from "./enrich/leases.js";
export {
  ENRICH_DOMAINS,
  isEnrichTier,
  readEnrichPolicyResolutionInput,
  readEnrichPolicyTier,
  type EnrichDomain,
  type EnrichPolicyResolutionInput,
} from "./enrich/policy.js";
export {
  compareModelIds,
  makeModelId,
  parseModelId,
  type ModelId,
} from "./enrich/model-id.js";
export {
  hexHamming,
  registerCosineFn,
  registerHammingFn,
  encodeVector,
  decodeVector,
  cosine,
  rankEmbeddingsWithVec,
  scanEmbeddings,
  type RankEmbeddingsOptions,
  type SemanticHit,
} from "./enrich/similarity.js";
export {
  PHOTO_EMBEDDING_TARGET_TYPE,
  countPhotoEmbeddings,
  rankLivePhotoEmbeddings,
  type PhotoEmbeddingHit,
  type PhotoRankOptions,
} from "./enrich/photo-search.js";
export { ENRICH_PUBLISHERS, tagNotation } from "./ingest/enrich-publishers.js";
export { VISION_SCHEME_URI, DOCTYPE_SCHEME_URI } from "./schema/enrich.js";

export { parseIcs, type IcsEvent } from "./ingest/ics.js";
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
} from "./ingest/staging.js";
export { PUBLISHERS } from "./ingest/publishers.js";
export {
  stageFile,
  type StageFileOptions,
  type StageFileResult,
} from "./ingest/stage-file.js";
export {
  isMediaPath,
  parseTakeoutSidecar,
  planTakeout,
  type SidecarFacts,
  type TakeoutMediaEntry,
  type TakeoutPlan,
} from "./ingest/takeout-sidecar.js";
export {
  parseMbox,
  threadKey,
  type MboxMessage,
  type MboxAttachment,
} from "./ingest/mbox.js";
export {
  parseTransactionsCsv,
  parseCsvRows,
  type CsvTransaction,
} from "./ingest/csv.js";
export {
  readZipEntries,
  writeZipEntries,
  type ZipEntry,
} from "./ingest/zip.js";
export {
  parseMarkdownNote,
  serializeMarkdownNote,
  type MarkdownNote,
} from "./ingest/markdown.js";
export {
  parseVcards,
  normalizeHandle,
  type Vcard,
  type VcardIdentifier,
} from "./ingest/vcard.js";
export {
  importIcsEvents,
  importVcardParties,
  type ImportResult,
} from "./ingest/import.js";
export {
  importVaultExport,
  canonicalJson,
  type ImportVaultExportOptions,
  type VaultExport,
} from "./gateway/portability.js";
export {
  exportPortableVault,
  importPortableVault,
  verifyPortableVault,
  type PortableExport,
  type PortableExportOptions,
  type PortableImportOptions,
  type PortableManifest,
  type PortableManifestFile,
} from "./gateway/portable-export.js";

// The portable bundle's password-wrapped seal-key custody kit (#630).
export {
  PORTABLE_CUSTODY_KIT_PATH,
  custodyKitSealKey,
  parsePortableCustodyKit,
  wrapPortableCustodyKit,
} from "./gateway/portable-custody.js";
export type {
  PortableCustodyKit,
  WrappedPortableCustodyKit,
} from "./gateway/portable-custody.js";
export {
  exportIcs,
  exportVcards,
  exportTransactionsCsv,
  exportMarkdownDirectory,
} from "./gateway/portable-adapters.js";
export {
  backupVault,
  checkpointVault,
  sha256File,
  type BackupResult,
} from "./gateway/custody.js";
export {
  WalShipper,
  type PendingBase,
  type UploadableWalFile,
  type WalShipperLogger,
  type WalShipperOptions,
  type WalTickReport,
} from "./wal-shipper.js";
export {
  verifyRestoredPair,
  type RestoredPairReport,
  type SealKeyVerdict,
} from "./restore-check.js";
export {
  SNAPSHOT_EXCLUSIONS,
  compareSnapshot,
  primaryKeyOf as snapshotPrimaryKeyOf,
  snapshotTable,
  snapshotTables,
  snapshotVault,
  type SnapshotComparison,
  type TableSnapshot,
  type VaultSnapshot,
} from "./golden-snapshot.js";
export {
  assertVaultHealthy,
  assertVaultTreeHealthy,
  formatDoctorReport,
  vaultDoctor,
  type DoctorClass,
  type DoctorFinding,
  type DoctorReport,
} from "./doctor.js";
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
} from "./schema/ext.js";
export {
  extAppIds,
  extCommandNames,
  extSearchable,
  assertExtSchemaOwnership,
  type ExtApplyOutcome,
} from "./gateway/ext.js";

// Issue #367 §E: vault.db sizing, archival, FTS budget, and inline threshold.
export {
  dbSizeBreakdown,
  type DbSizeBreakdown,
  type TableStatsMethod,
  type TableSizeEntry,
} from "./schema/table-stats.js";
export {
  DEFAULT_JOURNAL_ARCHIVE_WINDOW_DAYS,
  DEFAULT_JOURNAL_ARCHIVE_MAX_ROWS,
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
} from "./journal-archive.js";
// Conversation-ledger band GC roots (#438 decision 6) + the prune
// custody latch (decision 3) — vault-side helpers the gateway composes so the
// app-engine archival engine and every CAS GC path stay correct without the
// vault importing app-engine.
export { conversationArchiveShas } from "./conversation-archive-roots.js";
export { blobCustodyProven } from "./blob/custody-proven.js";
export {
  FTS_BODY_INDEX_BUDGET_CHARS,
  truncateForIndex,
  rebuildFtsIndex,
} from "./schema/fts.js";
export { rebuildDocumentFtsIndex } from "./schema/blob.js";
export {
  INLINE_BODY_BUDGET_BYTES,
  InlineBodyTooLargeError,
  assertTextBodyWithinBudget,
  assertInlineDataUriWithinBudget,
  scanInlineBodyViolations,
  type InlineBodyViolationEntry,
  type InlineBodyViolationScan,
} from "./commands/inline-body-guard.js";

// Bounded vault-side retention and its size ladder (#659 L1/L3/L4).
// `runVaultMaintenance` is the single hookpoint a host sweep calls;
// `decideVaultMaintenance` is the pure policy in front of it, shaped like
// journal-limit.ts's ladder for the ledger band.
export {
  ENTITY_REVISION_PRUNE_CAP,
  pruneExpiredEntityRevisions,
  type EntityRevisionPruneResult,
} from "./commands/entity-revisions.js";
export {
  RETENTION_ROW_CAP,
  RETENTION_DEFAULT_KEEP_DAYS,
  sweepBoundedRetention,
  type RetentionTable,
  type RetentionTableResult,
  type RetentionSweepOptions,
  type RetentionSweepResult,
} from "./retention.js";
export {
  VAULT_RETENTION_LADDER,
  VAULT_RETENTION_DEFAULT_KEEP_DAYS,
  VAULT_RETENTION_FLOOR_KEEP_DAYS,
  decideVaultMaintenance,
  runVaultMaintenance,
  vaultFileBytes,
  type VaultMaintenanceDecisionInput,
  type VaultMaintenanceDecision,
  type VaultMaintenanceResult,
} from "./vault-limit.js";
// The batched, resumable data-rewrite primitive for migration rungs (#659).
export {
  DEFAULT_MIGRATION_BATCH_SIZE,
  runBatchedMigration,
  type BatchedRewrite,
  type BatchedMigrationResult,
} from "./schema/migrate.js";
