export {
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  PEER_PROTOCOL_VERSION,
  PEER_MIN_PROTOCOL_VERSION,
} from "./version.js";
/** Client-facing aliases (product display / protocol floor). */
export { GATEWAY_VERSION as EXPECTED_GATEWAY_VERSION } from "./version.js";
export { GATEWAY_PROTOCOL_VERSION as EXPECTED_PROTOCOL_VERSION } from "./version.js";

export {
  DEFAULT_GATEWAY_CAPABILITIES,
  OPTIONAL_GATEWAY_CAPABILITIES,
  isGatewayCapabilities,
  type GatewayCapabilities,
} from "./capabilities.js";

export {
  GATEWAY_PLANE_PREFIX,
  MAX_MULTIPLEX_REPLICA_SCOPES,
  VAULT_PLANE_PREFIX,
  APPS_PLANE_PREFIX,
  WEB_PLANE_PREFIX,
  BRIEF_PLANE_PREFIX,
  ROUTES,
  ROUTE_PATHS,
  commonsIntentCancelPath,
  commonsIntentDecidePath,
  vaultConnectionAuthorizePath,
  vaultConnectionPath,
  vaultGrantPath,
  vaultGrantRevokePath,
  appActionPath,
  appQueryPath,
  appDescribePath,
  appTurnPath,
  assistantTurnPath,
  assistantResolvePath,
  type RouteName,
} from "./routes.js";

export {
  judgeGatewayInfo,
  handshakeGateway,
  buildGatewayInfoPayload,
  readProtocolFromInfo,
  protocolsCompatible,
  type GatewayInfo,
  type HandshakeResult,
} from "./handshake.js";

export {
  TRACE_FORMAT_VERSION,
  TRACE_HOPS,
  TRACE_SEATS,
  TRACE_JOURNEYS,
  TRACE_SAMPLING_OFF,
  WORK_COUNTER_KEYS,
  addCounters,
  diffCounters,
  mintTraceId,
  shouldSample,
  traceIdOfIntent,
  validateTraceRecord,
  waterfall,
  webCryptoTraceIdFactory,
  zeroCounters,
  type JourneyId,
  type TraceAttrValue,
  type TraceAttrs,
  type TraceHop,
  type TraceId,
  type TraceIdFactory,
  type TraceRecord,
  type TraceSamplingPolicy,
  type TraceSeat,
  type TraceSpan,
  type WaterfallRow,
  type WorkCounterKey,
  type WorkCounters,
} from "./trace.js";

export {
  assertShapeNamespaceFree,
  isShareShapeId,
  judgeSubscriberCredential,
  shareShapeGrantId,
  shareShapeId,
  subscriberQuery,
  PEER_REPLICA_BLOB_PATH,
  PEER_REPLICA_CHANGES_PATH,
  PEER_REPLICA_INTENTS_PATH,
  PEER_REPLICA_PATHS,
  PEER_REPLICA_TAIL_PATH,
  REPLICA_POST_ADMISSION_CONTRACT,
  SHARE_SHAPE_SIGIL,
  type ReplicaSubscriberCredential,
  type SubscriberCredentialVerdict,
} from "./replica-subscription.js";

export {
  SEAT_LOG_MAX_PAGE,
  SEAT_SNAPSHOT_EPOCH_HEADER,
  SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER,
  SEAT_SNAPSHOT_SEQ_HEADER,
  type SeatLockerKeyWire,
  type SeatLogOp,
  type SeatLogPageWire,
  type SeatLogRowWire,
  type SeatRebootstrapReason,
  type SeatRebootstrapRequiredWire,
  type SeatSnapshotHead,
} from "./seat-log.js";

export {
  applyRowSql,
  decodeWireRow,
  decodeWireValue,
  deleteRowSql,
  encodeWireRow,
  encodeWireValue,
  type WireRowImage,
  type WireValue,
} from "./row-json.js";

export {
  judgePeerHandshake,
  peerHello,
  peerProtocolsCompatible,
  type PeerHandshakeVerdict,
  type PeerHello,
} from "./peer.js";
