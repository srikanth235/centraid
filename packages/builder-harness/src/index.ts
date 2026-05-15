/*
 * @centraid/builder-harness
 *
 * Customizes pi-coding-agent for the centraid app BUILDER use case: an agent
 * that authors centraid apps in the @centraid/openclaw-plugin format, plus
 * scaffold + publish + gateway HTTP helpers shared across desktop / mobile.
 *
 * The in-app *data chat* (talking to a deployed app's SQLite over the chat
 * panel) is a separate surface — see @centraid/chat-harness.
 *
 * Public surface:
 *   - createCentraidAgentSession({ projectDir, model? }) → AgentSession
 *   - scaffoldProject(projectsDir, id, opts?) → ProjectInfo
 *   - listProjects(projectsDir) → ProjectInfo[]
 *   - publishProject(projectDir, id, config, opts?) → PublishResult
 *   - defaultHarnessConfig() / resolveHarnessConfig(overrides) → HarnessConfig
 */

export {
  createCentraidAgentSession,
  type CreateCentraidAgentSessionOptions,
} from './agent-session.js';

export {
  scaffoldProject,
  listProjects,
  deleteProject,
  updateProjectMeta,
  validateAppId,
} from './scaffold.js';

export { cloneTemplate, suggestAppId, type CloneTemplateOptions } from './clone.js';

export { publishProject } from './publish.js';

export {
  listApps,
  listVersions,
  activateVersion,
  deregisterApp,
  appLiveUrl,
  fetchAppSchema,
  fetchAppTableRows,
  runAppQuery,
  fetchAppLogs,
  type VersionRecord,
  type AppRegistryRow,
} from './gateway-client.js';

export type {
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
  AppTableRows,
  RunQueryResult,
  LogEntry,
  LogLevel,
} from '@centraid/runtime-core';

export { readProjectFiles, type ProjectFile, type ProjectFileLanguage } from './project-files.js';

export { defaultHarnessConfig, resolveHarnessConfig } from './config.js';

export { CENTRAID_APPEND_PROMPT, centraidAppendPrompt } from './system-prompt.js';

export { buildUiGroundingBlocks } from './ui-grounding.js';

export {
  createPreviewScreenshotTool,
  type CreatePreviewScreenshotToolOptions,
  type PreviewScreenshotImage,
} from './preview-screenshot-tool.js';

export {
  type HarnessConfig,
  type ProjectInfo,
  type PublishOptions,
  type PublishResult,
  HarnessError,
} from './types.js';
