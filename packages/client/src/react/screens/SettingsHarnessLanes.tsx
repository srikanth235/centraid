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

// Settings → Agents, THE LANES (binding layer v11).
//
// A lane is harness · model · level, resolved independently. AN INHERITING LANE
// HAS NO MODEL OR LEVEL OF ITS OWN, so it offers no control for one: it shows a
// single pick, and its caption states what it currently inherits, down to the
// level. Setting a harness is what earns the other two picks. The previous
// shape offered all three always, with "Use default · Sonnet 4.5" inside each
// menu — three controls where two of them wrote nothing until the first
// changed, and the resolved answer readable only by opening a menu.
//
// The screen still owns every write and every rollback: this file renders picks
// and calls back.

/**
 * The routing lanes. Each resolves independently to a (harness, model, level)
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

/**
 * The lanes that get a row. Builder is withheld: every builder entry point is
 * hidden by default (#434), so a routing control for a surface the member
 * cannot open is configuration for nothing.
 *
 * It stays in `ALL_SUBSYSTEM_ROWS` on purpose, because that list also feeds the
 * inventory's "used by" reading. A stored builder pin keeps resolving, and
 * hiding the row must not also hide the fact that a harness is carrying that
 * lane.
 */
export const ROUTING_ROWS = ALL_SUBSYSTEM_ROWS.filter(
  (row) => row.key !== "builder"
);

/**
 * What a lane inherits, in one clause: agent, model, level.
 *
 * THE LEVEL IS PART OF THE SENTENCE, NOT AN EXTRA. A lane with no harness of
 * its own renders one pick, so this caption is the ONLY place the level it will
 * think at is stated — dropping it would leave the section head promising
 * "harness · model · level" over rows that name two of the three. It reads
 * lowercase because it is prose here, not the pick's own label.
 */
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

/**
 * One lane. `harness === ''` means inherit the default lane, and the caption
 * names what that resolves to — "Use default model" alone told you nothing
 * about what would actually run, and with agents inheriting too that ambiguity
 * would have doubled.
 */
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
      {/* A lane that inherits has no model or level of its own — see the head
          of this file. The caption above already states what it resolves to. */}
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
