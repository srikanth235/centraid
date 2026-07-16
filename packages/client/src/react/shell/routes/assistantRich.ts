// Assistant rich-answer renderer — thin React-shell adapter over the shared,
// framework-free kit renderer (packages/blueprints/kit/assistant-rich.js, the
// single canonical copy since issue #420). The shell keeps its scoped CSS
// modules: it passes their class names to the shared renderer, so the same
// string→HTML renderer drives both the kit's Ask panel and this shell, and a
// rendering change lands in one place. `AssistantScreen` still injects the
// returned HTML via `dangerouslySetInnerHTML` and re-hydrates refs, exactly as
// before — the two exported signatures are unchanged.

import {
  richAnswerHtml as sharedRichAnswerHtml,
  hydrateRefs as sharedHydrateRefs,
  wireCodeCopy as sharedWireCodeCopy,
  type AssistantRichClassOverrides,
} from '@centraid/blueprints/kit/assistant-rich.js';
import { resolveAssistantRefs } from '../../../gateway-client.js';
import styles from './assistantRich.module.css';
import asstPreCss from '../../styles/asstPre.module.css';

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

/** Full answer → prose + typed blocks + code fences, as an HTML string. */
export function richAnswerHtml(text: string): string {
  return sharedRichAnswerHtml(text, CLASSES);
}

/** Resolve every ref chip under `host` to a live card title, batched. */
export function hydrateRefs(host: HTMLElement): void {
  sharedHydrateRefs(host, { resolveRefs: resolveAssistantRefs, refClass: styles.asstRef });
}

/** Wire code-block "Copy" buttons under `host` to the clipboard (idempotent). */
export function wireCodeCopy(host: HTMLElement): void {
  sharedWireCodeCopy(host, { copyClass: styles.asstCopyBtn });
}
