/*
 * @centraid/builder-harness
 *
 * Drives the centraid app BUILDER: a session that authors centraid apps
 * in the @centraid/openclaw-plugin format, backed by the unified local
 * agent runtime in @centraid/agent-runtime (codex app-server or Claude
 * SDK). Plus scaffold + publish + gateway HTTP helpers shared across
 * desktop / mobile.
 *
 * The in-app *data chat* (talking to a deployed app's SQLite over the
 * chat panel) runs through the same gateway `_chat` turn as the builder
 * now (issue #141); the renderer streams its SSE directly.
 *
 * Public surface:
 *   - scaffoldProject(projectsDir, id, opts?) → ProjectInfo
 *   - listProjects(projectsDir) → ProjectInfo[]
 *   - publishProject(projectDir, id, config, opts?) → PublishResult
 *   - defaultHarnessConfig() / resolveHarnessConfig(overrides) → HarnessConfig
 *
 * The in-process builder agent session (`createCentraidAgentSession`) retired
 * with the unified chat (issue #141, Phase 3) — the gateway now drives the
 * builder turn server-side via `runAgentTurn` + the prompt/grounding exports
 * below. The system prompt + UI/tools grounding stay; the session facade is
 * gone.
 */

export {
  scaffoldProject,
  listProjects,
  deleteProject,
  updateProjectMeta,
  validateAppId,
} from './scaffold.js';

// Filesystem-free scaffolders for the git-store/HTTP path (issue #141):
// these emit a `{path, content}[]` file map the desktop PUTs into a
// session and publishes — no local workspace dir required.
export {
  scaffoldProjectFiles,
  updateProjectMetaFiles,
  appPackageJson,
  type ScaffoldFile,
  type ScaffoldProjectOpts,
} from './scaffold-files.js';

export {
  scaffoldAutomationProject,
  scaffoldAutomationProjectFiles,
  setAutomationEnabledInFiles,
  deleteAutomationFromFiles,
  validateAutomationId,
  validateAutomationAppId,
  type AutomationScaffoldOptions,
} from './scaffold-automation.js';

export {
  cloneTemplate,
  cloneTemplateFiles,
  suggestAppId,
  suggestCloneIdentity,
  suggestCloneIdentityFrom,
  type CloneTemplateOptions,
  type CloneTemplateFilesOptions,
} from './clone.js';

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

export {
  readProjectFiles,
  writeProjectFile,
  type ProjectFile,
  type ProjectFileLanguage,
} from './project-files.js';

export { defaultHarnessConfig, resolveHarnessConfig } from './config.js';

export {
  CENTRAID_APPEND_PROMPT,
  AUTOMATION_APPEND_PROMPT,
  centraidAppendPrompt,
} from './system-prompt.js';

export { buildUiGroundingBlocks } from './ui-grounding.js';

export { buildToolsGroundingBlock } from './tools-grounding.js';

export {
  type HarnessConfig,
  type ProjectInfo,
  type PublishOptions,
  type PublishResult,
  HarnessError,
} from './types.js';
