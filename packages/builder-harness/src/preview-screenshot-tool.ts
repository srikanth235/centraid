/**
 * `previewScreenshot` custom tool — closes the agent's visual-feedback loop.
 *
 * The agent calls this tool after a CSS/layout change to receive a PNG of the
 * live preview iframe as an image attachment in its next turn. Without this,
 * the agent writes styles blind; with it, the agent can spot misalignments,
 * contrast issues, and overflow in the same conversation it just authored.
 *
 * Wiring is two-step:
 *
 *   1. Surface that can capture the iframe (the desktop renderer) implements
 *      a `capture()` that returns `{ mimeType, base64 }` of the rendered
 *      preview region.
 *   2. The IPC handler that creates the agent session passes
 *      `createPreviewScreenshotTool({ capture })` into
 *      `createCentraidAgentSession({ customTools: [tool] })`. The harness
 *      detects the tool by name and turns on the corresponding system-prompt
 *      guidance.
 *
 * Headless/CLI callers should simply omit the tool.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface PreviewScreenshotImage {
  /** Image MIME type — typically "image/png". */
  mimeType: string;
  /** Raw base64 (no `data:` prefix). */
  base64: string;
}

export interface CreatePreviewScreenshotToolOptions {
  /**
   * Capture the current preview iframe and return it as a base64 PNG.
   * Must throw on failure (no preview available, capture errored) — the
   * agent will see the thrown error as a tool failure.
   */
  capture: (signal?: AbortSignal) => Promise<PreviewScreenshotImage>;
}

const PARAMS = Type.Object({});

/**
 * Build the `previewScreenshot` custom tool. The agent calls it with no
 * arguments; the returned tool result includes the captured PNG as an
 * `ImageContent` so the model can see what it just rendered.
 *
 * The detection in `agent-session.ts` keys on the tool's `name` — keep
 * that string in sync with `'previewScreenshot'` here.
 */
export function createPreviewScreenshotTool(
  opts: CreatePreviewScreenshotToolOptions,
): ToolDefinition {
  return defineTool({
    name: 'previewScreenshot',
    label: 'Preview screenshot',
    description:
      'Capture the current rendered preview iframe and return it as a PNG. ' +
      'Use this after a meaningful CSS or layout change to verify the visual ' +
      'result, the same way a developer would glance at the browser. No input ' +
      'parameters. One screenshot per coherent visual change is the right ' +
      'cadence — do not spam.',
    promptSnippet:
      'previewScreenshot — capture the live preview iframe as a PNG for visual review.',
    parameters: PARAMS,
    executionMode: 'sequential',
    async execute(_id, _params, signal) {
      const img = await opts.capture(signal);
      return {
        content: [
          { type: 'text', text: 'Preview screenshot captured.' },
          { type: 'image', data: img.base64, mimeType: img.mimeType },
        ],
        details: undefined,
      };
    },
  });
}
