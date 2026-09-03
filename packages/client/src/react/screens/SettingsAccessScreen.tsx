import type { JSX } from "react";

import type {
  AccessAnswer,
  AccessGroup,
  AccessLens,
} from "../shell/routes/settingsAccessData.js";
import { useAsyncData } from "../shell/useAsyncData.js";
import NoteBlock from "../ui/NoteBlock.js";
import { DrawerGroup } from "./settings-controls.js";

import sc from "./settings-controls.module.css";

export interface SettingsAccessScreenProps {
  load: () => Promise<AccessLens>;
}

function answerLine(answer: AccessAnswer): string {
  const verb =
    answer.decision === "declined"
      ? `may not ${answer.verb}`
      : `may ${answer.verb}`;
  const subject =
    answer.subjectId === ""
      ? answer.subjectType
      : `${answer.subjectType} ${answer.subjectId}`;
  return `${answer.principalId} ${verb} ${subject}`;
}

function since(answer: AccessAnswer): string {
  if (answer.grantedAt === "") return "";
  const at = new Date(answer.grantedAt);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function AccessRows({ group }: { group: AccessGroup }): JSX.Element {
  if (group.answers.length === 0) {
    return (
      <p className={sc.rowHint} data-testid={`access-empty-${group.id}`}>
        No standing answers here.
      </p>
    );
  }
  return (
    <ul className={sc.rowFull} data-testid={`access-rows-${group.id}`}>
      {group.answers.map((answer) => (
        <li key={answer.authorityId}>
          <span className={sc.rowLabel}>{answerLine(answer)}</span>
          <span className={sc.rowHint}>
            {[
              since(answer) && `since ${since(answer)}`,
              answer.duration === "until-date" && answer.expiresAt
                ? `until ${answer.expiresAt}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function SettingsAccessScreen({
  load,
}: SettingsAccessScreenProps): JSX.Element {
  const state = useAsyncData(load, [load]);

  if (state.status === "loading")
    return <p className={sc.rowHint}>Reading your answers…</p>;
  const lens: AccessLens =
    state.status === "error"
      ? { status: "unreadable", reason: state.error }
      : state.data;
  if (lens.status === "unreadable") {
    return (
      <NoteBlock>
        <span data-testid="access-unreadable">
          {`Access could not be read, so nothing here is a statement about what you have granted: ${lens.reason}`}
        </span>
      </NoteBlock>
    );
  }

  return (
    <>
      {lens.groups.map((group) => (
        <DrawerGroup
          key={group.id}
          label={group.title}
          meta={`${group.answers.length}`}
        >
          <AccessRows group={group} />
          {/* Verbatim from the vault; absent when the wire did not say. */}
          {lens.loci[group.locus] ? (
            <p className={sc.rowHint} data-testid={`access-locus-${group.id}`}>
              {`Withdrawing: ${lens.loci[group.locus]!}`}
            </p>
          ) : null}
        </DrawerGroup>
      ))}
    </>
  );
}
