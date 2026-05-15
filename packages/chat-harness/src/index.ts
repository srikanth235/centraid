/*
 * @centraid/chat-harness
 *
 * Pi-coding-agent customization for the centraid in-app DATA CHAT — the
 * panel that talks to a single deployed app's SQLite. Pairs the
 * `createCentraidDataChatSession` factory with three closure-scoped tools
 * (centraid_sql_describe, centraid_sql_read, centraid_sql_write) that hit
 * the runtime's `/centraid/_apps/{appId}/...` HTTP surface — so this works
 * against both the embedded local runtime and remote OpenClaw without any
 * branching at the call site.
 *
 * For the app-authoring agent (the builder), see @centraid/builder-harness.
 */

export {
  createCentraidDataChatSession,
  type CreateDataChatSessionOptions,
  type DataChatSessionMode,
} from './data-chat-session.js';

export {
  createCentraidSqlTools,
  createCentraidSqlDescribeTool,
  createCentraidSqlReadTool,
  createCentraidSqlWriteTool,
  isSelectOnly,
  isWriteDml,
  type CentraidSqlToolsOptions,
} from './sql-tools.js';

export { buildDataChatPrompt, type BuildDataChatPromptOptions } from './system-prompt.js';
