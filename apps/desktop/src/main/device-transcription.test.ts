import { expect, test, vi } from 'vitest';
import {
  deviceTranscriptionAvailable,
  readDeviceAsrConfig,
  transcribeDeviceMedia,
} from './device-transcription.js';

test('device ASR configuration is explicit and loopback-only', () => {
  expect(readDeviceAsrConfig({})).toBeNull();
  expect(
    readDeviceAsrConfig({ CENTRAID_DEVICE_ASR_URL: 'https://asr.example.test/v1' }),
  ).toBeNull();
  expect(
    readDeviceAsrConfig({
      CENTRAID_DEVICE_ASR_URL: 'http://127.0.0.1:8080/v1/audio/transcriptions',
      CENTRAID_DEVICE_ASR_TOKEN: 'local-secret',
      CENTRAID_DEVICE_ASR_MODEL: 'local-whisper',
    }),
  ).toMatchObject({
    endpoint: new URL('http://127.0.0.1:8080/v1/audio/transcriptions'),
    token: 'local-secret',
    model: 'local-whisper',
  });
});

test('capability is advertised only while the configured adapter answers', async () => {
  const config = readDeviceAsrConfig({
    CENTRAID_DEVICE_ASR_URL: 'http://localhost:8080/v1/audio/transcriptions',
  });
  const availableFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  await expect(deviceTranscriptionAvailable(config, availableFetch)).resolves.toBe(true);
  expect(availableFetch).toHaveBeenCalledWith(
    config?.endpoint,
    expect.objectContaining({ method: 'OPTIONS' }),
  );
  await expect(
    deviceTranscriptionAvailable(
      config,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('down')),
    ),
  ).resolves.toBe(false);
});

test('local adapter receives the existing media file and returns bounded transcript text', async () => {
  const config = readDeviceAsrConfig({
    CENTRAID_DEVICE_ASR_URL: 'http://[::1]:8080/v1/audio/transcriptions',
    CENTRAID_DEVICE_ASR_TOKEN: 'secret',
    CENTRAID_DEVICE_ASR_MODEL: 'device-model',
  });
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init).toBeDefined();
    const request = init!;
    expect(request.headers).toBeInstanceOf(Headers);
    expect((request.headers as Headers).get('authorization')).toBe('Bearer secret');
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get('model')).toBe('device-model');
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: 'voice.wav', type: 'audio/wav', size: 10 });
    return Response.json({ text: '  searchable starlight phrase  ' });
  });

  await expect(
    transcribeDeviceMedia(
      {
        bytes: new TextEncoder().encode('RIFF-voice'),
        mediaType: 'audio/wav',
        filename: 'voice.wav',
      },
      config,
      fetchImpl,
    ),
  ).resolves.toBe('searchable starlight phrase');
});
