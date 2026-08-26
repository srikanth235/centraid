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

// Shell class names for the renderer's slots; asstPre shared with the tool timeline. Tests run non-scoped.
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

// Pure mapping; uncached, a 900-token turn re-parses answers 900× (#659).
const RICH_ANSWER_CACHE_ENTRIES = 200;
const richAnswerCache = boundedMemo(
  (text: string) => sharedRichAnswerHtml(text, CLASSES),
  RICH_ANSWER_CACHE_ENTRIES
);

/** Full answer → HTML. Memoized: identical text → identical reference (O(1) transcript compare). */
export function richAnswerHtml(text: string): string {
  return richAnswerCache(text);
}

export function hydrateRefs(host: HTMLElement): void {
  sharedHydrateRefs(host, {
    resolveRefs: resolveAssistantRefs,
    refClass: styles.asstRef,
  });
}

export function wireCodeCopy(host: HTMLElement): void {
  sharedWireCodeCopy(host, { copyClass: styles.asstCopyBtn });
}
