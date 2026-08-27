// RECURRING — templates, what they are due to do, and the one write in this
// app that needs the gateway (Tally spec §3, §4, STATES.md).
//
// A SCHEDULE IS A SENTENCE. `queries/dashboard.ts` asks the shared time core
// for it; where the core cannot phrase a rule the row carries the §6 line and
// NO PREVIEW AT ALL. Printing `FREQ=WEEKLY;BYDAY=TU,TH` in its place would be
// a leak of the storage format dressed as information.
//
// A ROW'S VERBS ARE WITHHELD WHERE THE WRITE WOULD BE REFUSED.
// `save-recurring-expense` upserts the WHOLE template — its splits, its rule,
// its anchor, its zone — so pausing one means sending all of it back. A row
// whose stored splits cannot be read carries no Pause, and says why, rather
// than a button that would fail at the far end of a press.
//
// DUE NEXT NAMES THE ONE EXCEPTION. Materialising an occurrence is excluded
// from the pending projection by construction — the occurrence's id is minted
// by the canonical recurrence engine — so it is the single act in Tally with
// no optimistic copy, and the section says so where the member is standing
// rather than only in the offline notice.
import type { ReactNode } from "react";

import {
  DUE_OCCURRENCE,
  NO_PREVIEW,
  OFFLINE_MATERIALISE,
  RECURRING_EMPTY,
  RECURRING_META,
  RECURRING_SECTIONS,
  RECURRING_VERBS,
  TEMPLATE_UNSAVEABLE,
  UNSUMMARISABLE,
} from "../compose-copy.ts";
import { metaSentence, money } from "../format.ts";
import {
  dueNext,
  scheduleSentence,
  statusChip,
  templateSaveBase,
} from "../schedule-model.ts";
import type { DueOccurrence } from "../schedule-model.ts";
import type { GroupSummary, RecurringTemplate } from "../types.ts";
import { Note, Rows, Section } from "./Blocks.tsx";
import { LedgerRow } from "./LedgerRow.tsx";
import type { RowAct } from "./LedgerRow.tsx";

export interface RecurringScreenProps {
  templates: readonly RecurringTemplate[];
  groups: readonly GroupSummary[];
  now: string;
  narrow: boolean;
  /** The gateway is not answering. Everything else in Tally still records;
   *  this section is the one place that changes. */
  offline: boolean;
  onPause: (template: RecurringTemplate) => void;
  onSkip: (template: RecurringTemplate) => void;
  onMaterialise: (due: DueOccurrence) => void;
}

function templateActs(
  props: RecurringScreenProps,
  template: RecurringTemplate
): RowAct[] {
  if (templateSaveBase(template) === null) return [];
  const paused = template.status === "paused";
  return [
    {
      label: paused ? RECURRING_VERBS.resume : RECURRING_VERBS.pause,
      run: () => props.onPause(template),
    },
    ...(paused || !template.next_start
      ? []
      : [
          {
            label: RECURRING_VERBS.skip,
            run: () => props.onSkip(template),
          },
        ]),
  ];
}

export function RecurringScreen(props: RecurringScreenProps): ReactNode {
  const names = new Map(
    props.groups.map((group) => [group.group_id, group.name])
  );
  const due = dueNext(props.templates, props.now);
  const anyWithheld = props.templates.some(
    (template) => templateSaveBase(template) === null
  );

  return (
    <div>
      <Section
        label={RECURRING_SECTIONS.templates}
        meta={RECURRING_META.templates}
        count={props.templates.length}
        empty={RECURRING_EMPTY.templates}
        narrow={props.narrow}
      >
        <Rows>
          {props.templates.map((template) => {
            const sentence = scheduleSentence(template);
            const chip = statusChip(template);
            return (
              <LedgerRow
                key={template.template_id}
                title={template.description}
                meta={metaSentence([
                  sentence ?? UNSUMMARISABLE,
                  template.time_zone,
                  names.get(template.group_id),
                ])}
                {...(chip
                  ? { status: { label: chip, tone: "seam" as const } }
                  : {})}
                figure={{
                  text: money(
                    template.original_amount_minor,
                    template.original_currency
                  ),
                  tone: "owed",
                  sub: sentence ? (template.next_start ?? "") : NO_PREVIEW,
                }}
                acts={templateActs(props, template)}
                narrow={props.narrow}
              />
            );
          })}
        </Rows>
        {anyWithheld ? <Note>{TEMPLATE_UNSAVEABLE}</Note> : null}
      </Section>

      <Section
        label={RECURRING_SECTIONS.due}
        meta={RECURRING_META.due}
        count={due.length}
        empty={RECURRING_EMPTY.due}
        narrow={props.narrow}
      >
        <Rows>
          {due.map((occurrence) => (
            <LedgerRow
              key={`${occurrence.templateId}-${occurrence.originalStart}`}
              title={`${occurrence.description} · ${money(occurrence.amountMinor, occurrence.currency)}`}
              meta={occurrence.when ?? ""}
              acts={
                props.offline
                  ? []
                  : [
                      {
                        label: RECURRING_VERBS.materialise,
                        run: () => props.onMaterialise(occurrence),
                      },
                    ]
              }
              narrow={props.narrow}
            />
          ))}
        </Rows>
        {/* The §6 line, stated ONCE for the section rather than repeated on
            every row: it is a fact about materialising, not about this
            occurrence. Offline it becomes the reason the verb is gone. */}
        <Note>{props.offline ? OFFLINE_MATERIALISE : DUE_OCCURRENCE}</Note>
      </Section>
    </div>
  );
}
