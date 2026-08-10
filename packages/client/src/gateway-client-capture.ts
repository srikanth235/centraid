import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

export interface AgentCaptureCandidate {
  kind: "task" | "expense" | "note" | "event";
  title?: string;
  amountMinor?: number;
  startsAt?: string;
  durationMinutes?: number;
}

export interface CaptureOcrExtraction {
  text: string;
  /** Absent when the selected recognizer cannot ground an honest score. */
  confidence?: number;
  engine: "enrichment-service";
}

export async function recognizeCaptureImage(
  file: File
): Promise<CaptureOcrExtraction | undefined> {
  const { baseUrl, token } = await auth();
  const response = await doFetch(baseUrl, "/centraid/_gateway/capture/ocr", {
    method: "POST",
    headers: authHeaders(token, file.type || "application/octet-stream"),
    body: file,
  });
  if (response.status === 503) return undefined;
  const body = await readJson<{ extraction: CaptureOcrExtraction }>(
    response,
    "recognize capture image"
  );
  return body.extraction;
}

/** Authoritatively stage reviewed capture bytes into the focused vault CAS. */
export async function stageCaptureFile(file: File): Promise<string> {
  const { baseUrl, token } = await auth();
  const query = new URLSearchParams({
    ...(file.name ? { filename: file.name } : {}),
    ...(file.type ? { media_type: file.type } : {}),
  });
  const response = await doFetch(baseUrl, `/centraid/_vault/blobs?${query}`, {
    method: "POST",
    headers: authHeaders(token, file.type || "application/octet-stream"),
    body: file,
  });
  const body = await readJson<{ sha256?: string }>(
    response,
    "stage capture file"
  );
  if (!body.sha256) throw new Error("The gateway did not accept the file.");
  return body.sha256;
}

export async function classifyAmbiguousCapture(
  text: string
): Promise<AgentCaptureCandidate | undefined> {
  const { baseUrl, token } = await auth();
  const response = await doFetch(
    baseUrl,
    "/centraid/_gateway/capture/classify",
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ text }),
    }
  );
  if (response.status === 503) return undefined;
  const body = await readJson<{ preview?: AgentCaptureCandidate }>(
    response,
    "classify capture"
  );
  return body.preview;
}

export async function runBlueprintCaptureQuery<T>(
  appId: string,
  query: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  const { baseUrl, token } = await auth();
  const response = await doFetch(
    baseUrl,
    `/centraid/${enc(appId)}/queries/${enc(query)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ input }),
    }
  );
  return readJson<T>(response, `read ${appId} capture context`);
}

export async function runBlueprintCaptureAction<T>(
  appId: string,
  action: string,
  input: Record<string, unknown>,
  intentId = crypto.randomUUID()
): Promise<T> {
  const { baseUrl, token } = await auth();
  const response = await doFetch(
    baseUrl,
    `/centraid/${enc(appId)}/actions/${enc(action)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ input, intentId }),
    }
  );
  return readJson<T>(response, `save ${appId} capture`);
}
