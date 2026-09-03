import type { JSX } from "react";

import Icon from "../ui/Icon.js";

import au from "../styles/automation.module.css";
import emptyCss from "../styles/pageEmpty.module.css";
import skeletonCss from "../styles/pageSkeleton.module.css";

export function PageLoading({ label }: { label: string }): JSX.Element {
  return <div className={au.auLoading}>{label}</div>;
}

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
