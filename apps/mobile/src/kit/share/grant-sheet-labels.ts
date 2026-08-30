import type {
  GrantAudienceOption,
  GrantRecord,
  GrantSubject,
} from "@centraid/blueprints/apps/_shared/grant-plane";
import { subjectNoun } from "@centraid/blueprints/apps/_shared/grant-plane";

export function subjectKey(subject: GrantSubject): string {
  return `${subject.subjectType}:${subject.subjectId}`;
}

export function subjectTitle(subject: GrantSubject): string {
  return subject.label?.trim()
    ? subject.label.trim()
    : subjectNoun(subject.subjectType);
}

export function audienceLabelFor(
  grant: GrantRecord,
  audiences: readonly GrantAudienceOption[]
): string {
  const match = audiences.find(
    (option) =>
      option.kind === grant.audience.kind && option.id === grant.audience.id
  );
  if (match) return match.label;
  return grant.audience.kind === "circle" ? "a named group" : "this person";
}
