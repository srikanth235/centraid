import type { JSX } from "react";

import Icon from "../ui/Icon.js";

import au from "../styles/automation.module.css";
import emptyCss from "../styles/pageEmpty.module.css";
import skeletonCss from "../styles/pageSkeleton.module.css";

// Loading + empty/error affordances. Deliberately plain global classes
// (`cd-au-loading`, `cd-page-empty`) rather than CSS modules: this chrome is
// shared and already styled in styles.css.

export function PageLoading({ label }: { label: string }): JSX.Element {
  return <div className={au.auLoading}>{label}</div>;
}

/**
 * First-load placeholder shaped like the list it precedes (#659). A
 * centred "Loading…" reads as an empty app; a skeleton reads as an app that is
 * about to have content, and it holds the layout so nothing jumps when the rows
 * arrive. The label stays as the accessible name — the shimmer says nothing to
 * a screen reader.
 */
export function PageSkeleton({
  rows,
  label,
}: {
  rows: number;
  label: string;
}): JSX.Element {
  return (
    <output className={skeletonCss.pageSkeleton} aria-label={label}>
      {Array.from({ length: rows }, (_unused, index) => (
        <div
          key={index}
          className={skeletonCss.pageSkeletonRow}
          aria-hidden="true"
        />
      ))}
    </output>
  );
}

export function PageEmpty({ message }: { message: string }): JSX.Element {
  return (
    <div className={emptyCss.pageEmpty}>
      <div className={emptyCss.pageEmptyIcon}>
        <Icon name="Sparkle" size={22} />
      </div>
      <div className={emptyCss.pageEmptyText}>{message}</div>
    </div>
  );
}
