/*
 * Gateway ops (#351): electron-free pure core — side effects injected so this
 * unit-tests without `electron`; gateway-ops.ts wires the real ones for IPC.
 */

/** `GET /centraid/_gateway/diagnostics`, fetched and pretty-printed. */
export type DiagnosticsFetchResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

const DIAGNOSTICS_PATH = "/centraid/_gateway/diagnostics";
const RECOVERY_KIT_PATH = "/centraid/_gateway/backup/kit";

/** Parsed as JSON and re-stringified so a malformed response fails HERE,
 *  never saved as unparseable bytes. */
export async function fetchDiagnosticsText(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<DiagnosticsFetchResult> {
  return fetchJsonText(
    baseUrl,
    token,
    DIAGNOSTICS_PATH,
    "diagnostics",
    fetchImpl
  );
}

async function fetchJsonText(
  baseUrl: string,
  token: string | undefined,
  requestPath: string,
  label: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {}
): Promise<DiagnosticsFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(new URL(requestPath, `${baseUrl}/`).toString(), {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `${label} response was not JSON` };
  }
  return { ok: true, text: JSON.stringify(body, null, 2) };
}

/** Local calendar day. */
export function diagnosticsFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `centraid-diagnostics-${y}-${m}-${d}.json`;
}

export interface ExportDiagnosticsDeps {
  /** Active gateway base URL + bearer token. */
  loadSettings: () => Promise<{ gatewayUrl: string; gatewayToken?: string }>;
  fetchImpl?: typeof fetch;
  /** Native save dialog — absent `filePath` implies canceled. */
  showSaveDialog: (
    defaultPath: string
  ) => Promise<{ canceled: boolean; filePath?: string }>;
  writeFile: (path: string, data: string) => Promise<void>;
  now?: () => Date;
}

export type ExportDiagnosticsResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: string };

/** Fetch + save diagnostics via native dialog, mirroring
 *  `renderer/centraid-api.d.ts`. */
export async function exportGatewayDiagnostics(
  deps: ExportDiagnosticsDeps
): Promise<ExportDiagnosticsResult> {
  const settings = await deps.loadSettings();
  if (!settings.gatewayUrl) {
    return {
      ok: false,
      error: "No active gateway to export diagnostics from.",
    };
  }
  const fetched = await fetchDiagnosticsText(
    settings.gatewayUrl,
    settings.gatewayToken,
    deps.fetchImpl ?? fetch
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const defaultPath = diagnosticsFileName(deps.now ? deps.now() : new Date());
  const { canceled, filePath } = await deps.showSaveDialog(defaultPath);
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    await deps.writeFile(filePath, fetched.text);
    return { ok: true, path: filePath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Fetch + save the recovery kit through a native dialog. */
export async function exportGatewayRecoveryKit(
  deps: ExportDiagnosticsDeps,
  input: { password: string }
): Promise<ExportDiagnosticsResult> {
  const settings = await deps.loadSettings();
  if (!settings.gatewayUrl)
    return { ok: false, error: "No active gateway to export from." };
  if (!input.password)
    return { ok: false, error: "A recovery-kit password is required." };
  const fetched = await fetchJsonText(
    settings.gatewayUrl,
    settings.gatewayToken,
    RECOVERY_KIT_PATH,
    "recovery kit",
    deps.fetchImpl ?? fetch,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: input.password }),
    }
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const { canceled, filePath } = await deps.showSaveDialog(
    "centraid-recovery-kit.json"
  );
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await deps.writeFile(filePath, fetched.text);
    return { ok: true, path: filePath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
