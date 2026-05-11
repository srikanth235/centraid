/*
 * @centraid/agent-harness
 *
 * Customizes pi-coding-agent for authoring centraid apps and provides
 * scaffold + publish helpers consumed by the desktop (and later mobile)
 * surfaces.
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

export { scaffoldProject, listProjects, deleteProject, validateAppId } from './scaffold.js';

export { publishProject } from './publish.js';

export {
  listApps,
  listVersions,
  activateVersion,
  deregisterApp,
  appLiveUrl,
  fetchAppSchema,
  type VersionRecord,
  type AppRegistryRow,
} from './gateway-client.js';

export type {
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
} from '@centraid/openclaw-plugin';

export { readProjectFiles, type ProjectFile, type ProjectFileLanguage } from './project-files.js';

export { defaultHarnessConfig, resolveHarnessConfig } from './config.js';

export { CENTRAID_APPEND_PROMPT, centraidAppendPrompt } from './system-prompt.js';

export {
  type HarnessConfig,
  type ProjectInfo,
  type PublishOptions,
  type PublishResult,
  HarnessError,
} from './types.js';
