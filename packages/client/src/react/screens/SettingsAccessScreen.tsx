import type { JSX } from "react";

import type {
  AccessAnswer,
  AccessGroup,
  AccessLens,
  AccessRequest,
} from "../shell/routes/settingsAccessData.js";
import { useAsyncData } from "../shell/useAsyncData.js";
import NoteBlock from "../ui/NoteBlock.js";
import { DrawerGroup } from "./settings-controls.js";

import sc from "./settings-controls.module.css";

/**
 * Settings → Access: the ONE dashboard over the authority plane (#883, ruling
 * V-dashboard), grouped by who the answer is about — the axis the promise a
 * withdrawal can keep varies on (ruling V-locus). It words no phrase of its
 * own; every promise is the vault's, taken from the wire. It never draws an
 * empty table over a failed read: "nobody has access" and "we could not ask"
 * are opposite facts.
 */

export interface SettingsAccessScreenProps {
  load: () => Promise<AccessLens>;
}

/** Never invents a subject name: the id is what this plane stores. */
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

function day(iso: string): string {
  if (iso === "") return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

/**
 * NEVER USED IS A FACT, NOT A BLANK (#928). An answer nothing has exercised is
 * the one the member most wants to find, so it says so in words rather than
 * leaving the column empty — which would read as "we did not check".
 */
function lastUsed(answer: AccessAnswer): string {
  if (answer.lastUsedAt === null) return "never used";
  const at = day(answer.lastUsedAt);
  return at === "" ? "never used" : `last used ${at}`;
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
              day(answer.grantedAt) && `since ${day(answer.grantedAt)}`,
              lastUsed(answer),
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

/** A question the member has not answered, drawn beside what they did answer. */
function AccessAsks({ requests }: { requests: AccessRequest[] }): JSX.Element {
  return (
    <ul className={sc.rowFull} data-testid="access-requests">
      {requests.map((request) => (
        <li key={request.requestId}>
          <span className={sc.rowLabel}>
            {`${request.principalId} is asking for ${
              request.scopes.length === 0 ? "access" : request.scopes.join(", ")
            }`}
          </span>
          <span className={sc.rowHint}>
            {day(request.requestedAt) && `asked ${day(request.requestedAt)}`}
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
      {lens.requests.length > 0 ? (
        <DrawerGroup label="Waiting on you" meta={`${lens.requests.length}`}>
          <AccessAsks requests={lens.requests} />
        </DrawerGroup>
      ) : null}
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
