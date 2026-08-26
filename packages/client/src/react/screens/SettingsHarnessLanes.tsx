import { useState } from "react";
import type { JSX } from "react";

import type {
  HarnessCardDTO,
  HarnessKind,
  ModelSubsystem,
} from "../screen-contracts.js";
import {
  ConfigSelect,
  ModelSelect,
  Select,
  effortLabel,
  modelLabel,
} from "./SettingsHarnessesSelects.js";
import HarnessLadder from "./SettingsHarnessLadder.js";
import PickRow from "./SettingsPickRow.js";

// Settings → Agents, THE LANES (binding layer v11). A lane is
// harness · model · level, resolved independently. An INHERITING lane has no
// model or level of its own: one pick only, caption states what it inherits.
// Setting a harness earns the other two picks. The screen owns all writes.

/**
 * The routing lanes; each resolves independently to a (harness, model, level)
 * triple — a lane left unset inherits the default lane.
 */
export const ALL_SUBSYSTEM_ROWS: ReadonlyArray<{
  key: ModelSubsystem;
  label: string;
  hint: string;
}> = [
  { key: "assistant", label: "Assistant", hint: "The global Ask" },
  { key: "ask", label: "In-app Ask", hint: "Asking inside an app" },
  { key: "builder", label: "Builder", hint: "The app-building agent" },
  {
    key: "automations",
    label: "Automations",
    hint: "Background work and enrichers",
  },
];

/** The lanes that get a row. Builder withheld: its entry points are hidden by
 *  default (#434) — a control for an unopenable surface configures nothing.
 *  It stays in ALL_SUBSYSTEM_ROWS so a stored builder pin keeps resolving and
 *  the inventory's "used by" reading still sees it. */
export const ROUTING_ROWS = ALL_SUBSYSTEM_ROWS.filter(
  (row) => row.key !== "builder"
);

/** What a lane inherits, in one clause: agent, model, level — for an
 *  inheriting lane this caption is the ONLY place the level is stated. */
export function inheritedClause(
  card: HarnessCardDTO | undefined,
  model: string,
  effort: string
): string {
  return `${card?.title ?? "the default agent"} · ${modelLabel(
    card,
    model
  )} · ${effortLabel(card, effort).toLowerCase()}`;
}

/** One lane. `harness === ''` inherits the default lane; the caption names
 *  what that resolves to — "Use default model" alone says nothing real. */
export default function RouteRow({
  label,
  hint,
  cards,
  harness,
  model,
  effort,
  resolvedCard,
  resolvedHarnessDefault,
  resolvedHarnessDefaultEffort,
  defaultCard,
  ladder,
  onSetHarness,
  onSetModel,
  onSetEffort,
  onSetLadder,
  unattended,
  first,
}: {
  label: string;
  hint: string;
  cards: HarnessCardDTO[];
  harness: HarnessKind | "";
  model: string;
  effort: string;
  resolvedCard: HarnessCardDTO | undefined;
  /** The resolved harness's own default model id — what this lane inherits. */
  resolvedHarnessDefault: string;
  resolvedHarnessDefaultEffort: string;
  defaultCard: HarnessCardDTO | undefined;
  ladder: HarnessKind[];
  onSetHarness: (v: string) => void;
  onSetModel: (v: string) => void;
  onSetEffort: (v: string) => void;
  onSetLadder: (v: HarnessKind[]) => void;
  unattended: boolean;
  first?: boolean;
}): JSX.Element {
  const [ladderOpen, setLadderOpen] = useState(false);
  const inheriting = !harness;
  const caption = inheriting
    ? `${hint} · inherits ${inheritedClause(
        defaultCard,
        resolvedHarnessDefault,
        resolvedHarnessDefaultEffort
      )}`
    : hint;
  const harnessPick = (
    <Select
      value={harness}
      onChange={onSetHarness}
      inherited={inheriting}
      ariaLabel={`Agent for ${label}`}
    >
      <option value="">Inherit the default</option>
      {harness && !cards.some((card) => card.kind === harness) ? (
        <option value={harness}>{harness} · existing hidden pin</option>
      ) : null}
      {cards.map((c) => (
        <option key={c.kind} value={c.kind} disabled={!c.connected}>
          {c.connected ? c.title : `${c.title} · unavailable`}
        </option>
      ))}
    </Select>
  );
  return (
    <PickRow
      label={label}
      caption={caption}
      first={first}
      {...(unattended
        ? {
            action: {
              label: ladderOpen ? "Hide" : "Fallback",
              onClick: () => setLadderOpen((open) => !open),
              hint: `Failover order for ${label}`,
            },
          }
        : {})}
      {...(unattended && ladderOpen
        ? {
            detail: (
              <HarnessLadder
                label={label}
                cards={cards}
                ladder={ladder}
                resolvedCard={resolvedCard}
                onSetLadder={onSetLadder}
              />
            ),
          }
        : {})}
    >
      {harnessPick}
      {/* An inheriting lane has no model/level of its own (see file head);
          the caption already states what it resolves to. */}
      {!inheriting && resolvedCard ? (
        <>
          <ModelSelect
            card={resolvedCard}
            saved={model}
            onChange={onSetModel}
            emptyLabel={`Use default · ${modelLabel(resolvedCard, resolvedHarnessDefault)}`}
            ariaLabel={`Model for ${label}`}
          />
          <ConfigSelect
            card={resolvedCard}
            category="thought_level"
            saved={effort}
            onChange={onSetEffort}
            emptyLabel={`Use default · ${effortLabel(resolvedCard, resolvedHarnessDefaultEffort)}`}
            ariaLabel={`Effort for ${label}`}
          />
        </>
      ) : null}
    </PickRow>
  );
}
