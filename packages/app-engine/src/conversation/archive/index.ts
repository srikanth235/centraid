// Public surface of the conversation-band archival engine (issue #438).
export { runConversationArchival } from './engine.js';
export { readArchivedConversationSegment } from './segment.js';
export {
  DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS,
  DEFAULT_MAX_CONVERSATIONS_PER_RUN,
  DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN,
  CONVERSATION_SEGMENT_VERSION,
  type ConversationArchivalDeps,
  type ConversationArchivalOptions,
  type ConversationArchivalResult,
  type ArchivedRange,
  type ArchivedConversationSegment,
  type BlobSink,
  type CustodyProven,
} from './types.js';
