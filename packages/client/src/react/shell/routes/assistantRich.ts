// Assistant rich-answer renderer — thin React-shell adapter over the
// framework-free renderer in `packages/client/src/assistant-rich.ts`. The shell
// keeps its scoped CSS modules and passes their class names down, so the memo
// cache below is the only shell-specific behaviour. `AssistantScreen` injects
// the returned HTML via `dangerouslySetInnerHTML` and re-hydrates refs.

import {
  richAnswerHtml as sharedRichAnswerHtml,
  hydrateRefs as sharedHydrateRefs,
  wireCodeCopy as sharedWireCodeCopy,
} from "../../../assistant-rich.js";
import type { AssistantRichClassOverrides } from "../../../assistant-rich.js";
import { resolveAssistantRefs } from "../../../gateway-client.js";
import { boundedMemo } from "../boundedMemo.js";

import asstPreCss from "../../styles/asstPre.module.css";
import styles from "./assistantRich.module.css";

// The shell's scoped/hashed class names, mapped onto the shared renderer's
// slots. `asstPre` lives in a shared stylesheet reused by the tool timeline, so
// it comes from its own module. In tests Vitest is configured `non-scoped`, so
// these resolve to the literal names the assertions expect.
const CLASSES: AssistantRichClassOverrides = {
  asstRich: styles.asstRich,
  asstP: styles.asstP,
  asstH: styles.asstH,
  asstUl: styles.asstUl,
  asstOl: styles.asstOl,
  asstQuote: styles.asstQuote,
  asstHr: styles.asstHr,
  asstA: styles.asstA,
  asstImg: styles.asstImg,
  asstDel: styles.asstDel,
  asstRef: styles.asstRef,
  asstBlock: styles.asstBlock,
  asstTableWrap: styles.asstTableWrap,
  asstTable: styles.asstTable,
  asstCaption: styles.asstCaption,
  asstStat: styles.asstStat,
  asstStatValue: styles.asstStatValue,
  asstStatLabel: styles.asstStatLabel,
  asstStatSub: styles.asstStatSub,
  asstChart: styles.asstChart,
  asstChartPlot: styles.asstChartPlot,
  asstChartSvg: styles.asstChartSvg,
  asstChartX: styles.asstChartX,
  asstChartLegend: styles.asstChartLegend,
  asstPre: asstPreCss.asstPre,
  asstCodeWrap: styles.asstCodeWrap,
  asstCopyBtn: styles.asstCopyBtn,
};

// Answers are re-projected on every streamed token and on every re-render of
// the transcript, but an answer's text→HTML mapping is pure and an ALREADY
// FINISHED answer's text never changes. Without a cache a 900-token turn
// re-parsed every earlier answer in the thread 900 times (issue #659). The cap
// is generous enough to cover a long visible transcript and bounded so a long
// session cannot grow it without limit.
const RICH_ANSWER_CACHE_ENTRIES = 200;
const richAnswerCache = boundedMemo(
  (text: string) => sharedRichAnswerHtml(text, CLASSES),
  RICH_ANSWER_CACHE_ENTRIES
);

/**
 * Full answer → prose + typed blocks + code fences, as an HTML string.
 *
 * Memoized: identical text yields the identical string reference, which is what
 * lets the transcript projection compare answers in O(1) instead of by content.
 */
export function richAnswerHtml(text: string): string {
  return richAnswerCache(text);
}

/** Resolve every ref chip under `host` to a live card title, batched. */
export function hydrateRefs(host: HTMLElement): void {
  sharedHydrateRefs(host, {
    resolveRefs: resolveAssistantRefs,
    refClass: styles.asstRef,
  });
}

/** Wire code-block "Copy" buttons under `host` to the clipboard (idempotent). */
export function wireCodeCopy(host: HTMLElement): void {
  sharedWireCodeCopy(host, { copyClass: styles.asstCopyBtn });
}
