// Types for the shared conversation-client wire contract (issue #420).

export function isSafeClientId(value: unknown): value is string;
export function safeClientId(value: unknown): string | null;
export function conversationsPath(appId: string): string;
export function conversationPath(appId: string, sessionId: string): string;
export function conversationSearchPath(
  appId: string,
  query: string,
  limit?: number
): string;
export function conversationStatusPath(
  appId: string,
  sessionId: string
): string;
export function blobsPath(appId: string): string;
export function appTurnPath(appId: string): string;
export function appModelPath(appId: string): string;
export function assistantTurnPath(): string;
export function resolvePath(): string;
export function vaultStatusPath(): string;
export function vaultAppsPath(): string;

/** The inline model picker's state, shared by both surfaces. */
export interface ModelState {
  loaded: boolean;
  current: string | null;
  defaultModel: string;
  catalog: Array<{ id: string; label?: string }>;
}

export function normalizeModelState(body: unknown): ModelState;
export function modelLabel(state: ModelState): string;

export function readJsonResponse(
  res: Response
): Promise<{ ok: boolean; status: number; body: unknown }>;
