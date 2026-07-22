import type { CompanionModule } from './types.js';

declare const BarcodeDetector: {
  new (options: { formats: string[] }): {
    detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
  };
  getSupportedFormats(): Promise<string[]>;
};

const video = document.querySelector('video')!;
const status = document.querySelector<HTMLElement>('[data-status]')!;
const start = document.querySelector<HTMLButtonElement>('button')!;

start.addEventListener('click', () => void scan());

async function scan(): Promise<void> {
  if (!('BarcodeDetector' in globalThis)) {
    status.textContent = 'QR scanning is unavailable here. Paste the code in the Companion popup.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const timer = window.setInterval(async () => {
      const codes = await detector.detect(video).catch(() => []);
      const ticket = codes[0]?.rawValue;
      if (!ticket) return;
      window.clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
      const grants = [...document.querySelectorAll<HTMLInputElement>('[name="grant"]:checked')].map(
        (input) => input.value as CompanionModule,
      );
      const raw = await chrome.runtime.sendMessage({
        type: 'pair',
        ticket,
        grants,
      });
      const response = raw as { ok?: boolean; error?: string };
      status.textContent = response.ok
        ? 'Paired. You can close this tab.'
        : (response.error ?? 'Pairing failed.');
    }, 250);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
