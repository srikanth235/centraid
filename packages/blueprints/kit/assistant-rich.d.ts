// Types for the shared assistant rich-answer renderer (issue #420).
// packages/client's assistantRich.ts re-exports these, passing its CSS-module
// class names + auth-aware ref resolver.

/** The renderer's class-name slots — the kit's kit.css styles the defaults. */
export interface AssistantRichClasses {
  asstRich: string;
  asstP: string;
  asstH: string;
  asstUl: string;
  asstRef: string;
  asstBlock: string;
  asstTableWrap: string;
  asstTable: string;
  asstCaption: string;
  asstStat: string;
  asstStatValue: string;
  asstStatLabel: string;
  asstStatSub: string;
  asstChart: string;
  asstChartPlot: string;
  asstChartSvg: string;
  asstChartX: string;
  asstChartLegend: string;
  asstPre: string;
}

/** A ref chip resolved to a renderable card (loose shape the resolver returns). */
export interface ResolvedRefCard {
  status?: string;
  title?: string | null;
  subtitle?: string | null;
}

export type ResolveRefs = (refs: Array<{ type: string; id: string }>) => Promise<ResolvedRefCard[]>;

/**
 * A caller's class-name overrides. Values may be `undefined` (a CSS-module
 * import is often typed `string | undefined`); the renderer falls back to the
 * literal default for any missing/undefined slot.
 */
export type AssistantRichClassOverrides = Partial<
  Record<keyof AssistantRichClasses, string | undefined>
>;

export const DEFAULT_CLASSES: AssistantRichClasses;

/** Full answer → prose + typed blocks + code fences, as an HTML string. */
export function richAnswerHtml(text: string, classes?: AssistantRichClassOverrides): string;

/** The kit's default ref resolver (POST /centraid/_vault/assistant/resolve). */
export function defaultResolveRefs(
  refs: Array<{ type: string; id: string }>,
): Promise<ResolvedRefCard[]>;

/** Resolve every ref chip under `host` to a live card title, batched. */
export function hydrateRefs(
  host: HTMLElement,
  options?: { resolveRefs?: ResolveRefs; refClass?: string },
): void;
