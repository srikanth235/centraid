/*
 * Gateway ops (issue #351) — diagnostics export orchestration.
 *
 * `exportGatewayDiagnostics` is the whole "fetch the bundle, ask where to
 * save it, write the file" flow, but every side effect (settings read,
 * network fetch, save dialog, file write, clock) is passed in as a
 * dependency rather than reached for directly — so it unit-tests as plain
 * async logic with fakes, the same "electron-free pure core" posture as
 * gateway-monitor-core.ts, with no `electron` import at all. `gateway-ops.ts`
 * (not this file) wires the real `dialog.showSaveDialog` / `fs.writeFile` /
 * `loadSettings` in for the IPC handler.
 *
 * Restart doesn't need this treatment — `local-gateway.ts`'s
 * `restartLocalGateway` is already a plain async function, and the IPC
 * handler in ipc.ts is a thin dispatch (remote → refuse, local → call it)
 * with no seams worth injecting.
 */

/** `GET /centraid/_gateway/diagnostics`, fetched and pretty-printed. */
export type DiagnosticsFetchResult = { ok: true; text: string } | { ok: false; error: string };

const DIAGNOSTICS_PATH = '/centraid/_gateway/diagnostics';

/**
 * Fetch the active gateway's diagnostics bundle. `fetchImpl` is injectable
 * for tests (same convention as `version-handshake.ts`'s `handshakeGateway`).
 * The response is parsed as JSON and re-stringified (pretty-printed) rather
 * than written byte-for-byte — a malformed response is caught here as an
 * error instead of silently saving unparseable bytes.
 */
export async function fetchDiagnosticsText(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DiagnosticsFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(new URL(DIAGNOSTICS_PATH, `${baseUrl}/`).toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: 'diagnostics response was not JSON' };
  }
  return { ok: true, text: JSON.stringify(body, null, 2) };
}

/** `centraid-diagnostics-YYYY-MM-DD.json`, in the local calendar day. */
export function diagnosticsFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `centraid-diagnostics-${y}-${m}-${d}.json`;
}

export interface ExportDiagnosticsDeps {
  /** Resolves the active gateway's HTTP base URL + bearer token. */
  loadSettings: () => Promise<{ gatewayUrl: string; gatewayToken?: string }>;
  fetchImpl?: typeof fetch;
  /** Native save dialog — `filePath` undefined/absent implies canceled. */
  showSaveDialog: (defaultPath: string) => Promise<{ canceled: boolean; filePath?: string }>;
  writeFile: (path: string, data: string) => Promise<void>;
  now?: () => Date;
}

export type ExportDiagnosticsResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: string };

/**
 * Fetch `/centraid/_gateway/diagnostics` from the active gateway and save it
 * through a native save dialog. Mirrors the `exportGatewayDiagnostics`
 * contract in `renderer/centraid-api.d.ts` exactly.
 */
export async function exportGatewayDiagnostics(
  deps: ExportDiagnosticsDeps,
): Promise<ExportDiagnosticsResult> {
  const settings = await deps.loadSettings();
  if (!settings.gatewayUrl) {
    return { ok: false, error: 'No active gateway to export diagnostics from.' };
  }
  const fetched = await fetchDiagnosticsText(
    settings.gatewayUrl,
    settings.gatewayToken,
    deps.fetchImpl ?? fetch,
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const defaultPath = diagnosticsFileName(deps.now ? deps.now() : new Date());
  const { canceled, filePath } = await deps.showSaveDialog(defaultPath);
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    await deps.writeFile(filePath, fetched.text);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
