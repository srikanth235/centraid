// Public surface of the conversation-band archival engine (issue #438).
export { runConversationArchival } from './engine.js';
export { readArchivedConversationSegment } from './segment.js';
export {
  DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS,
  type ConversationArchivalDeps,
  type ConversationArchivalOptions,
  type ConversationArchivalResult,
  type ArchivedRange,
  type ArchivedConversationSegment,
  type BlobSink,
  type CustodyProven,
} from './types.js';
