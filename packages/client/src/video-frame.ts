import { BLOB_MEDIUM_EDGE, BLOB_TINY_EDGE } from '@centraid/blob-format';

export const VIDEO_POSTER_EDGE = BLOB_MEDIUM_EDGE;
export const VIDEO_THUMB_EDGE = BLOB_TINY_EDGE;
export const VIDEO_CAPTURE_TIMEOUT_MS = 12_000;

export interface CapturedVideoFrames {
  width: number;
  height: number;
  duration: number | null;
  poster: Blob | null;
  thumb: Blob | null;
}

function waitForMedia(element: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener(event, ready);
      element.removeEventListener('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const ready = (): void => finish();
    const failed = (): void => finish(new Error('media decode failed'));
    const timer = setTimeout(
      () => finish(new Error(`media ${event} timed out`)),
      VIDEO_CAPTURE_TIMEOUT_MS,
    );
    element.addEventListener(event, ready, { once: true });
    element.addEventListener('error', failed, { once: true });
  });
}

function canvasBlob(video: HTMLVideoElement, maxEdge: number): Promise<Blob | null> {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84));
}

/** One canonical hardware-decoded poster/thumb capture pipeline for every browser surface. */
export async function captureVideoFrames(source: Blob): Promise<CapturedVideoFrames | null> {
  if (!URL.createObjectURL) return null;
  const video = document.createElement('video');
  const url = URL.createObjectURL(source);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    video.src = url;
    video.load();
    await waitForMedia(video, 'loadedmetadata');
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) return null;
    const duration = Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : null;
    const seekTo = duration && duration > 0 ? Math.min(1, duration / 2) : 0;
    if (seekTo > 0.01) {
      video.currentTime = seekTo;
      await waitForMedia(video, 'seeked');
    } else if (video.readyState < 2) {
      await waitForMedia(video, 'loadeddata');
    }
    const [poster, thumb] = await Promise.all([
      canvasBlob(video, VIDEO_POSTER_EDGE),
      canvasBlob(video, VIDEO_THUMB_EDGE),
    ]);
    return { width: video.videoWidth, height: video.videoHeight, duration, poster, thumb };
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
