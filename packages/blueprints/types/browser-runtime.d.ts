// Ambient types for build-tool resource imports and virtual sibling aliases.
// The canonical application kit is real TypeScript (`kit/kit.ts`) and owns its
// own contract; Photos' legacy relative video-frame specifier is redirected to
// the client's TypeScript module by inline-vite-aliases.ts.

declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*video-frame.js' {
  export const VIDEO_POSTER_EDGE: number;
  export const VIDEO_THUMB_EDGE: number;

  export interface CapturedVideoFrames {
    width: number;
    height: number;
    duration: number | null;
    poster: Blob | null;
    thumb: Blob | null;
  }

  export function captureVideoFrames(source: Blob): Promise<CapturedVideoFrames | null>;
}
