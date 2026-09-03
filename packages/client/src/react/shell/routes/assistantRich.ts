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

const RICH_ANSWER_CACHE_ENTRIES = 200;
const richAnswerCache = boundedMemo(
  (text: string) => sharedRichAnswerHtml(text, CLASSES),
  RICH_ANSWER_CACHE_ENTRIES
);

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
