// Desktop file-ASR adapter for issue #414 D13. The model/service runs on the
// user's own machine (for example whisper.cpp's OpenAI-compatible server), so
// media never leaves the device. Configuration and bearer credentials remain
// in the Electron main process; the renderer receives only availability/text.

const MAX_TRANSCRIPT_CHARS = 1_000_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface DeviceAsrConfig {
  endpoint: URL;
  token?: string;
  model?: string;
}

export interface DeviceTranscriptionInput {
  bytes: ArrayBuffer | Uint8Array;
  mediaType: string;
  filename?: string;
}

function loopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

/** Read an explicitly configured, loopback-only ASR endpoint. */
export function readDeviceAsrConfig(env: NodeJS.ProcessEnv = process.env): DeviceAsrConfig | null {
  const raw = env['CENTRAID_DEVICE_ASR_URL']?.trim();
  if (!raw) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !loopback(endpoint.hostname)) return null;
  if (endpoint.username || endpoint.password) return null;
  const token = env['CENTRAID_DEVICE_ASR_TOKEN']?.trim();
  const model = env['CENTRAID_DEVICE_ASR_MODEL']?.trim();
  return {
    endpoint,
    ...(token ? { token } : {}),
    ...(model ? { model } : {}),
  };
}

function headers(config: DeviceAsrConfig): Headers {
  const value = new Headers();
  if (config.token) value.set('authorization', `Bearer ${config.token}`);
  return value;
}

/** Advertise transcript only when the configured local adapter answers. */
export async function deviceTranscriptionAvailable(
  config = readDeviceAsrConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config) return false;
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'OPTIONS',
      headers: headers(config),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function extension(mediaType: string): string {
  if (mediaType.includes('wav')) return 'wav';
  if (mediaType.includes('mpeg')) return 'mp3';
  if (mediaType.includes('ogg')) return 'ogg';
  if (mediaType.includes('webm')) return 'webm';
  if (mediaType.includes('mp4')) return 'mp4';
  return mediaType.startsWith('video/') ? 'video' : 'audio';
}

/** Submit one existing media file to the device-local ASR service. */
export async function transcribeDeviceMedia(
  input: DeviceTranscriptionInput,
  config = readDeviceAsrConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config) throw new Error('device transcription is not configured');
  if (!input.mediaType.startsWith('audio/') && !input.mediaType.startsWith('video/')) {
    throw new Error('device transcription accepts audio or video media only');
  }
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const form = new FormData();
  const copy = Uint8Array.from(bytes).buffer;
  form.append(
    'file',
    new Blob([copy], { type: input.mediaType }),
    input.filename ?? `centraid-media.${extension(input.mediaType)}`,
  );
  if (config.model) form.append('model', config.model);
  form.append('response_format', 'json');
  const response = await fetchImpl(config.endpoint, {
    method: 'POST',
    headers: headers(config),
    body: form,
  });
  if (!response.ok) throw new Error(`device transcription failed: HTTP ${response.status}`);
  const result = (await response.json()) as { text?: unknown };
  if (typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('device transcription returned no text');
  }
  return result.text.trim().slice(0, MAX_TRANSCRIPT_CHARS);
}
